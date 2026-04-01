/**
 * WebSocket frame protocol for the ClaudeCockpit gateway.
 *
 * Three frame types:
 *   req  — client → server request (expects a res back)
 *   res  — server → client response (matches a req by id)
 *   event — server → client push (no matching req)
 *
 * Adapted from OpenClaw's frame protocol but simplified for our use case.
 */

/** Unique ID for request/response matching */
export type FrameId = string;

/** Request frame: client asks the server to do something */
export interface RequestFrame {
  type: "req";
  id: FrameId;
  method: string;
  params?: Record<string, unknown>;
}

/** Response frame: server replies to a specific request */
export interface ResponseFrame {
  type: "res";
  id: FrameId;
  result?: unknown;
  error?: {
    code: string;
    message: string;
  };
}

/** Event frame: server pushes data without a matching request */
export interface EventFrame {
  type: "event";
  event: string;
  data?: unknown;
}

/** Union of all frame types */
export type GatewayFrame = RequestFrame | ResponseFrame | EventFrame;

/** Known request methods */
export type RequestMethod =
  | "overview.get"
  | "sessions.list"
  | "sessions.messages"
  | "sessions.rename"
  | "sessions.summarize"
  | "projects.list"
  | "chat.send"
  | "chat.abort"
  | "tool.respond";

/** Parse a raw WebSocket message into a frame */
export function parseFrame(raw: string): GatewayFrame | null {
  try {
    const frame = JSON.parse(raw);
    if (frame && typeof frame.type === "string") {
      return frame as GatewayFrame;
    }
  } catch {
    // Malformed JSON
  }
  return null;
}

/** Serialize a frame for sending over WebSocket */
export function serializeFrame(frame: GatewayFrame): string {
  return JSON.stringify(frame);
}

/** Create a success response frame */
export function okResponse(id: FrameId, result: unknown): ResponseFrame {
  return { type: "res", id, result };
}

/** Create an error response frame */
export function errResponse(
  id: FrameId,
  code: string,
  message: string
): ResponseFrame {
  return { type: "res", id, error: { code, message } };
}

/** Create an event frame */
export function event(eventName: string, data?: unknown): EventFrame {
  return { type: "event", event: eventName, data };
}
