import {
  createServer,
  type IncomingMessage,
  type ServerResponse,
} from "node:http";
import { WebSocketServer, type WebSocket } from "ws";
import {
  getOverviewStats,
  listSessions,
  listProjects,
  getSessionMessages,
  getSessionTranscript,
  renameSession,
} from "./services/session-store.ts";
import { startChat, abortChat, getProcess, generateTitle, type ClaudeProcess } from "./services/claude-cli.ts";
import { SUMMARY_MAX_BUDGET, TITLE_MAX_LENGTH } from "./constants.ts";
import {
  parseFrame,
  serializeFrame,
  okResponse,
  errResponse,
  event,
  type RequestFrame,
  type GatewayFrame,
} from "./protocol/frames.ts";

const PORT = 18800;
const STARTED_AT = new Date().toISOString();

const CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type",
} as const;

// ─── HTTP handler (kept for backward compat + health checks) ───────────────

function json(res: ServerResponse, data: unknown, status = 200) {
  res.writeHead(status, {
    "Content-Type": "application/json",
    ...CORS_HEADERS,
  });
  res.end(JSON.stringify(data));
}

function notFound(res: ServerResponse) {
  json(res, { error: "Not found" }, 404);
}

async function handleHttp(req: IncomingMessage, res: ServerResponse) {
  if (req.method === "OPTIONS") {
    res.writeHead(204, CORS_HEADERS);
    res.end();
    return;
  }

  const url = new URL(req.url ?? "/", `http://localhost:${PORT}`);
  const path = url.pathname;

  try {
    if (path === "/api/overview") {
      const projectId = url.searchParams.get("project") ?? undefined;
      const stats = await getOverviewStats(projectId);
      json(res, { ...stats, gatewayStartedAt: STARTED_AT });
    } else if (path === "/api/sessions") {
      const projectId = url.searchParams.get("project") ?? undefined;
      const sessions = await listSessions(projectId);
      json(res, { sessions, count: sessions.length });
    } else if (path === "/api/projects") {
      const projects = await listProjects();
      json(res, { projects, count: projects.length });
    } else if (path === "/api/health") {
      json(res, {
        status: "ok",
        timestamp: new Date().toISOString(),
        startedAt: STARTED_AT,
        wsClients: wss?.clients.size ?? 0,
      });
    } else {
      notFound(res);
    }
  } catch (err) {
    console.error("Request error:", err);
    json(res, { error: "Internal server error" }, 500);
  }
}

// ─── WebSocket handler ─────────────────────────────────────────────────────

let wss: WebSocketServer | null = null;

/** Track which chatIds are associated with each WebSocket (for auto-deny on disconnect) */
const wsChats = new Map<WebSocket, Set<string>>();

function trackChat(ws: WebSocket, chatId: string) {
  if (!wsChats.has(ws)) wsChats.set(ws, new Set());
  wsChats.get(ws)!.add(chatId);
}

function send(ws: WebSocket, frame: GatewayFrame) {
  if (ws.readyState === ws.OPEN) {
    ws.send(serializeFrame(frame));
  }
}

// ─── Param helpers ────────────────────────────────────────────────────────

type Params = Record<string, unknown>;

function getString(p: Params, key: string): string | undefined {
  const v = p[key];
  return typeof v === "string" ? v : undefined;
}

function getNumber(p: Params, key: string): number | undefined {
  const v = p[key];
  return typeof v === "number" ? v : undefined;
}

function requireString(p: Params, key: string): string | null {
  const v = getString(p, key);
  return v && v.length > 0 ? v : null;
}

// ─── Individual WS method handlers ────────────────────────────────────────

type WsContext = { ws: WebSocket; id: string; p: Params };

async function handleOverviewGet({ ws, id, p }: WsContext) {
  const projectId = getString(p, "project");
  const stats = await getOverviewStats(projectId);
  send(ws, okResponse(id, { ...stats, gatewayStartedAt: STARTED_AT }));
}

async function handleSessionsList({ ws, id, p }: WsContext) {
  const projectId = getString(p, "project");
  const sessions = await listSessions(projectId);
  send(ws, okResponse(id, { sessions, count: sessions.length }));
}

async function handleProjectsList({ ws, id }: WsContext) {
  const projects = await listProjects();
  send(ws, okResponse(id, { projects, count: projects.length }));
}

