/**
 * Integration tests for the gateway request chain.
 *
 * Unlike server.test.ts (which mocks claude-cli entirely), these tests let
 * the real server -> claude-cli code run, mocking ONLY at the OS boundary:
 * `child_process.spawn`. This catches cross-layer bugs like the
 * model-during-resume issue where server.ts passed model to startChat but
 * buildArgs correctly omitted --model for resume — a bug that unit tests
 * couldn't surface because the service boundary was mocked.
 *
 * Mock boundary:
 *   real handleWsRequest -> real startChat -> real buildArgs -> MOCKED spawn
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { PassThrough } from "node:stream";
import { EventEmitter } from "node:events";

// ── vi.hoisted: shared state accessible from vi.mock factories ──────────

const { spawnHolder, lastSpawn } = vi.hoisted(() => ({
  spawnHolder: {
    fn: (_cmd: string, _args: string[], _opts?: unknown) => ({}) as unknown,
  },
  lastSpawn: {
    proc: null as ReturnType<typeof EventEmitter.prototype.emit> | null,
    cmd: "" as string,
    args: [] as string[],
    stdinWrites: [] as string[],
  },
}));

// ── Mock child_process.spawn — the ONLY service-layer mock ──────────────

vi.mock("node:child_process", () => {
  const m = {
    spawn: (...args: unknown[]) =>
      (spawnHolder.fn as (...a: unknown[]) => unknown)(...args),
  };
  return { ...m, default: m };
});

// ── Mock node:http and ws to prevent server.ts from actually listening ──

vi.mock("node:http", () => {
  const m = {
    createServer: vi.fn((_handler: unknown) => ({
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
  return {
    WebSocketServer: MockWebSocketServer,
    default: { WebSocketServer: MockWebSocketServer },
  };
});

// ── Mock session-store (read-side only — not the code under test) ───────

vi.mock("../../gateway/services/session-store.ts", () => ({
  getOverviewStats: vi.fn().mockResolvedValue({ totalSessions: 0 }),
  listSessions: vi.fn().mockResolvedValue([]),
  listProjects: vi.fn().mockResolvedValue([]),
  getSessionMessages: vi.fn().mockResolvedValue(null),
  getSessionTranscript: vi.fn().mockResolvedValue(null),
  renameSession: vi.fn().mockResolvedValue(true),
  cleanErrorTitles: vi.fn().mockResolvedValue(0),
}));

// ── Imports (after all vi.mock calls) ───────────────────────────────────

import { handleWsRequest } from "../../gateway/server.ts";
import type { RequestFrame } from "../../gateway/protocol/frames.ts";

// ── Helpers ─────────────────────────────────────────────────────────────

interface FakeProcess extends EventEmitter {
  stdout: PassThrough;
  stderr: PassThrough;
  stdin: PassThrough;
  killed: boolean;
  kill: ReturnType<typeof vi.fn>;
  pid: number;
}

function createFakeProcess(): FakeProcess {
  const proc = Object.assign(new EventEmitter(), {
    stdout: new PassThrough(),
    stderr: new PassThrough(),
    stdin: new PassThrough(),
    killed: false,
    kill: vi.fn(),
    pid: 12345,
  });
  return proc as FakeProcess;
}

function mockWs() {
  const sent: string[] = [];
  return {
    OPEN: 1,
    readyState: 1,
    send: vi.fn((data: string) => sent.push(data)),
    _sent: sent,
    lastFrame() {
      return JSON.parse(sent[sent.length - 1]);
    },
    allFrames() {
      return sent.map((s) => JSON.parse(s));
    },
  };
}

let reqCounter = 0;
function req(method: string, params?: Record<string, unknown>): RequestFrame {
  return { type: "req", id: `integ-${++reqCounter}`, method, params };
}

/** Yield to the event loop so PassThrough stream data events propagate */
function tick(): Promise<void> {
  return new Promise((r) => process.nextTick(r));
}

// ── Test setup ──────────────────────────────────────────────────────────

