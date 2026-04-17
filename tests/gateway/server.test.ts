/**
 * Unit tests for server.ts WebSocket request handler.
 *
 * Mocks session-store and claude-cli services; verifies that each WS method
 * dispatches to the right service call and sends the expected frame shape.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

// vi.hoisted runs before vi.mock hoisting, so the mock fn is available in factories
const { mockWriteControlResponse } = vi.hoisted(() => ({
  mockWriteControlResponse: vi.fn().mockReturnValue(true),
}));

// ── Mock session-store ────────────────────────────────────────────────────
vi.mock("../../gateway/services/session-store.ts", () => ({
  getOverviewStats: vi.fn().mockResolvedValue({ totalSessions: 5 }),
  listSessions: vi.fn().mockResolvedValue([{ sessionId: "s1" }]),
  listProjects: vi.fn().mockResolvedValue([{ id: "p1" }]),
  getSessionMessages: vi.fn().mockResolvedValue({
    sessionId: "s1",
    projectId: "p1",
    messages: [],
    total: 0,
    hasMore: false,
  }),
  getSessionTranscript: vi.fn().mockResolvedValue("transcript text"),
  renameSession: vi.fn().mockResolvedValue(true),
  cleanErrorTitles: vi.fn().mockResolvedValue(0),
}));

// ── Mock claude-cli ───────────────────────────────────────────────────────
vi.mock("../../gateway/services/claude-cli.ts", () => ({
  startChat: vi.fn(),
  abortChat: vi.fn().mockReturnValue(true),
  getProcess: vi.fn().mockReturnValue({
    writeControlResponse: mockWriteControlResponse,
    pendingApproval: null,
  }),
  generateTitle: vi.fn().mockResolvedValue("Generated Title"),
}));

import { EventEmitter } from "node:events";
import { handleWsRequest, handleHttp } from "../../gateway/server.ts";
import { getOverviewStats, listSessions, listProjects, getSessionMessages, getSessionTranscript, renameSession } from "../../gateway/services/session-store.ts";
import { startChat, abortChat, getProcess, generateTitle } from "../../gateway/services/claude-cli.ts";
import type { RequestFrame } from "../../gateway/protocol/frames.ts";

// ── Mock WebSocket ────────────────────────────────────────────────────────

function mockWs() {
  const sent: string[] = [];
  return {
    OPEN: 1,
    readyState: 1,
    send: vi.fn((data: string) => sent.push(data)),
    _sent: sent,
    /** Parse the last sent frame */
    lastFrame() {
      return JSON.parse(sent[sent.length - 1]);
    },
  };
}

function req(method: string, params?: Record<string, unknown>): RequestFrame {
  return { type: "req", id: `test-${method}`, method, params };
}

// ── Tests ─────────────────────────────────────────────────────────────────

