/**
 * Claude CLI service — spawns `claude -p` processes and streams output.
 *
 * Uses --output-format stream-json for real-time NDJSON streaming.
 * Each line is a complete JSON object representing a message chunk.
 *
 * Stream-json output types (observed):
 *   { type: "assistant", message: { ... } }      — assistant text/thinking/tool chunks
 *   { type: "result", subtype: "success", ... }   — final result with cost/usage
 *   { type: "system", ... }                        — system messages
 */
import { spawn, type ChildProcess } from "node:child_process";
import { EventEmitter } from "node:events";
import {
  TITLE_GENERATION_TIMEOUT_MS,
  TITLE_MAX_LENGTH,
  TITLE_GENERATION_MAX_BUDGET,
  PROCESS_KILL_TIMEOUT_MS,
} from "../constants.ts";

export interface ChatRequest {
  prompt: string;
  sessionId?: string;
  model?: string;
  maxBudget?: number;
  cwd?: string;
  /** Skip session persistence (no JSONL file created) */
  noSession?: boolean;
  /** Enable bidirectional control protocol (--input-format stream-json) */
  interactive?: boolean;
}

export interface ChatChunk {
  type: string;
  content?: string;
  raw?: unknown;
}

/**
 * A running Claude CLI process.
 *
 * Events:
 *   "chunk"  — a parsed streaming chunk
 *   "result" — the final result object
 *   "error"  — an error occurred
 *   "close"  — the process exited
 */
export class ClaudeProcess extends EventEmitter {
  private proc: ChildProcess | null = null;
  private buffer = "";
  private _pendingApproval: { requestId: string; request: unknown } | null = null;
  private killTimer: ReturnType<typeof setTimeout> | null = null;

  constructor(private request: ChatRequest) {
    super();
  }

  /** Current pending tool approval request, if any */
  get pendingApproval() {
    return this._pendingApproval;
  }

  start(): void {
    const args = this.buildArgs();

    this.proc = spawn("claude", args, {
      stdio: ["pipe", "pipe", "pipe"],
      cwd: this.request.cwd || process.env.HOME,
      env: { ...process.env },
    });

    // Handle stdout (NDJSON stream)
    this.proc.stdout?.on("data", (data: Buffer) => {
      this.buffer += data.toString();
      this.processBuffer();
    });
    this.proc.stdout?.on("error", (err) => {
      this.emit("error", err);
    });

    // Handle stderr
    this.proc.stderr?.on("data", (data: Buffer) => {
      const text = data.toString().trim();
      if (text) {
        this.emit("chunk", {
          type: "error",
          content: text,
        } satisfies ChatChunk);
      }
    });
    this.proc.stderr?.on("error", (err) => {
      this.emit("error", err);
    });

    // Handle stdin errors (EPIPE is expected when process exits before write completes)
    this.proc.stdin?.on("error", (err: NodeJS.ErrnoException) => {
      if (err.code !== "EPIPE") {
        this.emit("error", err);
      }
    });

    // Handle process exit
    this.proc.on("close", (code) => {
      // Clean up kill timer if process exits naturally
      if (this.killTimer) {
        clearTimeout(this.killTimer);
        this.killTimer = null;
      }
      // Process any remaining buffer
      if (this.buffer.trim()) {
        this.processBuffer();
      }
      this.emit("close", code);
    });

    this.proc.on("error", (err) => {
      this.emit("error", err);
    });

    // Write prompt via stdin
    if (this.proc.stdin) {
      if (this.request.interactive) {
        // Structured JSON message — stdin stays open for control responses
        const msg = JSON.stringify({
          type: "user",
          message: { role: "user", content: this.request.prompt },
        });
        this.proc.stdin.write(msg + "\n");
      } else {
        // Raw text prompt — close stdin after writing
        this.proc.stdin.write(this.request.prompt);
        this.proc.stdin.end();
      }
    }
  }

  abort(): void {
    if (this.proc && !this.proc.killed) {
      // Clear any existing kill timer to prevent leaks on repeated abort()
      if (this.killTimer) {
        clearTimeout(this.killTimer);
        this.killTimer = null;
      }
      this.proc.kill("SIGTERM");
      // Force kill after timeout if still alive
      this.killTimer = setTimeout(() => {
        this.killTimer = null;
        if (this.proc && !this.proc.killed) {
          this.proc.kill("SIGKILL");
        }
      }, PROCESS_KILL_TIMEOUT_MS);
    }
  }

  /** Send a control_response to approve or deny a tool use request */
  writeControlResponse(
    requestId: string,
    behavior: "allow" | "deny",
    message?: string
  ): boolean {
    if (!this.proc?.stdin || this.proc.stdin.destroyed) return false;

    const response: Record<string, unknown> = { behavior };
    if (behavior === "allow") {
      response.updatedInput = {};
    } else {
      response.message = message ?? "User denied tool use";
    }

    const frame = JSON.stringify({
      type: "control_response",
      response: {
        subtype: "success",
        request_id: requestId,
        response,
      },
    });
    this.proc.stdin.write(frame + "\n");
    this._pendingApproval = null;
    return true;
  }