describe("Gateway integration — server -> claude-cli -> spawn boundary", () => {
  let chatCounter = 0;

  beforeEach(() => {
    chatCounter++;
    lastSpawn.proc = null;
    lastSpawn.cmd = "";
    lastSpawn.args = [];
    lastSpawn.stdinWrites = [];

    spawnHolder.fn = vi.fn((_cmd: string, _args: string[]) => {
      const proc = createFakeProcess();

      // Capture all stdin writes (prompt + control responses)
      proc.stdin.on("data", (d: Buffer) => {
        lastSpawn.stdinWrites.push(d.toString());
      });

      lastSpawn.proc = proc;
      lastSpawn.cmd = _cmd;
      lastSpawn.args = _args;
      return proc;
    });
  });

  afterEach(() => {
    // Emit close on fake process to trigger cleanup:
    // - activeProcesses.delete(chatId) in claude-cli.ts
    // - killTimer clearTimeout in ClaudeProcess.abort()
    if (lastSpawn.proc) {
      try {
        (lastSpawn.proc as unknown as EventEmitter).emit("close", 1);
      } catch {
        // Process may already be cleaned up
      }
    }
    vi.clearAllMocks();
  });

  // ── Test 1: Resume omits --model from spawn args ────────────────────

  it("resume session: spawn args include -r <id> but omit --model", async () => {
    const ws = mockWs();
    await handleWsRequest(
      ws as never,
      req("chat.send", {
        prompt: "continue the work",
        chatId: `resume-${chatCounter}`,
        sessionId: "sess-abc-123",
        model: "claude-opus-4-6",
      })
    );

    expect(lastSpawn.cmd).toBe("claude");
    expect(lastSpawn.args).toContain("-r");
    expect(lastSpawn.args).toContain("sess-abc-123");
    expect(lastSpawn.args).not.toContain("--model");
    expect(lastSpawn.args).not.toContain("claude-opus-4-6");
  });

  // ── Test 2: New session includes --model in spawn args ──────────────

  it("new session: spawn args include --model", async () => {
    const ws = mockWs();
    await handleWsRequest(
      ws as never,
      req("chat.send", {
        prompt: "hello",
        chatId: `new-${chatCounter}`,
        model: "claude-sonnet-4-6",
      })
    );

    expect(lastSpawn.args).toContain("--model");
    expect(lastSpawn.args).toContain("claude-sonnet-4-6");
    expect(lastSpawn.args).not.toContain("-r");
  });

  // ── Test 3: Interactive flags always present ────────────────────────

  it("chat.send always sets interactive control protocol flags", async () => {
    const ws = mockWs();
    await handleWsRequest(
      ws as never,
      req("chat.send", {
        prompt: "hello",
        chatId: `interactive-${chatCounter}`,
      })
    );

    expect(lastSpawn.args).toContain("--input-format");
    expect(lastSpawn.args).toContain("stream-json");
    expect(lastSpawn.args).toContain("--permission-mode");
    expect(lastSpawn.args).toContain("default");
    // Always present regardless of interactive flag
    expect(lastSpawn.args).toContain("-p");
    expect(lastSpawn.args).toContain("--output-format");
    expect(lastSpawn.args).toContain("--verbose");
  });

  // ── Test 4: Full event pipeline through real code ───────────────────

  it("full pipeline: stdout NDJSON -> WS events (started, chunk, result, close, response)", async () => {
    const ws = mockWs();
    const chatId = `pipeline-${chatCounter}`;
    await handleWsRequest(
      ws as never,
      req("chat.send", { prompt: "hello", chatId })
    );

    const proc = lastSpawn.proc as unknown as FakeProcess;

    // Feed assistant text via stdout NDJSON
    proc.stdout.write(
      '{"type":"assistant","message":{"content":[{"type":"text","text":"world"}]}}\n'
    );
    await tick();

    // Feed result event (no session_id to avoid title generation)
    proc.stdout.write(
      '{"type":"result","subtype":"success","result":"Done","cost_usd":0.01}\n'
    );
    await tick();

    // Simulate process exit
    proc.emit("close", 0);

    // Verify the full event sequence on the WS
    const frames = ws.allFrames();

    const started = frames.find(
      (f: Record<string, unknown>) => f.event === "chat.started"
    );
    expect(started).toBeDefined();
    expect((started as Record<string, unknown>).data).toMatchObject({ chatId });

    const textChunk = frames.find(
      (f: Record<string, unknown>) =>
        f.event === "chat.chunk" &&
        (f.data as Record<string, unknown>)?.content === "world"
    );
    expect(textChunk).toBeDefined();

    const resultEvent = frames.find(
      (f: Record<string, unknown>) => f.event === "chat.result"
    );
    expect(resultEvent).toBeDefined();

    const closeEvent = frames.find(
      (f: Record<string, unknown>) => f.event === "chat.close"
    );
    expect(closeEvent).toBeDefined();
    expect((closeEvent as Record<string, unknown>).data).toMatchObject({
      chatId,
      exitCode: 0,
    });

    const response = frames.find(
      (f: Record<string, unknown>) =>
        f.type === "res" &&
        (f.result as Record<string, unknown>)?.status === "completed"
    );
    expect(response).toBeDefined();
  });

  // ── Test 5: Tool approval round-trip through real code ──────────────

  it("tool approval: control_request on stdout -> tool.approval WS -> tool.respond -> stdin", async () => {
    const ws = mockWs();
    const chatId = `approval-${chatCounter}`;
    await handleWsRequest(
      ws as never,
      req("chat.send", { prompt: "edit my files", chatId })
    );

    const proc = lastSpawn.proc as unknown as FakeProcess;

    // Simulate Claude requesting tool approval via stdout
    proc.stdout.write(
      JSON.stringify({
        type: "control_request",
        request_id: "req-tool-001",
        request: {
          subtype: "can_use_tool",
          tool_name: "Bash",
          input: { command: "ls -la", description: "List files" },
          tool_use_id: "toolu_001",
        },
      }) + "\n"
    );
    await tick();

    // Verify WS received tool.approval event
    const frames = ws.allFrames();
    const approval = frames.find(
      (f: Record<string, unknown>) => f.event === "tool.approval"
    );
    expect(approval).toBeDefined();
    expect((approval as Record<string, unknown>).data).toMatchObject({
      chatId,
      request_id: "req-tool-001",
    });

    // Clear stdin writes captured so far (prompt was already written)
    lastSpawn.stdinWrites.length = 0;

    // Send tool.respond via WS (user approves)
    await handleWsRequest(
      ws as never,
      req("tool.respond", {
        chatId,
        requestId: "req-tool-001",
        behavior: "allow",
      })
    );
    await tick();

    // Verify control_response was written to stdin
    const controlWrite = lastSpawn.stdinWrites.find((s) =>
      s.includes("control_response")
    );
    expect(controlWrite).toBeDefined();

    const parsed = JSON.parse(controlWrite!.replace(/\n$/, ""));
    expect(parsed.type).toBe("control_response");
    expect(parsed.response.request_id).toBe("req-tool-001");
    expect(parsed.response.response.behavior).toBe("allow");
  });
});