describe("handleWsRequest", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("overview.get → calls getOverviewStats and returns okResponse", async () => {
    const ws = mockWs();
    await handleWsRequest(ws as never, req("overview.get", { project: "proj1" }));

    expect(getOverviewStats).toHaveBeenCalledWith("proj1");
    const frame = ws.lastFrame();
    expect(frame.type).toBe("res");
    expect(frame.id).toBe("test-overview.get");
    expect(frame.result).toMatchObject({ totalSessions: 5 });
    expect(frame.result.gatewayStartedAt).toBeDefined();
  });

  it("sessions.list → calls listSessions and returns okResponse", async () => {
    const ws = mockWs();
    await handleWsRequest(ws as never, req("sessions.list", { project: "proj1" }));

    expect(listSessions).toHaveBeenCalledWith("proj1");
    const frame = ws.lastFrame();
    expect(frame.result).toEqual({ sessions: [{ sessionId: "s1" }], count: 1 });
  });

  it("projects.list → calls listProjects and returns okResponse", async () => {
    const ws = mockWs();
    await handleWsRequest(ws as never, req("projects.list"));

    expect(listProjects).toHaveBeenCalled();
    const frame = ws.lastFrame();
    expect(frame.result).toEqual({ projects: [{ id: "p1" }], count: 1 });
  });

  it("sessions.messages (valid) → returns messages", async () => {
    const ws = mockWs();
    await handleWsRequest(ws as never, req("sessions.messages", { sessionId: "s1" }));

    expect(getSessionMessages).toHaveBeenCalledWith("s1", undefined, 50, undefined);
    const frame = ws.lastFrame();
    expect(frame.result.sessionId).toBe("s1");
  });

  it("sessions.messages (missing sessionId) → errResponse INVALID_PARAMS", async () => {
    const ws = mockWs();
    await handleWsRequest(ws as never, req("sessions.messages", {}));

    const frame = ws.lastFrame();
    expect(frame.error).toBeDefined();
    expect(frame.error.code).toBe("INVALID_PARAMS");
  });

  it("sessions.messages (not found) → errResponse NOT_FOUND", async () => {
    vi.mocked(getSessionMessages).mockResolvedValueOnce(null);
    const ws = mockWs();
    await handleWsRequest(ws as never, req("sessions.messages", { sessionId: "missing" }));

    const frame = ws.lastFrame();
    expect(frame.error).toBeDefined();
    expect(frame.error.code).toBe("NOT_FOUND");
  });

  it("chat.abort → calls abortChat and returns status", async () => {
    const ws = mockWs();
    await handleWsRequest(ws as never, req("chat.abort", { chatId: "c1" }));

    expect(abortChat).toHaveBeenCalledWith("c1");
    const frame = ws.lastFrame();
    expect(frame.result).toEqual({ chatId: "c1", aborted: true });
  });

  it("tool.respond → calls writeControlResponse", async () => {
    const ws = mockWs();
    await handleWsRequest(ws as never, req("tool.respond", {
      chatId: "c1",
      requestId: "req-1",
      behavior: "allow",
    }));

    expect(getProcess).toHaveBeenCalledWith("c1");
    expect(mockWriteControlResponse).toHaveBeenCalledWith("req-1", "allow", undefined);
    const frame = ws.lastFrame();
    expect(frame.result.written).toBe(true);
  });

  it("tool.respond (missing params) → errResponse INVALID_PARAMS", async () => {
    const ws = mockWs();
    await handleWsRequest(ws as never, req("tool.respond", { chatId: "c1" }));

    const frame = ws.lastFrame();
    expect(frame.error.code).toBe("INVALID_PARAMS");
  });

  it("sessions.rename → calls renameSession", async () => {
    const ws = mockWs();
    await handleWsRequest(ws as never, req("sessions.rename", {
      sessionId: "s1",
      title: "New Name",
    }));

    expect(renameSession).toHaveBeenCalledWith("s1", "New Name", undefined);
    const frame = ws.lastFrame();
    expect(frame.result.renamed).toBe(true);
    expect(frame.result.title).toBe("New Name");
  });

  it("unknown method → errResponse UNKNOWN_METHOD", async () => {
    const ws = mockWs();
    await handleWsRequest(ws as never, req("nonexistent.method"));

    const frame = ws.lastFrame();
    expect(frame.error.code).toBe("UNKNOWN_METHOD");
    expect(frame.error.message).toContain("nonexistent.method");
  });

  // ── sessions.summarize ────────────────────────────────────────────────

  it("sessions.summarize (valid) → starts summary chat", async () => {
    const mockProc = new EventEmitter();
    vi.mocked(startChat).mockReturnValueOnce(mockProc as never);

    const ws = mockWs();
    await handleWsRequest(ws as never, req("sessions.summarize", {
      sessionId: "s1",
      projectId: "p1",
    }));

    expect(getSessionTranscript).toHaveBeenCalledWith("s1", "p1");
    expect(startChat).toHaveBeenCalled();
    const args = vi.mocked(startChat).mock.calls[0];
    expect(args[0]).toMatch(/^summary-s1-/);
    expect(args[1].noSession).toBe(true);
  });

  it("sessions.summarize (missing sessionId) → errResponse INVALID_PARAMS", async () => {
    const ws = mockWs();
    await handleWsRequest(ws as never, req("sessions.summarize", {}));

    const frame = ws.lastFrame();
    expect(frame.error.code).toBe("INVALID_PARAMS");
  });

  it("sessions.summarize (no transcript) → errResponse NOT_FOUND", async () => {
    vi.mocked(getSessionTranscript).mockResolvedValueOnce(null);
    const ws = mockWs();
    await handleWsRequest(ws as never, req("sessions.summarize", { sessionId: "missing" }));

    const frame = ws.lastFrame();
    expect(frame.error.code).toBe("NOT_FOUND");
  });

  // ── chat.send ─────────────────────────────────────────────────────────

  it("chat.send (valid) → emits chat.started event", async () => {
    const mockProc = new EventEmitter();
    vi.mocked(startChat).mockReturnValueOnce(mockProc as never);

    const ws = mockWs();
    await handleWsRequest(ws as never, req("chat.send", {
      prompt: "hello",
      chatId: "c1",
    }));

    expect(startChat).toHaveBeenCalledWith("c1", expect.objectContaining({
      prompt: "hello",
      interactive: true,
    }));

    // Should have sent a chat.started event
    const frames = ws._sent.map((s: string) => JSON.parse(s));
    const started = frames.find((f: Record<string, unknown>) => f.event === "chat.started");
    expect(started).toBeDefined();
    expect(started.data).toEqual({ chatId: "c1" });
  });

  it("chat.send passes model to startChat for new session", async () => {
    const mockProc = new EventEmitter();
    vi.mocked(startChat).mockReturnValueOnce(mockProc as never);

    const ws = mockWs();
    await handleWsRequest(ws as never, req("chat.send", {
      prompt: "hello",
      chatId: "c2",
      model: "claude-sonnet-4-6",
    }));

    expect(startChat).toHaveBeenCalledWith("c2", expect.objectContaining({
      prompt: "hello",
      model: "claude-sonnet-4-6",
      interactive: true,
    }));
  });

  it("chat.send passes sessionId and model through to startChat", async () => {
    const mockProc = new EventEmitter();
    vi.mocked(startChat).mockReturnValueOnce(mockProc as never);

    const ws = mockWs();
    await handleWsRequest(ws as never, req("chat.send", {
      prompt: "continue",
      chatId: "c3",
      sessionId: "sess-456",
      model: "claude-opus-4-6",
    }));

    expect(startChat).toHaveBeenCalledWith("c3", expect.objectContaining({
      prompt: "continue",
      sessionId: "sess-456",
      model: "claude-opus-4-6",
      interactive: true,
    }));
  });

  it("chat.send (missing prompt) → errResponse INVALID_PARAMS", async () => {
    const ws = mockWs();
    await handleWsRequest(ws as never, req("chat.send", { chatId: "c1" }));

    const frame = ws.lastFrame();
    expect(frame.error.code).toBe("INVALID_PARAMS");
  });

  // ── tool.respond behavior validation ──────────────────────────────────

  it("tool.respond with invalid behavior → errResponse INVALID_PARAMS", async () => {
    const ws = mockWs();
    await handleWsRequest(ws as never, req("tool.respond", {
      chatId: "c1",
      requestId: "req-1",
      behavior: "maybe",
    }));

    const frame = ws.lastFrame();
    expect(frame.error.code).toBe("INVALID_PARAMS");
    expect(frame.error.message).toContain("behavior must be");
  });

  // ── chat lifecycle events ─────────────────────────────────────────────

  it("chat.send close event → sends chat.close and okResponse", async () => {
    const mockProc = new EventEmitter();
    vi.mocked(startChat).mockReturnValueOnce(mockProc as never);

    const ws = mockWs();
    await handleWsRequest(ws as never, req("chat.send", {
      prompt: "hello",
      chatId: "c1",
    }));

    // Simulate process close
    mockProc.emit("close", 0);

    const frames = ws._sent.map((s: string) => JSON.parse(s));
    const closeEvent = frames.find((f: Record<string, unknown>) => f.event === "chat.close");
    expect(closeEvent).toBeDefined();
    expect(closeEvent.data).toMatchObject({ chatId: "c1", exitCode: 0 });

    const response = frames.find((f: Record<string, unknown>) => f.type === "res");
    expect(response).toBeDefined();
    expect(response.result).toMatchObject({ chatId: "c1", status: "completed" });
  });

  it("chat.send chunk event → forwards as chat.chunk", async () => {
    const mockProc = new EventEmitter();
    vi.mocked(startChat).mockReturnValueOnce(mockProc as never);

    const ws = mockWs();
    await handleWsRequest(ws as never, req("chat.send", {
      prompt: "hello",
      chatId: "c1",
    }));

    mockProc.emit("chunk", { type: "text", content: "world" });

    const frames = ws._sent.map((s: string) => JSON.parse(s));
    const chunk = frames.find((f: Record<string, unknown>) => f.event === "chat.chunk");
    expect(chunk).toBeDefined();
    expect(chunk.data).toMatchObject({ chatId: "c1", type: "text", content: "world" });
  });

  it("chat.send error event → forwards as chat.error", async () => {
    const mockProc = new EventEmitter();
    vi.mocked(startChat).mockReturnValueOnce(mockProc as never);

    const ws = mockWs();
    await handleWsRequest(ws as never, req("chat.send", {
      prompt: "hello",
      chatId: "c1",
    }));

    mockProc.emit("error", new Error("something broke"));

    const frames = ws._sent.map((s: string) => JSON.parse(s));
    const errorEvent = frames.find((f: Record<string, unknown>) => f.event === "chat.error");
    expect(errorEvent).toBeDefined();
    expect(errorEvent.data).toMatchObject({ chatId: "c1", message: "something broke" });
  });

  it("chat.send tool.approval event → forwards as tool.approval", async () => {
    const mockProc = new EventEmitter();
    vi.mocked(startChat).mockReturnValueOnce(mockProc as never);

    const ws = mockWs();
    await handleWsRequest(ws as never, req("chat.send", {
      prompt: "hello",
      chatId: "c1",
    }));

    mockProc.emit("tool.approval", { request_id: "r1", request: { tool_name: "Bash" } });

    const frames = ws._sent.map((s: string) => JSON.parse(s));
    const approval = frames.find((f: Record<string, unknown>) => f.event === "tool.approval");
    expect(approval).toBeDefined();
    expect(approval.data).toMatchObject({ chatId: "c1", request_id: "r1" });
  });
});

