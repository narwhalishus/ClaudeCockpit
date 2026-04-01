/**
 * Unit tests for convertToMessages() — the core JSONL-to-ChatMessage transform.
 *
 * Tests streaming dedup, tool result attachment, sidechain filtering,
 * thinking block concatenation, and the consolidation pass.
 */
import { describe, it, expect } from "vitest";
import { convertToMessages } from "../../gateway/services/session-store.ts";
import type { RawSessionLine } from "../../gateway/types.ts";

// ── Helpers (same shape as session-store.test.ts) ─────────────────────────

function userLine(overrides: Partial<RawSessionLine> = {}): RawSessionLine {
  return {
    type: "user",
    uuid: "u1",
    timestamp: "2026-03-31T10:00:00.000Z",
    sessionId: "sess-1",
    cwd: "/Users/bryao/code/test",
    message: { role: "user", content: "Fix the bug" },
    ...overrides,
  };
}

function assistantLine(overrides: Partial<RawSessionLine> = {}): RawSessionLine {
  return {
    type: "assistant",
    uuid: "a1",
    timestamp: "2026-03-31T10:00:05.000Z",
    sessionId: "sess-1",
    message: {
      role: "assistant",
      content: [{ type: "text", text: "I fixed the bug." }],
      model: "claude-opus-4-6",
      id: "msg_001",
    },
    ...overrides,
  };
}

// ── Basic flow ────────────────────────────────────────────────────────────

describe("convertToMessages — basic flow", () => {
  it("converts a simple user + assistant exchange", () => {
    const msgs = convertToMessages([userLine(), assistantLine()]);

    expect(msgs).toHaveLength(2);
    expect(msgs[0].role).toBe("user");
    expect(msgs[0].content).toBe("Fix the bug");
    expect(msgs[1].role).toBe("assistant");
    expect(msgs[1].content).toBe("I fixed the bug.");
    expect(msgs[1].model).toBe("claude-opus-4-6");
  });

  it("handles plain string assistant content", () => {
    const msgs = convertToMessages([
      userLine(),
      assistantLine({
        message: {
          role: "assistant",
          content: "Plain string response",
          model: "claude-opus-4-6",
          id: "msg_002",
        },
      }),
    ]);

    expect(msgs[1].content).toBe("Plain string response");
  });
});

// ── Streaming chunk deduplication ─────────────────────────────────────────

describe("convertToMessages — streaming dedup", () => {
  it("collapses chunks with the same message ID into one message", () => {
    const chunk1 = assistantLine({
      uuid: "a1",
      timestamp: "2026-03-31T10:00:05.000Z",
      message: {
        role: "assistant",
        content: [{ type: "text", text: "Hello" }],
        model: "claude-opus-4-6",
        id: "msg_001",
      },
    });
    const chunk2 = assistantLine({
      uuid: "a2",
      timestamp: "2026-03-31T10:00:06.000Z",
      message: {
        role: "assistant",
        content: [{ type: "text", text: " world" }],
        model: "claude-opus-4-6",
        id: "msg_001",
      },
    });

    const msgs = convertToMessages([userLine(), chunk1, chunk2]);

    expect(msgs).toHaveLength(2);
    expect(msgs[1].content).toBe("Hello world");
  });

  it("does not duplicate text when chunk repeats existing content (endsWith guard)", () => {
    const chunk1 = assistantLine({
      message: {
        role: "assistant",
        content: [{ type: "text", text: "Hello world" }],
        id: "msg_001",
      },
    });
    // Second chunk sends the full text again (as streaming sometimes does)
    const chunk2 = assistantLine({
      uuid: "a2",
      timestamp: "2026-03-31T10:00:06.000Z",
      message: {
        role: "assistant",
        content: [{ type: "text", text: "Hello world" }],
        id: "msg_001",
      },
    });

    const msgs = convertToMessages([userLine(), chunk1, chunk2]);

    expect(msgs[1].content).toBe("Hello world");
  });

  it("updates timestamp to latest chunk on merge", () => {
    const chunk1 = assistantLine({
      timestamp: "2026-03-31T10:00:05.000Z",
      message: {
        role: "assistant",
        content: [{ type: "text", text: "Start" }],
        id: "msg_001",
      },
    });
    const chunk2 = assistantLine({
      uuid: "a2",
      timestamp: "2026-03-31T10:00:10.000Z",
      message: {
        role: "assistant",
        content: [{ type: "text", text: " end" }],
        id: "msg_001",
      },
    });

    const msgs = convertToMessages([userLine(), chunk1, chunk2]);

    expect(msgs[1].timestamp).toBe("2026-03-31T10:00:10.000Z");
  });
});

