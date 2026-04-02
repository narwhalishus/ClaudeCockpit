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
import { startChat, abortChat, getProcess, generateTitle } from "./services/claude-cli.ts";
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

// ─── HTTP handler (kept for backward compat + health checks) ───────────────

function json(res: ServerResponse, data: unknown, status = 200) {
  res.writeHead(status, {
    "Content-Type": "application/json",
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "GET, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type",
  });
  res.end(JSON.stringify(data));
}

function notFound(res: ServerResponse) {
  json(res, { error: "Not found" }, 404);
}

async function handleHttp(req: IncomingMessage, res: ServerResponse) {
  if (req.method === "OPTIONS") {
    res.writeHead(204, {
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Methods": "GET, OPTIONS",
      "Access-Control-Allow-Headers": "Content-Type",
    });
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

export async function handleWsRequest(ws: WebSocket, req: RequestFrame) {
  const { id, method, params } = req;
  const p = (params ?? {}) as Record<string, unknown>;

  try {
    switch (method) {
      case "overview.get": {
        const projectId = p.project as string | undefined;
        const stats = await getOverviewStats(projectId);
        send(ws, okResponse(id, { ...stats, gatewayStartedAt: STARTED_AT }));
        break;
      }

      case "sessions.list": {
        const projectId = p.project as string | undefined;
        const sessions = await listSessions(projectId);
        send(ws, okResponse(id, { sessions, count: sessions.length }));
        break;
      }

      case "projects.list": {
        const projects = await listProjects();
        send(ws, okResponse(id, { projects, count: projects.length }));
        break;
      }

      case "sessions.messages": {
        const sessionId = p.sessionId as string;
        const projectId = p.projectId as string | undefined;
        const limit = (p.limit as number) ?? 50;
        const beforeIndex = p.beforeIndex as number | undefined;
        if (typeof sessionId !== "string" || !sessionId) {
          send(ws, errResponse(id, "INVALID_PARAMS", "sessionId is required"));
          break;
        }
        const result = await getSessionMessages(
          sessionId,
          projectId,
          limit,
          beforeIndex
        );
        if (!result) {
          send(ws, errResponse(id, "NOT_FOUND", "Session not found"));
          break;
        }
        send(ws, okResponse(id, result));
        break;
      }

      case "chat.send": {
        const prompt = p.prompt as string;
        const chatId = p.chatId as string ?? id;
        const model = p.model as string | undefined;
        const sessionId = p.sessionId as string | undefined;
        const cwd = p.cwd as string | undefined;
        const isNewSession = !sessionId;

        if (typeof prompt !== "string" || !prompt) {
          send(ws, errResponse(id, "INVALID_PARAMS", "prompt is required"));
          break;
        }

        const proc = startChat(chatId, {
          prompt,
          model,
          sessionId,
          cwd,
          interactive: true,
        });

        trackChat(ws, chatId);

        // Track new session ID from result for title generation
        let newSessionId: string | null = null;

        // Stream chunks as events
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
          send(
            ws,
            event("chat.error", {
              chatId,
              message: err.message,
            })
          );
        });

        proc.on("close", (code) => {
          send(ws, event("chat.close", { chatId, exitCode: code }));
          send(ws, okResponse(id, { chatId, status: "completed" }));

          // Auto-generate title for new sessions
          if (isNewSession && newSessionId) {
            const sid = newSessionId;
            generateTitle(prompt).then(async (title) => {
              if (title) {
                await renameSession(sid, title);
                send(ws, event("session.titled", { sessionId: sid, title }));
              }
            }).catch((err) => console.error("Title generation failed:", err));
          }
        });

        proc.on("tool.approval", (data) => {
          send(ws, event("tool.approval", { chatId, ...(data as Record<string, unknown>) }));
        });

        // Acknowledge immediately that the chat started
        send(ws, event("chat.started", { chatId }));
        break;
      }

      case "chat.abort": {
        const chatId = p.chatId as string;
        if (typeof chatId !== "string" || !chatId) {
          send(ws, errResponse(id, "INVALID_PARAMS", "chatId is required"));
          break;
        }
        const aborted = abortChat(chatId);
        send(ws, okResponse(id, { chatId, aborted }));
        break;
      }

      case "tool.respond": {
        const chatId = p.chatId as string;
        const requestId = p.requestId as string;
        const behavior = p.behavior as "allow" | "deny";
        const message = p.message as string | undefined;

        if (typeof chatId !== "string" || typeof requestId !== "string" || !behavior) {
          send(ws, errResponse(id, "INVALID_PARAMS", "chatId, requestId, and behavior are required"));
          break;
        }

        const proc = getProcess(chatId);
        if (!proc) {
          send(ws, errResponse(id, "NOT_FOUND", "No active process for chatId"));
          break;
        }

        const written = proc.writeControlResponse(requestId, behavior, message);
        send(ws, okResponse(id, { chatId, requestId, written }));
        break;
      }

      case "sessions.summarize": {
        const sessionId = p.sessionId as string;
        const projectId = p.projectId as string | undefined;
        if (typeof sessionId !== "string" || !sessionId) {
          send(ws, errResponse(id, "INVALID_PARAMS", "sessionId is required"));
          break;
        }

        const transcript = await getSessionTranscript(sessionId, projectId);
        if (!transcript) {
          send(ws, errResponse(id, "NOT_FOUND", "Session not found or empty"));
          break;
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

        break;
      }

      case "sessions.rename": {
        const sessionId = p.sessionId as string;
        const rawTitle = (p.title as string ?? "").trim().slice(0, TITLE_MAX_LENGTH);
        if (typeof sessionId !== "string" || !sessionId || !rawTitle) {
          send(ws, errResponse(id, "INVALID_PARAMS", "sessionId and non-empty title are required"));
          break;
        }
        const renamed = await renameSession(sessionId, rawTitle, p.projectId as string | undefined);
        send(ws, okResponse(id, { sessionId, title: rawTitle, renamed }));
        break;
      }

      default:
        send(ws, errResponse(id, "UNKNOWN_METHOD", `Unknown method: ${method}`));
    }
  } catch (err) {
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
