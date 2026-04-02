/**
 * Unit tests for the WebSocket frame protocol.
 *
 * Tests parseFrame (valid + malformed), serializeFrame (round-trip),
 * and the helper constructors (okResponse, errResponse, event).
 */
import { describe, it, expect } from "vitest";
import {
  parseFrame,
  serializeFrame,
  okResponse,
  errResponse,
  event,
} from "../../gateway/protocol/frames.ts";

describe("parseFrame", () => {
  it("parses a valid request frame", () => {
    const raw = JSON.stringify({ type: "req", id: "1", method: "overview.get", params: { project: "p1" } });
    const frame = parseFrame(raw);
    expect(frame).toEqual({ type: "req", id: "1", method: "overview.get", params: { project: "p1" } });
  });

  it("parses a valid response frame", () => {
    const raw = JSON.stringify({ type: "res", id: "1", result: { ok: true } });
    const frame = parseFrame(raw);
    expect(frame).toEqual({ type: "res", id: "1", result: { ok: true } });
  });

  it("parses a valid event frame", () => {
    const raw = JSON.stringify({ type: "event", event: "chat.chunk", data: { text: "hi" } });
    const frame = parseFrame(raw);
    expect(frame).toEqual({ type: "event", event: "chat.chunk", data: { text: "hi" } });
  });

  it("returns null for malformed JSON", () => {
    expect(parseFrame("{not json")).toBeNull();
    expect(parseFrame("")).toBeNull();
  });

  it("returns null for objects without a type field", () => {
    expect(parseFrame(JSON.stringify({ id: "1", method: "foo" }))).toBeNull();
    expect(parseFrame(JSON.stringify({}))).toBeNull();
  });

  it("returns null for non-string type", () => {
    expect(parseFrame(JSON.stringify({ type: 123 }))).toBeNull();
  });

  // ── Per-type required field validation ──

  it("returns null for req frame missing id", () => {
    expect(parseFrame(JSON.stringify({ type: "req", method: "foo" }))).toBeNull();
  });

  it("returns null for req frame missing method", () => {
    expect(parseFrame(JSON.stringify({ type: "req", id: "1" }))).toBeNull();
  });

  it("returns null for res frame missing id", () => {
    expect(parseFrame(JSON.stringify({ type: "res", result: {} }))).toBeNull();
  });

  it("returns null for event frame missing event name", () => {
    expect(parseFrame(JSON.stringify({ type: "event", data: {} }))).toBeNull();
  });

  it("accepts req frame with all required fields", () => {
    const frame = parseFrame(JSON.stringify({ type: "req", id: "1", method: "test" }));
    expect(frame).not.toBeNull();
    expect(frame!.type).toBe("req");
  });

  it("accepts res frame with only id", () => {
    const frame = parseFrame(JSON.stringify({ type: "res", id: "1" }));
    expect(frame).not.toBeNull();
    expect(frame!.type).toBe("res");
  });

  it("accepts event frame with only event name", () => {
    const frame = parseFrame(JSON.stringify({ type: "event", event: "ping" }));
    expect(frame).not.toBeNull();
    expect(frame!.type).toBe("event");
  });

  it("passes through unknown frame types (forward compat)", () => {
    const frame = parseFrame(JSON.stringify({ type: "future-type", data: 42 }));
    expect(frame).not.toBeNull();
    expect(frame!.type).toBe("future-type");
  });
});

describe("serializeFrame", () => {
  it("round-trips a request frame", () => {
    const frame = { type: "req" as const, id: "1", method: "sessions.list" };
    const serialized = serializeFrame(frame);
    const parsed = parseFrame(serialized);
    expect(parsed).toEqual(frame);
  });

  it("round-trips an event frame", () => {
    const frame = event("chat.chunk", { text: "hello" });
    const serialized = serializeFrame(frame);
    const parsed = parseFrame(serialized);
    expect(parsed).toEqual(frame);
  });

  it("round-trips a response frame with error", () => {
    const frame = errResponse("42", "NOT_FOUND", "Session not found");
    const serialized = serializeFrame(frame);
    const parsed = parseFrame(serialized);
    expect(parsed).toEqual(frame);
  });
});

describe("okResponse", () => {
  it("creates a success response frame", () => {
    const frame = okResponse("req-1", { sessions: [] });
    expect(frame).toEqual({
      type: "res",
      id: "req-1",
      result: { sessions: [] },
    });
  });

  it("preserves complex result data", () => {
    const data = { nested: { deep: [1, 2, 3] } };
    const frame = okResponse("req-2", data);
    expect(frame.result).toEqual(data);
  });
});

describe("errResponse", () => {
  it("creates an error response frame", () => {
    const frame = errResponse("req-1", "INVALID_PARAMS", "sessionId is required");
    expect(frame).toEqual({
      type: "res",
      id: "req-1",
      error: { code: "INVALID_PARAMS", message: "sessionId is required" },
    });
  });
});

describe("event", () => {
  it("creates an event frame with data", () => {
    const frame = event("chat.started", { chatId: "c1" });
    expect(frame).toEqual({
      type: "event",
      event: "chat.started",
      data: { chatId: "c1" },
    });
  });

  it("creates an event frame without data", () => {
    const frame = event("chat.close");
    expect(frame).toEqual({
      type: "event",
      event: "chat.close",
      data: undefined,
    });
  });
});
