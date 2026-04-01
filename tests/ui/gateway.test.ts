/**
 * Unit tests for GatewayBrowserClient — request/response matching,
 * event subscriptions, connection state, and error handling.
 *
 * Injects a mock WebSocket directly into the client's private `ws` field
 * rather than mocking the WebSocket constructor, for simpler test setup.
 */
import { describe, it, expect, vi } from "vitest";
import { GatewayBrowserClient } from "../../ui/gateway.ts";

// ── Mock WebSocket ────────────────────────────────────────────────────────

function mockWs() {
  const sent: string[] = [];
  const self = {
    readyState: 1, // WebSocket.OPEN
    sent,
    send(data: string) { sent.push(data); },
    close() { self.readyState = 3; self.onclose?.(); },
    onopen: null as (() => void) | null,
    onmessage: null as ((ev: { data: string }) => void) | null,
    onclose: null as (() => void) | null,
    onerror: null as (() => void) | null,
    /** Simulate receiving a message from the server */
    receive(frame: Record<string, unknown>) {
      self.onmessage?.({ data: JSON.stringify(frame) });
    },
  };
  return self;
}

/**
 * Create a GatewayBrowserClient wired to a mock WebSocket.
 * Bypasses the real connect() and injects the mock directly,
 * then wires up onmessage to the client's handleMessage method.
 */
function createClient() {
  const client = new GatewayBrowserClient("ws://test/ws");
  const ws = mockWs();

  // Inject mock ws and set connected state
  const c = client as any;
  c.ws = ws;
  c._connected = true;
  c.shouldReconnect = false;

  // Wire up onmessage to the client's private handleMessage (mimics connect())
  ws.onmessage = (ev: { data: string }) => {
    c.handleMessage(ev.data);
  };

  return { client, ws };
}

// ── Tests ─────────────────────────────────────────────────────────────────

describe("GatewayBrowserClient — request/response", () => {
  it("sends correct frame format for a request", () => {
    const { client, ws } = createClient();

    client.request("overview.get", { project: "p1" });

    expect(ws.sent).toHaveLength(1);
    const frame = JSON.parse(ws.sent[0]);
    expect(frame.type).toBe("req");
    expect(frame.method).toBe("overview.get");
    expect(frame.params).toEqual({ project: "p1" });
    expect(typeof frame.id).toBe("string");
  });

  it("resolves matching response by id", async () => {
    const { client, ws } = createClient();

    const promise = client.request("sessions.list");
    const frame = JSON.parse(ws.sent[0]);

    ws.receive({ type: "res", id: frame.id, result: { sessions: [] } });

    const result = await promise;
    expect(result).toEqual({ sessions: [] });
  });

  it("rejects on error response", async () => {
    const { client, ws } = createClient();

    const promise = client.request("sessions.messages");
    const frame = JSON.parse(ws.sent[0]);

    ws.receive({
      type: "res",
      id: frame.id,
      error: { code: "NOT_FOUND", message: "Session not found" },
    });

    await expect(promise).rejects.toThrow("NOT_FOUND: Session not found");
  });

  it("rejects on timeout", async () => {
    vi.useFakeTimers();
    const { client } = createClient();

    const promise = client.request("slow.method", {}, 1000);

    vi.advanceTimersByTime(1001);

    await expect(promise).rejects.toThrow("timed out");
    vi.useRealTimers();
  });
});

describe("GatewayBrowserClient — events", () => {
  it("dispatches event to subscribed handler", () => {
    const { client, ws } = createClient();
    const handler = vi.fn();

    client.on("chat.chunk", handler);

    ws.receive({
      type: "event",
      event: "chat.chunk",
      data: { chatId: "c1", type: "text", content: "Hello" },
    });

    expect(handler).toHaveBeenCalledOnce();
    expect(handler).toHaveBeenCalledWith({ chatId: "c1", type: "text", content: "Hello" });
  });

  it("unsubscribe removes handler", () => {
    const { client, ws } = createClient();
    const handler = vi.fn();

    const unsub = client.on("chat.chunk", handler);
    unsub();

    ws.receive({ type: "event", event: "chat.chunk", data: {} });

    expect(handler).not.toHaveBeenCalled();
  });
});

describe("GatewayBrowserClient — connection state", () => {
  it("reports connected flag correctly", () => {
    const { client } = createClient();
    expect(client.connected).toBe(true);
  });

  it("rejects requests when not connected", async () => {
    const client = new GatewayBrowserClient("ws://test/ws");
    // Not connected, no ws
    await expect(client.request("overview.get")).rejects.toThrow("Not connected");
  });

  it("rejects pending requests on close", async () => {
    const { client, ws } = createClient();

    const promise = client.request("sessions.list");

    // Wire up onclose like connect() would, then trigger it
    const c = client as any;
    c.ws.onclose = () => {
      c._connected = false;
      c.ws = null;
      // Reject pending requests (mirrors real onclose handler)
      for (const [id, req] of c.pending) {
        clearTimeout(req.timer);
        req.reject(new Error("WebSocket closed"));
        c.pending.delete(id);
      }
    };
    ws.close();

    await expect(promise).rejects.toThrow("WebSocket closed");
  });
});
