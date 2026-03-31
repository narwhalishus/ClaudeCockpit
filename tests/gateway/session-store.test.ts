/**
 * Unit tests for gateway session-store logic.
 *
 * These test the pure data-transformation functions (decodeProjectPath,
 * extractText, summarizeSession) without touching the filesystem.
 */
import { describe, it, expect } from "vitest";
import {
  decodeProjectPath,
  extractText,
  summarizeSession,
  consolidateMessages,
} from "../../gateway/services/session-store.ts";
import type { RawSessionLine } from "../../gateway/types.ts";
import type { ChatMessage } from "../../gateway/types.ts";

// ---------------------------------------------------------------------------
// decodeProjectPath
// ---------------------------------------------------------------------------
describe("decodeProjectPath", () => {
  it("decodes a standard encoded path", () => {
    expect(decodeProjectPath("-Users-bryao-code-myproject")).toBe(
      "/Users/bryao/code/myproject"
    );
  });

  it("handles a root-level path", () => {
    expect(decodeProjectPath("-Users-bryao")).toBe("/Users/bryao");
  });

  it("handles an empty string", () => {
    expect(decodeProjectPath("")).toBe("");
  });
});

// ---------------------------------------------------------------------------
// extractText
// ---------------------------------------------------------------------------
describe("extractText", () => {
  it("returns a plain string as-is", () => {
    expect(extractText("hello world")).toBe("hello world");
  });

  it("extracts text from a content block array", () => {
    const blocks = [
      { type: "tool_result", text: undefined },
      { type: "text", text: "the actual message" },
    ];
    expect(extractText(blocks)).toBe("the actual message");
  });

  it("returns empty string when no text blocks exist", () => {
    const blocks = [{ type: "tool_result" }, { type: "thinking" }];
    expect(extractText(blocks)).toBe("");
  });

  it("returns empty string for an empty array", () => {
    expect(extractText([])).toBe("");
  });
});

// ---------------------------------------------------------------------------
// summarizeSession
// ---------------------------------------------------------------------------

/** Helper to create a minimal user message line */
function userLine(
  overrides: Partial<RawSessionLine> = {}
): RawSessionLine {
  return {
    type: "user",
    uuid: "u1",
    timestamp: "2026-03-31T10:00:00.000Z",
    sessionId: "sess-1",
    cwd: "/Users/bryao/code/test",
    version: "2.1.87",
    entrypoint: "cli",
    message: { role: "user", content: "Fix the bug" },
    ...overrides,
  };
}

/** Helper to create a minimal assistant message line */
function assistantLine(
  overrides: Partial<RawSessionLine> = {}
): RawSessionLine {
  return {
    type: "assistant",
    uuid: "a1",
    parentUuid: "u1",
    timestamp: "2026-03-31T10:00:05.000Z",
    sessionId: "sess-1",
    cwd: "/Users/bryao/code/test",
    version: "2.1.87",
    message: {
      role: "assistant",
      content: [{ type: "text", text: "I fixed the bug." }],
      model: "claude-opus-4-6",
      id: "msg_001",
      usage: {
        input_tokens: 100,
        output_tokens: 50,
        cache_read_input_tokens: 5000,
        cache_creation_input_tokens: 200,
      },
    },
    ...overrides,
  };
}