// ── HTTP handler tests ───────────────────────────────────────────────────

function mockHttpReq(method: string, url: string) {
  return { method, url };
}

function mockHttpRes() {
  const data = { status: 200, headers: {} as Record<string, string>, body: "" };
  const res = {
    writeHead: vi.fn((status: number, headers?: Record<string, string>) => {
      data.status = status;
      if (headers) Object.assign(data.headers, headers);
    }),
    end: vi.fn((body?: string) => {
      if (body) data.body = body;
    }),
  };
  return { res, data };
}

describe("HTTP handler", () => {
  const httpHandler = () => handleHttp;

  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("GET /api/overview → returns overview stats with gateway timestamp", async () => {
    const { res, data } = mockHttpRes();
    await httpHandler()(mockHttpReq("GET", "/api/overview") as never, res as never);

    expect(getOverviewStats).toHaveBeenCalled();
    expect(data.status).toBe(200);
    const body = JSON.parse(data.body);
    expect(body.totalSessions).toBe(5);
    expect(body.gatewayStartedAt).toBeDefined();
  });

  it("GET /api/overview?project=p1 → passes project filter", async () => {
    const { res } = mockHttpRes();
    await httpHandler()(mockHttpReq("GET", "/api/overview?project=p1") as never, res as never);

    expect(getOverviewStats).toHaveBeenCalledWith("p1");
  });

  it("GET /api/sessions → returns sessions list", async () => {
    const { res, data } = mockHttpRes();
    await httpHandler()(mockHttpReq("GET", "/api/sessions") as never, res as never);

    expect(listSessions).toHaveBeenCalled();
    expect(data.status).toBe(200);
    const body = JSON.parse(data.body);
    expect(body.sessions).toBeDefined();
    expect(body.count).toBe(1);
  });

  it("GET /api/projects → returns projects list", async () => {
    const { res, data } = mockHttpRes();
    await httpHandler()(mockHttpReq("GET", "/api/projects") as never, res as never);

    expect(listProjects).toHaveBeenCalled();
    expect(data.status).toBe(200);
    const body = JSON.parse(data.body);
    expect(body.projects).toBeDefined();
    expect(body.count).toBe(1);
  });

  it("GET /api/health → returns health info", async () => {
    const { res, data } = mockHttpRes();
    await httpHandler()(mockHttpReq("GET", "/api/health") as never, res as never);

    expect(data.status).toBe(200);
    const body = JSON.parse(data.body);
    expect(body.status).toBe("ok");
    expect(body.timestamp).toBeDefined();
    expect(body.startedAt).toBeDefined();
  });

  it("OPTIONS → 204 with CORS headers", async () => {
    const { res, data } = mockHttpRes();
    await httpHandler()(mockHttpReq("OPTIONS", "/api/overview") as never, res as never);

    expect(data.status).toBe(204);
    expect(data.headers["Access-Control-Allow-Origin"]).toBe("*");
    expect(data.headers["Access-Control-Allow-Methods"]).toContain("GET");
  });

  it("unknown path → 404", async () => {
    const { res, data } = mockHttpRes();
    await httpHandler()(mockHttpReq("GET", "/api/nonexistent") as never, res as never);

    expect(data.status).toBe(404);
    const body = JSON.parse(data.body);
    expect(body.error).toBe("Not found");
  });

  it("service error → 500", async () => {
    vi.mocked(getOverviewStats).mockRejectedValueOnce(new Error("db down"));
    const { res, data } = mockHttpRes();
    await httpHandler()(mockHttpReq("GET", "/api/overview") as never, res as never);

    expect(data.status).toBe(500);
    const body = JSON.parse(data.body);
    expect(body.error).toBe("Internal server error");
  });
});