// ── Tool and Agent block extraction ───────────────────────────────────────

describe("convertToMessages — tool/agent blocks", () => {
  it("extracts tool_use blocks into tools array on new message", () => {
    const msgs = convertToMessages([
      userLine(),
      assistantLine({
        message: {
          role: "assistant",
          content: [
            { type: "text", text: "Let me read that." },
            { type: "tool_use", name: "Read", id: "tool_001", input: { file_path: "/tmp/test.ts" } },
          ],
          id: "msg_001",
        },
      }),
    ]);

    expect(msgs[1].tools).toHaveLength(1);
    expect(msgs[1].tools![0].name).toBe("Read");
    expect(msgs[1].tools![0].toolUseId).toBe("tool_001");
  });

  it("extracts Agent blocks into agents array", () => {
    const msgs = convertToMessages([
      userLine(),
      assistantLine({
        message: {
          role: "assistant",
          content: [
            { type: "text", text: "Launching agent." },
            {
              type: "tool_use",
              name: "Agent",
              id: "agent_001",
              input: { description: "search code", subagent_type: "Explore", prompt: "Find all tests" },
            },
          ],
          id: "msg_001",
        },
      }),
    ]);

    expect(msgs[1].agents).toHaveLength(1);
    expect(msgs[1].agents![0].subagentType).toBe("Explore");
    expect(msgs[1].agents![0].description).toBe("search code");
    expect(msgs[1].tools).toBeUndefined();
  });

  it("extracts tool_use blocks from streaming chunk merge", () => {
    const chunk1 = assistantLine({
      message: {
        role: "assistant",
        content: [{ type: "text", text: "Working..." }],
        id: "msg_001",
      },
    });
    const chunk2 = assistantLine({
      uuid: "a2",
      timestamp: "2026-03-31T10:00:06.000Z",
      message: {
        role: "assistant",
        content: [
          { type: "tool_use", name: "Bash", id: "tool_002", input: { command: "npm test" } },
        ],
        id: "msg_001",
      },
    });

    const msgs = convertToMessages([userLine(), chunk1, chunk2]);

    expect(msgs[1].tools).toHaveLength(1);
    expect(msgs[1].tools![0].name).toBe("Bash");
  });
});

// ── Tool result attachment ────────────────────────────────────────────────

describe("convertToMessages — tool result attachment", () => {
  it("attaches tool_result to parent assistant tool block", () => {
    const msgs = convertToMessages([
      userLine(),
      assistantLine({
        message: {
          role: "assistant",
          content: [
            { type: "text", text: "Reading file." },
            { type: "tool_use", name: "Read", id: "tool_001", input: {} },
          ],
          id: "msg_001",
        },
      }),
      userLine({
        uuid: "u-result",
        timestamp: "2026-03-31T10:00:10.000Z",
        message: {
          role: "user",
          content: [
            { type: "tool_result", tool_use_id: "tool_001", content: "file contents here" },
          ],
        },
      }),
    ]);

    // The tool_result user line should not create a user message
    expect(msgs).toHaveLength(2);
    expect(msgs[1].tools![0].result).toBe("file contents here");
  });

  it("attaches tool_result to parent agent block", () => {
    const msgs = convertToMessages([
      userLine(),
      assistantLine({
        message: {
          role: "assistant",
          content: [
            { type: "text", text: "Searching." },
            {
              type: "tool_use",
              name: "Agent",
              id: "agent_001",
              input: { description: "find", subagent_type: "Explore", prompt: "search" },
            },
          ],
          id: "msg_001",
        },
      }),
      userLine({
        uuid: "u-result",
        timestamp: "2026-03-31T10:00:10.000Z",
        message: {
          role: "user",
          content: [
            { type: "tool_result", tool_use_id: "agent_001", content: "agent finished" },
          ],
        },
      }),
    ]);

    expect(msgs).toHaveLength(2);
    expect(msgs[1].agents![0].result).toBe("agent finished");
  });

  it("truncates tool result to 500 chars", () => {
    const longResult = "x".repeat(1000);
    const msgs = convertToMessages([
      userLine(),
      assistantLine({
        message: {
          role: "assistant",
          content: [
            { type: "tool_use", name: "Read", id: "tool_001", input: {} },
          ],
          id: "msg_001",
        },
      }),
      userLine({
        uuid: "u-result",
        timestamp: "2026-03-31T10:00:10.000Z",
        message: {
          role: "user",
          content: [
            { type: "tool_result", tool_use_id: "tool_001", content: longResult },
          ],
        },
      }),
    ]);

    expect(msgs[1].tools![0].result!.length).toBe(500);
  });
});