async function handleSessionsMessages({ ws, id, p }: WsContext) {
  const sessionId = requireString(p, "sessionId");
  if (!sessionId) {
    send(ws, errResponse(id, "INVALID_PARAMS", "sessionId is required"));
    return;
  }
  const projectId = getString(p, "projectId");
  const limit = getNumber(p, "limit") ?? 50;
  const beforeIndex = getNumber(p, "beforeIndex");
  const result = await getSessionMessages(sessionId, projectId, limit, beforeIndex);
  if (!result) {
    send(ws, errResponse(id, "NOT_FOUND", "Session not found"));
    return;
  }
  send(ws, okResponse(id, result));
}

function maybeGenerateTitle(ws: WebSocket, sessionId: string, prompt: string) {
  generateTitle(prompt).then(async (title) => {
    if (title) {
      await renameSession(sessionId, title);
      send(ws, event("session.titled", { sessionId, title }));
    }
  }).catch((err) => console.error("Title generation failed:", err));
}

function wireChatEvents(
  proc: ClaudeProcess,
  ws: WebSocket,
  chatId: string,
  id: string,
  isNewSession: boolean,
  prompt: string
) {
  let newSessionId: string | null = null;

  proc.on("chunk", (chunk) => {
    send(ws, event("chat.chunk", { chatId, ...chunk }));
  });

  proc.on("result", (result) => {
    const data = result as Record<string, unknown>;
    if (isNewSession && data.session_id) {
      newSessionId = data.session_id as string;
    }
    send(ws, event("chat.result", { chatId, result }));
  });

  proc.on("error", (err) => {
    send(ws, event("chat.error", { chatId, message: err.message }));
  });

  proc.on("close", (code) => {
    wsChats.get(ws)?.delete(chatId);
    send(ws, event("chat.close", { chatId, exitCode: code }));
    send(ws, okResponse(id, { chatId, status: "completed" }));

    if (isNewSession && newSessionId) {
      maybeGenerateTitle(ws, newSessionId, prompt);
    }
  });

  proc.on("tool.approval", (data) => {
    send(ws, event("tool.approval", { chatId, ...(data as Record<string, unknown>) }));
  });
}

async function handleChatSend({ ws, id, p }: WsContext) {
  const prompt = requireString(p, "prompt");
  if (!prompt) {
    send(ws, errResponse(id, "INVALID_PARAMS", "prompt is required"));
    return;
  }

  const chatId = getString(p, "chatId") ?? id;
  const sessionId = getString(p, "sessionId");
  const proc = startChat(chatId, {
    prompt,
    model: getString(p, "model"),
    sessionId,
    cwd: getString(p, "cwd"),
    interactive: true,
  });

  trackChat(ws, chatId);
  wireChatEvents(proc, ws, chatId, id, !sessionId, prompt);
  send(ws, event("chat.started", { chatId }));
}

async function handleChatAbort({ ws, id, p }: WsContext) {
  const chatId = requireString(p, "chatId");
  if (!chatId) {
    send(ws, errResponse(id, "INVALID_PARAMS", "chatId is required"));
    return;
  }
  const aborted = abortChat(chatId);
  send(ws, okResponse(id, { chatId, aborted }));
}

async function handleToolRespond({ ws, id, p }: WsContext) {
  const chatId = requireString(p, "chatId");
  const requestId = requireString(p, "requestId");
  const behavior = getString(p, "behavior");

  if (!chatId || !requestId || !behavior) {
    send(ws, errResponse(id, "INVALID_PARAMS", "chatId, requestId, and behavior are required"));
    return;
  }

  if (behavior !== "allow" && behavior !== "deny") {
    send(ws, errResponse(id, "INVALID_PARAMS", "behavior must be 'allow' or 'deny'"));
    return;
  }

  const proc = getProcess(chatId);
  if (!proc) {
    send(ws, errResponse(id, "NOT_FOUND", "No active process for chatId"));
    return;
  }

  const message = getString(p, "message");
  const written = proc.writeControlResponse(requestId, behavior, message);
  send(ws, okResponse(id, { chatId, requestId, written }));
}

