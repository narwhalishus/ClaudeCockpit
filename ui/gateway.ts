/**
 * GatewayBrowserClient — WebSocket client for the dashboard.
 *
 * Adapted from OpenClaw's gateway.ts pattern:
 *   - Request/response matching via frame IDs
 *   - Event subscription system
 *   - Exponential backoff reconnection
 *
 * Usage:
 *   const gw = new GatewayBrowserClient();
 *   gw.on("chat.chunk", (data) => { ... });
 *   const result = await gw.request("overview.get");
 */

type FrameId = string;
type EventHandler = (data: unknown) => void;

interface PendingRequest {
  resolve: (result: unknown) => void;
  reject: (error: Error) => void;
  timer: ReturnType<typeof setTimeout>;
}

export class GatewayBrowserClient {
  private ws: WebSocket | null = null;
  private pending = new Map<FrameId, PendingRequest>();
  private listeners = new Map<string, Set<EventHandler>>();
  private nextId = 1;
  private reconnectDelay = 800;
  private maxReconnectDelay = 15_000;
  private shouldReconnect = true;
  private _connected = false;

  /** Callback fired when connection state changes */
  onConnectionChange: ((connected: boolean) => void) | null = null;

  get connected(): boolean {
    return this._connected;
  }

  constructor(private url?: string) {}

  /** Connect to the gateway WebSocket */
  connect(): void {
    if (this.ws) return;

    const wsUrl =
      this.url ??
      `ws://${window.location.hostname}:18800/ws`;

    this.ws = new WebSocket(wsUrl);

    this.ws.onopen = () => {
      this._connected = true;
      this.reconnectDelay = 800;
      this.onConnectionChange?.(true);
    };

    this.ws.onmessage = (ev) => {
      this.handleMessage(ev.data as string);
    };

    this.ws.onclose = () => {
      this._connected = false;
      this.ws = null;
      this.onConnectionChange?.(false);

      // Reject any pending requests
      for (const [id, req] of this.pending) {
        clearTimeout(req.timer);
        req.reject(new Error("WebSocket closed"));
        this.pending.delete(id);
      }

      // Reconnect with backoff
      if (this.shouldReconnect) {
        setTimeout(() => this.connect(), this.reconnectDelay);
        this.reconnectDelay = Math.min(
          this.reconnectDelay * 1.5,
          this.maxReconnectDelay
        );
      }
    };

    this.ws.onerror = () => {
      // onclose will fire after onerror — reconnection handled there
    };
  }

  /** Disconnect and stop reconnecting */
  disconnect(): void {
    this.shouldReconnect = false;
    this.ws?.close();
    this.ws = null;
  }

  /**
   * Send a request and wait for the response.
   * Returns the result, or throws on error/timeout.
   */
  request(
    method: string,
    params?: Record<string, unknown>,
    timeoutMs = 30_000
  ): Promise<unknown> {
    return new Promise((resolve, reject) => {
      if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
        reject(new Error("Not connected"));
        return;
      }

      const id = String(this.nextId++);
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`Request ${method} timed out`));
      }, timeoutMs);

      this.pending.set(id, { resolve, reject, timer });

      this.ws.send(
        JSON.stringify({ type: "req", id, method, params })
      );
    });
  }

  /** Subscribe to a gateway event */
  on(eventName: string, handler: EventHandler): () => void {
    if (!this.listeners.has(eventName)) {
      this.listeners.set(eventName, new Set());
    }
    this.listeners.get(eventName)!.add(handler);

    // Return unsubscribe function
    return () => {
      this.listeners.get(eventName)?.delete(handler);
    };
  }

  /** Remove an event handler */
  off(eventName: string, handler: EventHandler): void {
    this.listeners.get(eventName)?.delete(handler);
  }

  private handleMessage(raw: string): void {
    let frame: { type: string; id?: string; event?: string; result?: unknown; error?: { code: string; message: string }; data?: unknown };
    try {
      frame = JSON.parse(raw);
    } catch {
      return;
    }

    if (frame.type === "res" && frame.id) {
      const req = this.pending.get(frame.id);
      if (req) {
        clearTimeout(req.timer);
        this.pending.delete(frame.id);
        if (frame.error) {
          req.reject(new Error(`${frame.error.code}: ${frame.error.message}`));
        } else {
          req.resolve(frame.result);
        }
      }
      return;
    }

    if (frame.type === "event" && frame.event) {
      const handlers = this.listeners.get(frame.event);
      if (handlers) {
        for (const handler of handlers) {
          try {
            handler(frame.data);
          } catch (err) {
            console.error(`Event handler error (${frame.event}):`, err);
          }
        }
      }
      return;
    }
  }
}