// ── startGateway with serveStatic ────────────────────────────────────────

describe("startGateway with serveStatic", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("routes /api/health to JSON and serves static files for non-API paths", async () => {
    const { mkdtempSync, writeFileSync } = await import("node:fs");
    const { tmpdir } = await import("node:os");
    const { join } = await import("node:path");
    const { startGateway } = await import("../../gateway/server.ts");

    const dir = mkdtempSync(join(tmpdir(), "cockpit-static-"));
    writeFileSync(join(dir, "index.html"), "<html>hello</html>");
    writeFileSync(join(dir, "app.css"), "body { color: red; }");

    const { port, close } = await startGateway({
      port: 0,
      serveStatic: dir,
      quiet: true,
    });

    try {
      // API route still returns JSON
      const healthRes = await fetch(`http://localhost:${port}/api/health`);
      expect(healthRes.status).toBe(200);
      const healthBody = await healthRes.json();
      expect(healthBody.status).toBe("ok");

      // Unknown /api/ path returns 404, NOT rewritten to index.html
      const apiMissRes = await fetch(`http://localhost:${port}/api/nonexistent`);
      expect(apiMissRes.status).toBe(404);
      expect(apiMissRes.headers.get("content-type")).toContain("application/json");

      // Root serves index.html
      const rootRes = await fetch(`http://localhost:${port}/`);
      expect(rootRes.status).toBe(200);
      expect(await rootRes.text()).toBe("<html>hello</html>");

      // Known asset served with proper mime
      const cssRes = await fetch(`http://localhost:${port}/app.css`);
      expect(cssRes.status).toBe(200);
      expect(cssRes.headers.get("content-type")).toContain("text/css");

      // Unknown no-extension path falls back to index.html (SPA routing)
      const spaRes = await fetch(`http://localhost:${port}/chat/s1`);
      expect(spaRes.status).toBe(200);
      expect(await spaRes.text()).toBe("<html>hello</html>");
    } finally {
      await close();
    }
  });
});