describe("summarizeSession", () => {
  it("returns null for empty input", () => {
    expect(summarizeSession([], "proj", "/proj")).toBeNull();
  });

  it("returns null when only file-history-snapshot lines exist", () => {
    const lines: RawSessionLine[] = [
      { type: "file-history-snapshot" as const, isSnapshotUpdate: false },
    ];
    expect(summarizeSession(lines, "proj", "/proj")).toBeNull();
  });

  it("summarizes a basic user+assistant exchange", () => {
    const lines = [userLine(), assistantLine()];
    const result = summarizeSession(lines, "-Users-bryao-code-test", "/test");

    expect(result).not.toBeNull();
    expect(result!.sessionId).toBe("sess-1");
    expect(result!.model).toBe("claude-opus-4-6");
    expect(result!.messageCount).toBe(2);
    expect(result!.totalInputTokens).toBe(100);
    expect(result!.totalOutputTokens).toBe(50);
    expect(result!.totalCacheReadTokens).toBe(5000);
    expect(result!.totalCacheCreationTokens).toBe(200);
    expect(result!.firstPrompt).toBe("Fix the bug");
    expect(result!.startedAt).toBe("2026-03-31T10:00:00.000Z");
    expect(result!.lastMessageAt).toBe("2026-03-31T10:00:05.000Z");
  });

  it("deduplicates streaming assistant chunks with the same message ID", () => {
    // Claude Code writes multiple JSONL lines for one streaming response,
    // all sharing the same message.id. We should count them once.
    const chunk1 = assistantLine();
    const chunk2 = assistantLine({
      uuid: "a2",
      timestamp: "2026-03-31T10:00:06.000Z",
    });
    // Both have message.id = "msg_001"

    const lines = [userLine(), chunk1, chunk2];
    const result = summarizeSession(lines, "proj", "/proj");

    expect(result!.messageCount).toBe(2); // 1 user + 1 assistant (deduped)
    expect(result!.totalOutputTokens).toBe(50); // counted once, not twice
  });

  it("skips sidechain messages", () => {
    const sidechainMsg = userLine({
      uuid: "u-side",
      isSidechain: true,
      message: { role: "user", content: "sidechain prompt" },
    });

    const lines = [userLine(), sidechainMsg, assistantLine()];
    const result = summarizeSession(lines, "proj", "/proj");

    expect(result!.messageCount).toBe(2); // sidechain user excluded
    expect(result!.firstPrompt).toBe("Fix the bug"); // not sidechain
  });

  it("skips tool_result-only first messages for firstPrompt", () => {
    const toolResultFirst = userLine({
      uuid: "u0",
      timestamp: "2026-03-31T09:59:00.000Z",
      message: {
        role: "user",
        content: [
          { type: "tool_result", text: "some tool output" },
        ],
      },
    });

    const realPrompt = userLine({
      uuid: "u1",
      timestamp: "2026-03-31T10:00:00.000Z",
      message: { role: "user", content: "Explain the architecture" },
    });

    const lines = [toolResultFirst, realPrompt, assistantLine()];
    const result = summarizeSession(lines, "proj", "/proj");

    expect(result!.firstPrompt).toBe("Explain the architecture");
  });

  it("skips [Request interrupted] messages for firstPrompt", () => {
    const interrupted = userLine({
      uuid: "u0",
      timestamp: "2026-03-31T09:59:00.000Z",
      message: {
        role: "user",
        content: [
          { type: "text", text: "[Request interrupted by user for tool use]" },
        ],
      },
    });

    const realPrompt = userLine({
      uuid: "u1",
      timestamp: "2026-03-31T10:00:00.000Z",
      message: { role: "user", content: "Now fix the tests" },
    });

    const lines = [interrupted, realPrompt, assistantLine()];
    const result = summarizeSession(lines, "proj", "/proj");

    expect(result!.firstPrompt).toBe("Now fix the tests");
  });

  it("aggregates tokens across multiple assistant turns", () => {
    const a1 = assistantLine();
    const a2 = assistantLine({
      uuid: "a2",
      parentUuid: "u2",
      timestamp: "2026-03-31T10:01:00.000Z",
      message: {
        role: "assistant",
        content: [{ type: "text", text: "Done." }],
        model: "claude-opus-4-6",
        id: "msg_002",
        usage: {
          input_tokens: 200,
          output_tokens: 100,
          cache_read_input_tokens: 3000,
          cache_creation_input_tokens: 0,
        },
      },
    });

    const u2 = userLine({
      uuid: "u2",
      timestamp: "2026-03-31T10:00:30.000Z",
      message: { role: "user", content: "Also fix the tests" },
    });

    const lines = [userLine(), a1, u2, a2];
    const result = summarizeSession(lines, "proj", "/proj");

    expect(result!.messageCount).toBe(4);
    expect(result!.totalInputTokens).toBe(300);
    expect(result!.totalOutputTokens).toBe(150);
    expect(result!.totalCacheReadTokens).toBe(8000);
  });

  it("truncates firstPrompt to 200 characters", () => {
    const longPrompt = "x".repeat(500);
    const lines = [
      userLine({ message: { role: "user", content: longPrompt } }),
      assistantLine(),
    ];
    const result = summarizeSession(lines, "proj", "/proj");

    expect(result!.firstPrompt.length).toBe(200);
  });

  it("extracts customTitle from custom-title lines", () => {
    const lines: RawSessionLine[] = [
      userLine(),
      assistantLine(),
      { type: "custom-title" as const, customTitle: "My Project Session", sessionId: "sess-1" },
    ];
    const result = summarizeSession(lines, "proj", "/proj");

    expect(result!.customTitle).toBe("My Project Session");
  });

  it("uses the last custom-title when multiple exist", () => {
    const lines: RawSessionLine[] = [
      userLine(),
      assistantLine(),
      { type: "custom-title" as const, customTitle: "First Name", sessionId: "sess-1" },
      { type: "custom-title" as const, customTitle: "Renamed Session", sessionId: "sess-1" },
    ];
    const result = summarizeSession(lines, "proj", "/proj");

    expect(result!.customTitle).toBe("Renamed Session");
  });

  it("omits customTitle when no custom-title lines exist", () => {
    const lines = [userLine(), assistantLine()];
    const result = summarizeSession(lines, "proj", "/proj");

    expect(result!.customTitle).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// consolidateMessages
// ---------------------------------------------------------------------------

function chatMsg(overrides: Partial<ChatMessage>): ChatMessage {
  return {
    uuid: "m1",
    role: "assistant",
    content: "",
    timestamp: "2026-03-31T10:00:00.000Z",
    ...overrides,
  };
}

describe("consolidateMessages", () => {
  it("merges tool-only assistant message into previous assistant", () => {
    const messages: ChatMessage[] = [
      chatMsg({ uuid: "a1", content: "Here is my plan.", tools: [{ toolUseId: "t1", name: "Edit" }] }),
      chatMsg({ uuid: "a2", content: "", tools: [{ toolUseId: "t2", name: "Edit" }] }),
    ];
    const result = consolidateMessages(messages);

    expect(result.length).toBe(1);
    expect(result[0].content).toBe("Here is my plan.");
    expect(result[0].tools!.length).toBe(2);
    expect(result[0].tools![1].name).toBe("Edit");
  });

  it("merges agent blocks from tool-only messages", () => {
    const messages: ChatMessage[] = [
      chatMsg({ uuid: "a1", content: "Starting work.", agents: [{ toolUseId: "ag1", description: "first", subagentType: "Explore", prompt: "..." }] }),
      chatMsg({ uuid: "a2", content: "", agents: [{ toolUseId: "ag2", description: "second", subagentType: "Explore", prompt: "..." }] }),
    ];
    const result = consolidateMessages(messages);

    expect(result.length).toBe(1);
    expect(result[0].agents!.length).toBe(2);
  });

  it("keeps assistant messages with meaningful text as separate bubbles", () => {
    const messages: ChatMessage[] = [
      chatMsg({ uuid: "a1", content: "First explanation.", tools: [{ toolUseId: "t1", name: "Edit" }] }),
      chatMsg({ uuid: "a2", content: "Now let me update the types:", tools: [{ toolUseId: "t2", name: "Edit" }] }),
    ];
    const result = consolidateMessages(messages);

    expect(result.length).toBe(2);
    expect(result[0].content).toBe("First explanation.");
    expect(result[1].content).toBe("Now let me update the types:");
  });

  it("merges multiple consecutive tool-only messages", () => {
    const messages: ChatMessage[] = [
      chatMsg({ uuid: "a1", content: "Let me fix this.", tools: [{ toolUseId: "t1", name: "Read" }] }),
      chatMsg({ uuid: "a2", content: "", tools: [{ toolUseId: "t2", name: "Edit" }] }),
      chatMsg({ uuid: "a3", content: "", tools: [{ toolUseId: "t3", name: "Edit" }] }),
      chatMsg({ uuid: "a4", content: "", tools: [{ toolUseId: "t4", name: "Bash" }] }),
    ];
    const result = consolidateMessages(messages);

    expect(result.length).toBe(1);
    expect(result[0].tools!.length).toBe(4);
  });

  it("does not merge tool-only message into a user message", () => {
    const messages: ChatMessage[] = [
      chatMsg({ uuid: "u1", role: "user", content: "Fix the bug" }),
      chatMsg({ uuid: "a1", content: "", tools: [{ toolUseId: "t1", name: "Read" }] }),
    ];
    const result = consolidateMessages(messages);

    expect(result.length).toBe(2);
  });

  it("preserves user messages between assistant messages", () => {
    const messages: ChatMessage[] = [
      chatMsg({ uuid: "a1", content: "Done.", tools: [{ toolUseId: "t1", name: "Edit" }] }),
      chatMsg({ uuid: "u1", role: "user", content: "Now fix the tests" }),
      chatMsg({ uuid: "a2", content: "", tools: [{ toolUseId: "t2", name: "Bash" }] }),
    ];
    const result = consolidateMessages(messages);

    // Tool-only a2 cannot merge into a1 because user message breaks the chain
    expect(result.length).toBe(3);
  });

  it("updates timestamp to the latest merged message", () => {
    const messages: ChatMessage[] = [
      chatMsg({ uuid: "a1", content: "Starting.", timestamp: "2026-03-31T10:00:00.000Z" }),
      chatMsg({ uuid: "a2", content: "", tools: [{ toolUseId: "t1", name: "Edit" }], timestamp: "2026-03-31T10:05:00.000Z" }),
    ];
    const result = consolidateMessages(messages);

    expect(result[0].timestamp).toBe("2026-03-31T10:05:00.000Z");
  });
});