// ── User messages with mixed content ──────────────────────────────────────

describe("convertToMessages — mixed user content", () => {
  it("creates user message from text block alongside tool_result", () => {
    const msgs = convertToMessages([
      userLine(),
      assistantLine({
        message: {
          role: "assistant",
          content: [
            { type: "tool_use", name: "Read", id: "tool_001", input: {} },
          ],
          id: "msg_001",
        },
      }),
      userLine({
        uuid: "u-mixed",
        timestamp: "2026-03-31T10:00:10.000Z",
        message: {
          role: "user",
          content: [
            { type: "tool_result", tool_use_id: "tool_001", content: "file data" },
            { type: "text", text: "Now fix the types" },
          ],
        },
      }),
    ]);

    // Should have: user, assistant, user (from text block)
    expect(msgs).toHaveLength(3);
    expect(msgs[2].role).toBe("user");
    expect(msgs[2].content).toBe("Now fix the types");
  });

  it("filters [Request interrupted] text blocks", () => {
    const msgs = convertToMessages([
      userLine(),
      assistantLine(),
      userLine({
        uuid: "u-int",
        timestamp: "2026-03-31T10:00:10.000Z",
        message: {
          role: "user",
          content: [
            { type: "text", text: "[Request interrupted by user for tool use]" },
          ],
        },
      }),
    ]);

    // The interrupted message should not produce a user message
    expect(msgs).toHaveLength(2);
  });
});

// ── Filtering ─────────────────────────────────────────────────────────────

describe("convertToMessages — filtering", () => {
  it("skips sidechain lines", () => {
    const msgs = convertToMessages([
      userLine(),
      assistantLine(),
      userLine({
        uuid: "u-side",
        timestamp: "2026-03-31T10:01:00.000Z",
        isSidechain: true,
        message: { role: "user", content: "sidechain prompt" },
      }),
      assistantLine({
        uuid: "a-side",
        timestamp: "2026-03-31T10:01:05.000Z",
        isSidechain: true,
        message: {
          role: "assistant",
          content: [{ type: "text", text: "sidechain reply" }],
          id: "msg_side",
        },
      }),
    ]);

    expect(msgs).toHaveLength(2);
  });

  it("skips lines without timestamp", () => {
    const msgs = convertToMessages([
      userLine(),
      assistantLine({ timestamp: undefined }),
    ]);

    expect(msgs).toHaveLength(1);
    expect(msgs[0].role).toBe("user");
  });

  it("skips non-user/non-assistant line types", () => {
    const msgs = convertToMessages([
      userLine(),
      { type: "file-history-snapshot" as const, isSnapshotUpdate: false },
      { type: "system" as const, subtype: "init", timestamp: "2026-03-31T10:00:01.000Z" },
      assistantLine(),
    ]);

    expect(msgs).toHaveLength(2);
  });
});

// ── Thinking blocks ───────────────────────────────────────────────────────

describe("convertToMessages — thinking", () => {
  it("extracts thinking content on new message", () => {
    const msgs = convertToMessages([
      userLine(),
      assistantLine({
        message: {
          role: "assistant",
          content: [
            { type: "thinking", thinking: "Let me think..." },
            { type: "text", text: "The answer is 42." },
          ],
          id: "msg_001",
        },
      }),
    ]);

    expect(msgs[1].thinking).toBe("Let me think...");
    expect(msgs[1].content).toBe("The answer is 42.");
  });

  it("concatenates thinking across streaming chunks", () => {
    const chunk1 = assistantLine({
      message: {
        role: "assistant",
        content: [{ type: "thinking", thinking: "Step 1. " }],
        id: "msg_001",
      },
    });
    const chunk2 = assistantLine({
      uuid: "a2",
      timestamp: "2026-03-31T10:00:06.000Z",
      message: {
        role: "assistant",
        content: [{ type: "thinking", thinking: "Step 2." }],
        id: "msg_001",
      },
    });

    const msgs = convertToMessages([userLine(), chunk1, chunk2]);

    expect(msgs[1].thinking).toBe("Step 1. Step 2.");
  });
});
