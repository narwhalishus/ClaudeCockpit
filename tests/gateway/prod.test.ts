/**
 * Tests for gateway/prod.ts preflight + port picker.
 *
 * Pure unit tests: each preflight function accepts its system dependency as a
 * parameter (spawn, stat, createServer), so we inject mocks directly without
 * vi.mock. This mirrors the integration.test.ts pattern of mocking only at
 * the OS boundary.
 */
import { describe, it, expect, vi } from "vitest";
import { EventEmitter } from "node:events";
import {
  parseNodeMajor,
  checkNodeVersion,
  checkClaudeCli,
  checkClaudeProjectsDir,
  pickFreePort,
} from "../../gateway/prod.ts";

// ─── parseNodeMajor ───────────────────────────────────────────────────────

describe("parseNodeMajor", () => {
  it("accepts bare numeric version", () => {
    expect(parseNodeMajor("22.0.0")).toBe(22);
  });
  it("accepts v-prefixed version", () => {
    expect(parseNodeMajor("v23.1.4")).toBe(23);
  });
  it("returns NaN for garbage", () => {
    expect(Number.isNaN(parseNodeMajor("not-a-version"))).toBe(true);
  });
});

// ─── checkNodeVersion ─────────────────────────────────────────────────────

describe("checkNodeVersion", () => {
  it("passes on 22.0.0", () => {
    expect(checkNodeVersion("22.0.0")).toEqual({ ok: true });
  });
  it("passes on v23.1.4", () => {
    expect(checkNodeVersion("v23.1.4")).toEqual({ ok: true });
  });
  it("fails on 20.9.0 with actionable message", () => {
    const result = checkNodeVersion("20.9.0");
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.fatal).toBe(true);
      expect(result.message).toContain("Node.js 22 or newer");
      expect(result.message).toContain("20.9.0");
      expect(result.message).toContain("nodejs.org");
    }
  });
});

// ─── checkClaudeCli ───────────────────────────────────────────────────────

function makeFakeProc() {
  const proc = new EventEmitter() as EventEmitter & { kill: () => void };
  proc.kill = vi.fn();
  return proc;
}

describe("checkClaudeCli", () => {
  it("passes when `claude --version` exits 0", async () => {
    const proc = makeFakeProc();
    const fakeSpawn = vi.fn().mockReturnValue(proc);
    const promise = checkClaudeCli(fakeSpawn as never);
    proc.emit("close", 0);
    const result = await promise;
    expect(result).toEqual({ ok: true });
    expect(fakeSpawn).toHaveBeenCalledWith(
      "claude",
      ["--version"],
      expect.objectContaining({ stdio: "ignore" }),
    );
  });

  it("fails when spawn emits ENOENT error", async () => {
    const proc = makeFakeProc();
    const fakeSpawn = vi.fn().mockReturnValue(proc);
    const promise = checkClaudeCli(fakeSpawn as never);
    proc.emit("error", Object.assign(new Error("ENOENT"), { code: "ENOENT" }));
    const result = await promise;
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.message).toContain("Claude Code CLI not found");
      expect(result.message).toContain("claude.ai/code");
    }
  });

  it("fails when `claude --version` exits non-zero", async () => {
    const proc = makeFakeProc();
    const fakeSpawn = vi.fn().mockReturnValue(proc);
    const promise = checkClaudeCli(fakeSpawn as never);
    proc.emit("close", 127);
    const result = await promise;
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.fatal).toBe(true);
      expect(result.message).toContain("Claude Code CLI not found");
    }
  });

  it("fails when spawn itself throws synchronously", async () => {
    const fakeSpawn = vi.fn(() => {
      throw new Error("spawn failed");
    });
    const result = await checkClaudeCli(fakeSpawn as never);
    expect(result.ok).toBe(false);
  });
});

// ─── checkClaudeProjectsDir ───────────────────────────────────────────────

describe("checkClaudeProjectsDir", () => {
  it("passes when directory exists", async () => {
    const fakeStat = vi.fn().mockResolvedValue({ isDirectory: () => true });
    const result = await checkClaudeProjectsDir(fakeStat as never, "/home/test");
    expect(result).toEqual({ ok: true });
    expect(fakeStat).toHaveBeenCalledWith("/home/test/.claude/projects");
  });

  it("fails non-fatally when directory missing (ENOENT)", async () => {
    const fakeStat = vi.fn().mockRejectedValue(
      Object.assign(new Error("ENOENT"), { code: "ENOENT" }),
    );
    const result = await checkClaudeProjectsDir(fakeStat as never, "/home/test");
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.fatal).toBe(false);
      expect(result.message).toContain("No Claude Code sessions found");
    }
  });

  it("fails when path exists but is not a directory", async () => {
    const fakeStat = vi.fn().mockResolvedValue({ isDirectory: () => false });
    const result = await checkClaudeProjectsDir(fakeStat as never, "/home/test");
    expect(result.ok).toBe(false);
  });
});

// ─── pickFreePort ─────────────────────────────────────────────────────────

type FakeServer = EventEmitter & {
  listen: (port: number) => void;
  close: (cb?: () => void) => void;
  address: () => { port: number } | null;
  removeAllListeners: () => void;
};

function makeFakeServer(opts: {
  failUntil?: number; // simulate EADDRINUSE for ports < this value
  currentPort: { value: number };
}): FakeServer {
  const server = new EventEmitter() as FakeServer;
  let lastListenPort = 0;
  server.listen = (port: number) => {
    lastListenPort = port;
    opts.currentPort.value = port;
    setImmediate(() => {
      if (opts.failUntil && port !== 0 && port < opts.failUntil) {
        server.emit("error", Object.assign(new Error("EADDRINUSE"), { code: "EADDRINUSE" }));
      } else {
        server.emit("listening");
      }
    });
  };
  server.close = (cb?: () => void) => cb?.();
  server.address = () => ({ port: lastListenPort || 0 });
  return server;
}

describe("pickFreePort", () => {
  it("returns start port when free on first attempt", async () => {
    const state = { value: 0 };
    const createServerMock = vi.fn(() => makeFakeServer({ currentPort: state }));
    const port = await pickFreePort(18800, 10, createServerMock as never);
    expect(port).toBe(18800);
  });

  it("increments until finding a free port", async () => {
    const state = { value: 0 };
    const createServerMock = vi.fn(() =>
      makeFakeServer({ failUntil: 18803, currentPort: state }),
    );
    const port = await pickFreePort(18800, 10, createServerMock as never);
    expect(port).toBe(18803);
    // 4 calls: 18800, 18801, 18802 (fail) + 18803 (succeed)
    expect(createServerMock).toHaveBeenCalledTimes(4);
  });

  it("falls back to OS-assigned port after exhausting attempts", async () => {
    const state = { value: 0 };
    let callCount = 0;
    const createServerMock = vi.fn(() => {
      callCount++;
      // First 3 attempts fail with EADDRINUSE; the 4th (OS fallback with port 0) succeeds
      return makeFakeServer({
        failUntil: callCount <= 3 ? 99999 : 0,
        currentPort: state,
      });
    });
    const port = await pickFreePort(18800, 3, createServerMock as never);
    // OS fallback listen(0) yielded port 0 in our fake (which uses lastListenPort)
    expect(port).toBe(0);
    expect(createServerMock).toHaveBeenCalledTimes(4);
  });
});