// ── Batch title generation on sessions.list ──────────────────────────────

describe("batch title generation on sessions.list", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("triggers title generation for untitled sessions", async () => {
    vi.mocked(listSessions).mockResolvedValueOnce([
      { sessionId: "s1", firstPrompt: "Hello", customTitle: undefined },
      { sessionId: "s2", firstPrompt: "World", customTitle: "Existing Title" },
    ] as never);

    const ws = mockWs();
    await handleWsRequest(ws as never, req("sessions.list", {}));

    // Give async batch time to start
    await new Promise((r) => setTimeout(r, 50));
    // Should only generate for s1 (untitled), not s2 (already has title)
    expect(vi.mocked(generateTitle)).toHaveBeenCalledWith("Hello", "haiku");
    expect(vi.mocked(generateTitle)).not.toHaveBeenCalledWith("World", expect.anything());
  });

  it("skips sessions without firstPrompt", async () => {
    vi.mocked(listSessions).mockResolvedValueOnce([
      { sessionId: "s3", firstPrompt: "", customTitle: undefined },
    ] as never);

    const ws = mockWs();
    await handleWsRequest(ws as never, req("sessions.list", {}));

    await new Promise((r) => setTimeout(r, 50));
    expect(vi.mocked(generateTitle)).not.toHaveBeenCalled();
  });

  it("does not re-trigger for sessions already attempted", async () => {
    vi.mocked(listSessions).mockResolvedValue([
      { sessionId: "s4", firstPrompt: "Test", customTitle: undefined },
    ] as never);

    const ws = mockWs();
    // First call — should trigger
    await handleWsRequest(ws as never, req("sessions.list", {}));
    await new Promise((r) => setTimeout(r, 50));
    expect(vi.mocked(generateTitle)).toHaveBeenCalledTimes(1);

    vi.mocked(generateTitle).mockClear();

    // Second call — same session, should NOT re-trigger
    await handleWsRequest(ws as never, req("sessions.list", {}));
    await new Promise((r) => setTimeout(r, 50));
    expect(vi.mocked(generateTitle)).not.toHaveBeenCalled();
  });

  it("sends session.titled event and calls renameSession on success", async () => {
    vi.mocked(listSessions).mockResolvedValueOnce([
      { sessionId: "s5", firstPrompt: "Build a dashboard", customTitle: undefined },
    ] as never);
    vi.mocked(generateTitle).mockResolvedValueOnce("Dashboard Builder");
    vi.mocked(renameSession).mockResolvedValueOnce(true);

    const ws = mockWs();
    await handleWsRequest(ws as never, req("sessions.list", {}));

    // Wait for async batch to complete
    await new Promise((r) => setTimeout(r, 100));

    expect(vi.mocked(renameSession)).toHaveBeenCalledWith("s5", "Dashboard Builder");
    const frames = ws._sent.map((s: string) => JSON.parse(s));
    const titledEvent = frames.find(
      (f: Record<string, unknown>) => f.event === "session.titled"
    );
    expect(titledEvent).toBeDefined();
    expect(titledEvent.data).toEqual({ sessionId: "s5", title: "Dashboard Builder" });
  });
});
