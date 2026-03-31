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

export interface ChatRequest {
  prompt: string;
  sessionId?: string;
  model?: string;
  maxBudget?: number;
  cwd?: string;
  /** Skip session persistence (no JSONL file created) */
  noSession?: boolean;
}

export interface ChatChunk {
  type: "text" | "thinking" | "tool_use" | "tool_result" | "result" | "error" | "system";
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

  constructor(private request: ChatRequest) {
    super();
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

    // Handle process exit
    this.proc.on("close", (code) => {
      // Process any remaining buffer
      if (this.buffer.trim()) {
        this.processBuffer();
      }
      this.emit("close", code);
    });

    this.proc.on("error", (err) => {
      this.emit("error", err);
    });

    // Write prompt via stdin (avoids ARG_MAX limits for large prompts)
    if (this.proc.stdin) {
      this.proc.stdin.write(this.request.prompt);
      this.proc.stdin.end();
    }
  }

  abort(): void {
    if (this.proc && !this.proc.killed) {
      this.proc.kill("SIGTERM");
      // Force kill after 5 seconds if still alive
      setTimeout(() => {
        if (this.proc && !this.proc.killed) {
          this.proc.kill("SIGKILL");
        }
      }, 5000);
    }
  }

  private buildArgs(): string[] {
    const args = ["-p", "--output-format", "stream-json", "--verbose"];

    if (this.request.noSession) {
      args.push("--no-session-persistence");
    }

    if (this.request.sessionId) {
      args.push("-r", this.request.sessionId);
    }

    if (this.request.model) {
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
  private handleParsedLine(data: Record<string, unknown>): void {
    const type = data.type as string;

    if (type === "result") {
      this.emit("result", data);
      this.emit("chunk", {
        type: "result",
        content: data.result as string | undefined,
        raw: data,
      } satisfies ChatChunk);
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

    // Unknown type — emit as raw
    this.emit("chunk", {
      type: "text",
      content: JSON.stringify(data),
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
export async function generateTitle(firstPrompt: string): Promise<string | null> {
  const prompt = `Generate a short title (3-5 words, max 50 characters) for a conversation that starts with the message below. Reply with ONLY the title, no quotes, no punctuation at the end.\n\nMessage: ${firstPrompt.slice(0, 300)}`;

  return new Promise((resolve) => {
    const timeout = setTimeout(() => {
      proc.abort();
      resolve(null);
    }, 15_000);

    const proc = new ClaudeProcess({
      prompt,
      maxBudget: 0.05,
      noSession: true,
    });

    proc.on("result", (data: Record<string, unknown>) => {
      clearTimeout(timeout);
      const result = (data.result as string ?? "").trim().slice(0, 100);
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