  buildArgs(): string[] {
    const args = ["-p", "--output-format", "stream-json", "--verbose"];

    if (this.request.interactive) {
      args.push("--input-format", "stream-json", "--permission-mode", "default");
    }

    if (this.request.noSession) {
      args.push("--no-session-persistence");
    }

    if (this.request.sessionId) {
      args.push("-r", this.request.sessionId);
    }

    if (this.request.model && !this.request.sessionId) {
      args.push("--model", this.request.model);
    }

    if (this.request.maxBudget) {
      args.push("--max-budget-usd", String(this.request.maxBudget));
    }

    return args;
  }

  /** Process the NDJSON buffer line by line */
  private processBuffer(): void {
    const lines = this.buffer.split("\n");
    // Keep the last incomplete line in the buffer
    this.buffer = lines.pop() ?? "";

    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed) continue;

      try {
        const parsed = JSON.parse(trimmed);
        this.handleParsedLine(parsed);
      } catch {
        // Non-JSON output (e.g. progress indicators) — emit as text
        this.emit("chunk", {
          type: "text",
          content: trimmed,
        } satisfies ChatChunk);
      }
    }
  }

  /** Route a parsed NDJSON line to the appropriate event */
  handleParsedLine(data: Record<string, unknown>): void {
    const type = data.type as string;

    if (type === "control_request") {
      this._pendingApproval = {
        requestId: data.request_id as string,
        request: data.request,
      };
      this.emit("tool.approval", data);
      return;
    }

    if (type === "result") {
      this.emit("result", data);
      this.emit("chunk", {
        type: "result",
        content: data.result as string | undefined,
        raw: data,
      } satisfies ChatChunk);
      // In interactive mode, close stdin after result so the process exits.
      // Tool approvals happen before result, so nothing more to send.
      if (this.request.interactive && this.proc?.stdin && !this.proc.stdin.destroyed) {
        this.proc.stdin.end();
      }
      return;
    }

    if (type === "assistant") {
      const message = data.message as Record<string, unknown> | undefined;
      const content = message?.content;

      if (Array.isArray(content)) {
        for (const block of content) {
          if (block.type === "text" && block.text) {
            this.emit("chunk", {
              type: "text",
              content: block.text,
            } satisfies ChatChunk);
          } else if (block.type === "thinking" && block.thinking) {
            this.emit("chunk", {
              type: "thinking",
              content: block.thinking,
            } satisfies ChatChunk);
          } else if (block.type === "tool_use") {
            this.emit("chunk", {
              type: "tool_use",
              content: block.name,
              raw: block,
            } satisfies ChatChunk);
          } else if (block.type === "tool_result") {
            this.emit("chunk", {
              type: "tool_result",
              content:
                typeof block.content === "string"
                  ? block.content
                  : JSON.stringify(block.content),
              raw: block,
            } satisfies ChatChunk);
          }
        }
      }
      return;
    }

    if (type === "system") {
      this.emit("chunk", {
        type: "system",
        content: JSON.stringify(data),
        raw: data,
      } satisfies ChatChunk);
      return;
    }

    // Unknown type — pass through with original type so the UI can ignore it
    this.emit("chunk", {
      type,
      raw: data,
    } satisfies ChatChunk);
  }
}

/** Active processes keyed by a client-chosen chat ID */
const activeProcesses = new Map<string, ClaudeProcess>();

/** Start a new chat process */
export function startChat(
  chatId: string,
  request: ChatRequest
): ClaudeProcess {
  // Abort any existing process with this ID
  abortChat(chatId);

  const proc = new ClaudeProcess(request);
  activeProcesses.set(chatId, proc);

  proc.on("close", () => {
    activeProcesses.delete(chatId);
  });

  proc.start();
  return proc;
}

/** Get a running chat process by ID */
export function getProcess(chatId: string): ClaudeProcess | undefined {
  return activeProcesses.get(chatId);
}

/** Abort a running chat process */
export function abortChat(chatId: string): boolean {
  const proc = activeProcesses.get(chatId);
  if (proc) {
    proc.abort();
    activeProcesses.delete(chatId);
    return true;
  }
  return false;
}

/**
 * Generate a short title for a conversation using a one-shot Claude call.
 * Inspired by OpenClaw's generateTopicLabel() — 3-5 words, max 50 chars.
 * Returns null on failure (timeout, error, empty result).
 */
export async function generateTitle(firstPrompt: string, model?: string): Promise<string | null> {
  const prompt = `Generate a short title (3-5 words, max 50 characters) for a conversation that starts with the message below. Reply with ONLY the title, no quotes, no punctuation at the end.\n\nMessage: ${firstPrompt.slice(0, 300)}`;

  const proc = new ClaudeProcess({
    prompt,
    model,
    maxBudget: TITLE_GENERATION_MAX_BUDGET,
    noSession: true,
  });

  return new Promise((resolve) => {
    const timeout = setTimeout(() => {
      proc.abort();
      resolve(null);
    }, TITLE_GENERATION_TIMEOUT_MS);

    proc.on("result", (data: Record<string, unknown>) => {
      clearTimeout(timeout);
      const result = (data.result as string ?? "").trim().slice(0, TITLE_MAX_LENGTH);
      resolve(result || null);
    });

    proc.on("error", () => {
      clearTimeout(timeout);
      resolve(null);
    });

    proc.on("close", () => {
      clearTimeout(timeout);
      // If we haven't resolved yet (no result event), resolve null
      resolve(null);
    });

    proc.start();
  });
}
