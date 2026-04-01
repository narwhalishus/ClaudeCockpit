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

// ── Mock node:http and ws to prevent server.ts from actually listening ────
// Use synchronous factories to ensure mocks are in place before module evaluation.
vi.mock("node:http", () => {
  const m = {
    createServer: vi.fn(() => ({
      listen: vi.fn((_port: number, cb?: () => void) => cb?.()),
    })),
  };
  return { ...m, default: m };
});
vi.mock("ws", () => {
  class MockWebSocketServer {
    on = vi.fn();
    clients = new Set();
  }
  return { WebSocketServer: MockWebSocketServer, default: { WebSocketServer: MockWebSocketServer } };
});

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

import { handleWsRequest } from "../../gateway/server.ts";
import { getOverviewStats, listSessions, listProjects, getSessionMessages, renameSession } from "../../gateway/services/session-store.ts";
import { abortChat, getProcess } from "../../gateway/services/claude-cli.ts";
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
    expect(frame.result).toEqual({ totalSessions: 5 });
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
});