async function handleSessionsSummarize({ ws, id, p }: WsContext) {
  const sessionId = requireString(p, "sessionId");
  if (!sessionId) {
    send(ws, errResponse(id, "INVALID_PARAMS", "sessionId is required"));
    return;
  }

  const projectId = getString(p, "projectId");
  const transcript = await getSessionTranscript(sessionId, projectId);
  if (!transcript) {
    send(ws, errResponse(id, "NOT_FOUND", "Session not found or empty"));
    return;
  }

  const summaryPrompt = `Summarize this Claude Code session for a developer catching up. Be concise and specific.\n\nFormat:\n- **What:** What was being worked on\n- **Changes:** Key changes, decisions, and actions taken\n- **Status:** Current state and any unfinished items\n\nUse file names and technical details. Keep it under 150 words.\n\nTranscript:\n---\n${transcript}\n---`;
  const summaryId = `summary-${sessionId}-${Date.now()}`;

  const proc = startChat(summaryId, {
    prompt: summaryPrompt,
    noSession: true,
    maxBudget: SUMMARY_MAX_BUDGET,
  });

  proc.on("chunk", (chunk) => {
    const c = chunk as { type: string; content?: string };
    if (c.type === "text" && c.content) {
      send(ws, event("summary.chunk", { sessionId, content: c.content }));
    }
  });

  proc.on("error", (err) => {
    send(ws, event("summary.error", { sessionId, message: (err as Error).message }));
  });

  proc.on("close", () => {
    send(ws, event("summary.done", { sessionId }));
    send(ws, okResponse(id, { sessionId, status: "completed" }));
  });
}

async function handleSessionsRename({ ws, id, p }: WsContext) {
  const sessionId = requireString(p, "sessionId");
  const rawTitle = (getString(p, "title") ?? "").trim().slice(0, TITLE_MAX_LENGTH);
  if (!sessionId || !rawTitle) {
    send(ws, errResponse(id, "INVALID_PARAMS", "sessionId and non-empty title are required"));
    return;
  }
  const projectId = getString(p, "projectId");
  const renamed = await renameSession(sessionId, rawTitle, projectId);
  send(ws, okResponse(id, { sessionId, title: rawTitle, renamed }));
}

// ─── Dispatch table ───────────────────────────────────────────────────────

const wsHandlers: Record<string, (ctx: WsContext) => Promise<void>> = {
  "overview.get":       handleOverviewGet,
  "sessions.list":      handleSessionsList,
  "projects.list":      handleProjectsList,
  "sessions.messages":  handleSessionsMessages,
  "sessions.rename":    handleSessionsRename,
  "sessions.summarize": handleSessionsSummarize,
  "chat.send":          handleChatSend,
  "chat.abort":         handleChatAbort,
  "tool.respond":       handleToolRespond,
};

export async function handleWsRequest(ws: WebSocket, req: RequestFrame) {
  const { id, method, params } = req;
  const p = (params ?? {}) as Params;
  const ctx: WsContext = { ws, id, p };

  try {
    const handler = wsHandlers[method];
    if (handler) {
      await handler(ctx);
    } else {
      send(ws, errResponse(id, "UNKNOWN_METHOD", `Unknown method: ${method}`));
    }
  } catch (err) {
    console.error("WS handler error:", method, err);
    const msg = err instanceof Error ? err.message : "Internal error";
    send(ws, errResponse(id, "INTERNAL_ERROR", msg));
  }
}

function handleWsConnection(ws: WebSocket) {
  console.log("WebSocket client connected");

  ws.on("message", (raw) => {
    const frame = parseFrame(raw.toString());
    if (!frame) return;

    if (frame.type === "req") {
      handleWsRequest(ws, frame);
    }
  });

  ws.on("close", () => {
    console.log("WebSocket client disconnected");
    const chatIds = wsChats.get(ws);
    if (chatIds) {
      for (const chatId of chatIds) {
        try {
          // Auto-deny pending tool approvals so claude -p doesn't hang indefinitely
          const proc = getProcess(chatId);
          if (proc?.pendingApproval) {
            proc.writeControlResponse(
              proc.pendingApproval.requestId,
              "deny",
              "WebSocket client disconnected"
            );
          }
          // Abort running processes — no UI to control them anymore
          abortChat(chatId);
        } catch (err) {
          console.error(`Disconnect cleanup failed for chat ${chatId}:`, err);
        }
      }
      wsChats.delete(ws);
    }
  });
}

// ─── Start server ──────────────────────────────────────────────────────────

const server = createServer(handleHttp);

wss = new WebSocketServer({ server, path: "/ws" });
wss.on("connection", handleWsConnection);

server.listen(PORT, () => {
  console.log(`ClaudeCockpit gateway listening on :${PORT}`);
  console.log(`  HTTP  /api/overview, /api/sessions, /api/projects, /api/health`);
  console.log(`  WS    ws://localhost:${PORT}/ws`);
  console.log(`  Methods: overview.get, sessions.list, projects.list, chat.send, chat.abort`);
});
