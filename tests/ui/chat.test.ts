/**
 * UI component tests for the Chat view — markdown rendering.
 *
 * Verifies that assistant messages render markdown as HTML,
 * while user messages stay as plain text.
 */
import { describe, it, expect, beforeEach, vi } from "vitest";

import "../../ui/views/chat.ts";
import type { CockpitChat } from "../../ui/views/chat.ts";

/** Wait for Lit's async render cycle to complete */
async function renderEl<T extends HTMLElement>(el: T): Promise<T> {
  document.body.appendChild(el);
  await (el as unknown as { updateComplete: Promise<boolean> }).updateComplete;
  return el;
}

/**
 * Force-set reactive properties on a Lit element and wait for re-render.
 * We use Object.assign to write to @state fields directly, which is how
 * Lit handles internal state in tests (no attribute reflection needed).
 */
async function setProps(el: HTMLElement, props: Record<string, unknown>) {
  Object.assign(el, props);
  await (el as unknown as { updateComplete: Promise<boolean> }).updateComplete;
}

describe("cockpit-chat markdown rendering", () => {
  beforeEach(() => {
    document.body.innerHTML = "";
  });

  it("renders assistant markdown as HTML with .markdown-body wrapper", async () => {
    const el = document.createElement("cockpit-chat") as CockpitChat;
    await renderEl(el);

    await setProps(el, {
      messages: [
        {
          uuid: "a1",
          role: "assistant",
          content: "Hello **world**",
          timestamp: new Date().toISOString(),
        },
      ],
    });

    const markdownBody = el.querySelector(".markdown-body");
    expect(markdownBody).not.toBeNull();
    // marked wraps in <p> and renders **world** as <strong>
    const strong = markdownBody!.querySelector("strong");
    expect(strong).not.toBeNull();
    expect(strong!.textContent).toBe("world");
  });

  it("renders code blocks inside <pre><code>", async () => {
    const el = document.createElement("cockpit-chat") as CockpitChat;
    await renderEl(el);

    await setProps(el, {
      messages: [
        {
          uuid: "a2",
          role: "assistant",
          content: "Here:\n\n```typescript\nconst x = 1;\n```",
          timestamp: new Date().toISOString(),
        },
      ],
    });

    const pre = el.querySelector(".markdown-body pre");
    expect(pre).not.toBeNull();
    const code = pre!.querySelector("code");
    expect(code).not.toBeNull();
    expect(code!.textContent).toContain("const x = 1;");
  });

  it("renders user messages as plain text without markdown-body", async () => {
    const el = document.createElement("cockpit-chat") as CockpitChat;
    await renderEl(el);

    await setProps(el, {
      messages: [
        {
          uuid: "u1",
          role: "user",
          content: "Fix the **bug**",
          timestamp: new Date().toISOString(),
        },
      ],
    });

    // User messages should NOT have markdown-body
    const markdownBody = el.querySelector(".markdown-body");
    expect(markdownBody).toBeNull();

    // Should render as plain text (the raw markdown characters visible)
    const msgContent = el.querySelector(".chat__msg--user .chat__msg-content");
    expect(msgContent).not.toBeNull();
    expect(msgContent!.textContent).toContain("**bug**");
  });

  it("renders lists as <ul>/<li>", async () => {
    const el = document.createElement("cockpit-chat") as CockpitChat;
    await renderEl(el);

    await setProps(el, {
      messages: [
        {
          uuid: "a3",
          role: "assistant",
          content: "Steps:\n\n- First\n- Second\n- Third",
          timestamp: new Date().toISOString(),
        },
      ],
    });

    const ul = el.querySelector(".markdown-body ul");
    expect(ul).not.toBeNull();
    const items = ul!.querySelectorAll("li");
    expect(items.length).toBe(3);
    expect(items[0].textContent).toContain("First");
  });

  it("renders inline code with <code> tags", async () => {
    const el = document.createElement("cockpit-chat") as CockpitChat;
    await renderEl(el);

    await setProps(el, {
      messages: [
        {
          uuid: "a4",
          role: "assistant",
          content: "Run `npm test` to verify.",
          timestamp: new Date().toISOString(),
        },
      ],
    });

    const code = el.querySelector(".markdown-body code");
    expect(code).not.toBeNull();
    expect(code!.textContent).toBe("npm test");
  });

  it("shows cursor when streaming with no content yet", async () => {
    const el = document.createElement("cockpit-chat") as CockpitChat;
    await renderEl(el);

    await setProps(el, {
      messages: [
        {
          uuid: "a5",
          role: "assistant",
          content: "",
          timestamp: new Date().toISOString(),
          streaming: true,
        },
      ],
    });

    const cursor = el.querySelector(".chat__cursor");
    expect(cursor).not.toBeNull();
  });

  it("shows cursor after markdown content while streaming", async () => {
    const el = document.createElement("cockpit-chat") as CockpitChat;
    await renderEl(el);

    await setProps(el, {
      messages: [
        {
          uuid: "a6",
          role: "assistant",
          content: "Working on it...",
          timestamp: new Date().toISOString(),
          streaming: true,
        },
      ],
    });

    // Should have both markdown content and cursor
    const markdownBody = el.querySelector(".markdown-body");
    expect(markdownBody).not.toBeNull();
    const cursor = el.querySelector(".chat__cursor");
    expect(cursor).not.toBeNull();
  });

  it("renders ★ Insight blocks as styled callout cards", async () => {
    const el = document.createElement("cockpit-chat") as CockpitChat;
    await renderEl(el);

    const insightMarkdown = [
      "Some text before.",
      "",
      "`★ Insight ─────────────────────────────────────`",
      "**Key point one** — details here",
      "**Key point two** — more details",
      "`─────────────────────────────────────────────────`",
      "",
      "Some text after.",
    ].join("\n");

    await setProps(el, {
      messages: [
        {
          uuid: "a-insight",
          role: "assistant",
          content: insightMarkdown,
          timestamp: new Date().toISOString(),
        },
      ],
    });

    const insight = el.querySelector(".chat__insight");
    expect(insight).not.toBeNull();

    const header = el.querySelector(".chat__insight-header");
    expect(header!.textContent).toContain("Insight");

    // The body should contain the bold points as markdown-rendered HTML
    const strong = insight!.querySelector("strong");
    expect(strong).not.toBeNull();
  });

  it("renders thinking block as collapsed <details> when present", async () => {
    const el = document.createElement("cockpit-chat") as CockpitChat;
    await renderEl(el);

    await setProps(el, {
      messages: [
        {
          uuid: "a7",
          role: "assistant",
          content: "Here is my answer.",
          thinking: "Let me reason through this step by step...",
          timestamp: new Date().toISOString(),
        },
      ],
    });

    const thinkingBlock = el.querySelector(".chat__thinking-block") as HTMLDetailsElement;
    expect(thinkingBlock).not.toBeNull();
    // Should be collapsed by default (no open attribute)
    expect(thinkingBlock!.open).toBe(false);

    const label = el.querySelector(".chat__thinking-label");
    expect(label).not.toBeNull();
    expect(label!.textContent).toBe("Thinking");

    const content = el.querySelector(".chat__thinking-content");
    expect(content!.textContent).toContain("step by step");
  });

  it("does not render thinking block when thinking is absent", async () => {
    const el = document.createElement("cockpit-chat") as CockpitChat;
    await renderEl(el);

    await setProps(el, {
      messages: [
        {
          uuid: "a8",
          role: "assistant",
          content: "Quick answer.",
          timestamp: new Date().toISOString(),
        },
      ],
    });

    const thinkingBlock = el.querySelector(".chat__thinking-block");
    expect(thinkingBlock).toBeNull();
  });

  it("renders thinking block before the main content", async () => {
    const el = document.createElement("cockpit-chat") as CockpitChat;
    await renderEl(el);

    await setProps(el, {
      messages: [
        {
          uuid: "a9",
          role: "assistant",
          content: "The answer is 42.",
          thinking: "Computing...",
          timestamp: new Date().toISOString(),
        },
      ],
    });

    const msg = el.querySelector(".chat__msg--assistant")!;
    const children = Array.from(msg.children);
    const thinkingIdx = children.findIndex((c) =>
      c.classList.contains("chat__thinking-block")
    );
    const contentIdx = children.findIndex((c) =>
      c.classList.contains("chat__msg-content")
    );
    // Thinking should appear before content
    expect(thinkingIdx).toBeLessThan(contentIdx);
  });
});

// ---------------------------------------------------------------------------
// Session title display + rename
// ---------------------------------------------------------------------------

describe("cockpit-chat session titles", () => {
  beforeEach(() => {
    document.body.innerHTML = "";
  });

  it("displays customTitle when available", async () => {
    const el = document.createElement("cockpit-chat") as CockpitChat;
    await renderEl(el);

    await setProps(el, {
      sessions: [
        {
          sessionId: "s1",
          projectId: "proj",
          projectPath: "/proj",
          cwd: "/proj",
          startedAt: new Date().toISOString(),
          lastMessageAt: new Date().toISOString(),
          messageCount: 5,
          model: "claude-opus-4-6",
          version: "2.1.87",
          totalInputTokens: 0,
          totalOutputTokens: 0,
          totalCacheReadTokens: 0,
          totalCacheCreationTokens: 0,
          firstPrompt: "Fix the bug in auth",
          customTitle: "Auth Bug Fix",
        },
      ],
    });

    const title = el.querySelector(".chat__session-item-title");
    expect(title).not.toBeNull();
    expect(title!.textContent!.trim()).toBe("Auth Bug Fix");
  });

  it("falls back to firstPrompt when no customTitle", async () => {
    const el = document.createElement("cockpit-chat") as CockpitChat;
    await renderEl(el);

    await setProps(el, {
      sessions: [
        {
          sessionId: "s2",
          projectId: "proj",
          projectPath: "/proj",
          cwd: "/proj",
          startedAt: new Date().toISOString(),
          lastMessageAt: new Date().toISOString(),
          messageCount: 3,
          model: "claude-opus-4-6",
          version: "2.1.87",
          totalInputTokens: 0,
          totalOutputTokens: 0,
          totalCacheReadTokens: 0,
          totalCacheCreationTokens: 0,
          firstPrompt: "Explain the architecture",
        },
      ],
    });

    const title = el.querySelector(".chat__session-item-title");
    expect(title!.textContent!.trim()).toBe("Explain the architecture");
  });

  it("shows rename input on double-click", async () => {
    const el = document.createElement("cockpit-chat") as CockpitChat;
    await renderEl(el);

    await setProps(el, {
      sessions: [
        {
          sessionId: "s3",
          projectId: "proj",
          projectPath: "/proj",
          cwd: "/proj",
          startedAt: new Date().toISOString(),
          lastMessageAt: new Date().toISOString(),
          messageCount: 2,
          model: "claude-opus-4-6",
          version: "2.1.87",
          totalInputTokens: 0,
          totalOutputTokens: 0,
          totalCacheReadTokens: 0,
          totalCacheCreationTokens: 0,
          firstPrompt: "Original title",
        },
      ],
    });

    // Double-click the title
    const title = el.querySelector(".chat__session-item-title") as HTMLElement;
    title.dispatchEvent(new MouseEvent("dblclick", { bubbles: true }));
    await (el as unknown as { updateComplete: Promise<boolean> }).updateComplete;

    // Should show rename input
    const input = el.querySelector(".chat__rename-input") as HTMLInputElement;
    expect(input).not.toBeNull();
    expect(input.value).toBe("Original title");
    expect(input.maxLength).toBe(100);
  });

  it("cancels rename on Escape", async () => {
    const el = document.createElement("cockpit-chat") as CockpitChat;
    await renderEl(el);

    await setProps(el, {
      sessions: [
        {
          sessionId: "s4",
          projectId: "proj",
          projectPath: "/proj",
          cwd: "/proj",
          startedAt: new Date().toISOString(),
          lastMessageAt: new Date().toISOString(),
          messageCount: 2,
          model: "claude-opus-4-6",
          version: "2.1.87",
          totalInputTokens: 0,
          totalOutputTokens: 0,
          totalCacheReadTokens: 0,
          totalCacheCreationTokens: 0,
          firstPrompt: "Keep this name",
        },
      ],
    });

    // Enter rename mode
    const title = el.querySelector(".chat__session-item-title") as HTMLElement;
    title.dispatchEvent(new MouseEvent("dblclick", { bubbles: true }));
    await (el as unknown as { updateComplete: Promise<boolean> }).updateComplete;

    // Press Escape
    const input = el.querySelector(".chat__rename-input") as HTMLInputElement;
    input.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    await (el as unknown as { updateComplete: Promise<boolean> }).updateComplete;

    // Should exit rename mode, show the title span again
    expect(el.querySelector(".chat__rename-input")).toBeNull();
    const restoredTitle = el.querySelector(".chat__session-item-title");
    expect(restoredTitle!.textContent!.trim()).toBe("Keep this name");
  });
});

// ---------------------------------------------------------------------------
// Detail sidebar + collapsible panels
// ---------------------------------------------------------------------------

const MOCK_SESSION = {
  sessionId: "abc-123-def",
  projectId: "proj",
  projectPath: "/Users/bryao/Code/MyProject",
  cwd: "/Users/bryao/Code/MyProject",
  startedAt: new Date(Date.now() - 3600_000).toISOString(),
  lastMessageAt: new Date().toISOString(),
  messageCount: 12,
  model: "claude-opus-4-6",
  version: "2.1.87",
  totalInputTokens: 45_200,
  totalOutputTokens: 12_800,
  totalCacheReadTokens: 30_000,
  totalCacheCreationTokens: 5_000,
  firstPrompt: "Fix the auth bug",
};

describe("cockpit-chat detail sidebar", () => {
  beforeEach(() => {
    document.body.innerHTML = "";
  });

  it("does not render detail sidebar when no session is active", async () => {
    const el = document.createElement("cockpit-chat") as CockpitChat;
    await renderEl(el);

    await setProps(el, { sessions: [MOCK_SESSION], detailOpen: true });

    const detail = el.querySelector(".chat__detail");
    expect(detail).toBeNull();
  });

  it("renders detail sidebar when detailOpen and activeSessionId are set", async () => {
    const el = document.createElement("cockpit-chat") as CockpitChat;
    await renderEl(el);

    await setProps(el, {
      sessions: [MOCK_SESSION],
      activeSessionId: "abc-123-def",
      detailOpen: true,
    });

    const detail = el.querySelector(".chat__detail");
    expect(detail).not.toBeNull();
    expect(el.querySelector(".chat-layout")!.classList.contains("chat-layout--with-detail")).toBe(true);
  });

  it("shows correct model selector and token values", async () => {
    const el = document.createElement("cockpit-chat") as CockpitChat;
    await renderEl(el);

    await setProps(el, {
      sessions: [MOCK_SESSION],
      activeSessionId: "abc-123-def",
      detailOpen: true,
      selectedModel: "claude-opus-4-6",
    });

    // Model is now a <select>, not a text span
    const select = el.querySelector(".chat__detail-select") as HTMLSelectElement;
    expect(select).not.toBeNull();
    expect(select.querySelector("option[selected]")!.textContent!.trim()).toBe("Opus 4.6");

    // Token values still in .chat__detail-value spans
    const values = Array.from(el.querySelectorAll(".chat__detail-value")).map(
      (v) => v.textContent!.trim()
    );
    // Tokens: 45200 -> 45.2K, 12800 -> 12.8K
    expect(values).toContain("45.2K");
    expect(values).toContain("12.8K");
  });

  it("shows cache section when cache tokens are present", async () => {
    const el = document.createElement("cockpit-chat") as CockpitChat;
    await renderEl(el);

    await setProps(el, {
      sessions: [MOCK_SESSION],
      activeSessionId: "abc-123-def",
      detailOpen: true,
    });

    const sectionTitles = Array.from(el.querySelectorAll(".chat__detail-section-title")).map(
      (t) => t.textContent!.trim()
    );
    expect(sectionTitles).toContain("Cache");
  });

  it("hides cache section when cache tokens are zero", async () => {
    const el = document.createElement("cockpit-chat") as CockpitChat;
    await renderEl(el);

    await setProps(el, {
      sessions: [{
        ...MOCK_SESSION,
        totalCacheReadTokens: 0,
        totalCacheCreationTokens: 0,
      }],
      activeSessionId: "abc-123-def",
      detailOpen: true,
    });

    const sectionTitles = Array.from(el.querySelectorAll(".chat__detail-section-title")).map(
      (t) => t.textContent!.trim()
    );
    expect(sectionTitles).not.toContain("Cache");
  });
});

// ---------------------------------------------------------------------------
// Model selector in detail sidebar
// ---------------------------------------------------------------------------

describe("cockpit-chat model selector", () => {
  beforeEach(() => {
    document.body.innerHTML = "";
  });

  it("renders model selector with 3 options in detail sidebar", async () => {
    const el = document.createElement("cockpit-chat") as CockpitChat;
    await renderEl(el);

    await setProps(el, {
      sessions: [MOCK_SESSION],
      activeSessionId: "abc-123-def",
      detailOpen: true,
      selectedModel: "claude-opus-4-6",
    });

    const select = el.querySelector(".chat__detail-select") as HTMLSelectElement;
    expect(select).not.toBeNull();
    const options = select.querySelectorAll("option");
    expect(options.length).toBe(3);
    expect(options[0].value).toBe("claude-opus-4-6");
    expect(options[1].value).toBe("claude-sonnet-4-6");
    expect(options[2].value).toBe("claude-haiku-4-5");
  });

  it("reflects session model as selected option", async () => {
    const el = document.createElement("cockpit-chat") as CockpitChat;
    await renderEl(el);

    await setProps(el, {
      sessions: [{ ...MOCK_SESSION, model: "claude-sonnet-4-6" }],
      activeSessionId: "abc-123-def",
      detailOpen: true,
      selectedModel: "claude-sonnet-4-6",
    });

    const select = el.querySelector(".chat__detail-select") as HTMLSelectElement;
    const selectedOption = select.querySelector("option[selected]") as HTMLOptionElement;
    expect(selectedOption).not.toBeNull();
    expect(selectedOption.value).toBe("claude-sonnet-4-6");
  });

  it("changing selector updates selectedModel state", async () => {
    const el = document.createElement("cockpit-chat") as CockpitChat;
    await renderEl(el);

    await setProps(el, {
      sessions: [MOCK_SESSION],
      activeSessionId: "abc-123-def",
      detailOpen: true,
      selectedModel: "claude-opus-4-6",
    });

    const select = el.querySelector(".chat__detail-select") as HTMLSelectElement;
    select.value = "claude-haiku-4-5";
    select.dispatchEvent(new Event("change", { bubbles: true }));
    await (el as unknown as { updateComplete: Promise<boolean> }).updateComplete;

    expect((el as any).selectedModel).toBe("claude-haiku-4-5");
  });
});

describe("cockpit-chat sidebar toggle", () => {
  beforeEach(() => {
    document.body.innerHTML = "";
  });

  it("renders left sidebar by default", async () => {
    const el = document.createElement("cockpit-chat") as CockpitChat;
    await renderEl(el);

    expect(el.querySelector(".chat__sidebar")).not.toBeNull();
  });

  it("hides left sidebar when sidebarOpen is false", async () => {
    const el = document.createElement("cockpit-chat") as CockpitChat;
    await renderEl(el);

    await setProps(el, { sidebarOpen: false });

    expect(el.querySelector(".chat__sidebar")).toBeNull();
    expect(el.querySelector(".chat-layout")!.classList.contains("chat-layout--sidebar-collapsed")).toBe(true);
  });

  it("shows summary + info toggle buttons only when a session is active", async () => {
    const el = document.createElement("cockpit-chat") as CockpitChat;
    await renderEl(el);

    // No session active — should only have the hamburger button
    const buttons = el.querySelectorAll(".chat__toolbar-btn");
    expect(buttons.length).toBe(1);

    // Set active session — adds summary button + info toggle
    await setProps(el, {
      sessions: [MOCK_SESSION],
      activeSessionId: "abc-123-def",
    });

    const buttonsWithSession = el.querySelectorAll(".chat__toolbar-btn");
    expect(buttonsWithSession.length).toBe(3);
  });
});

// ---------------------------------------------------------------------------
// Stream event handlers (_onChunk, _onClose)
// ---------------------------------------------------------------------------

describe("cockpit-chat stream handlers", () => {
  beforeEach(() => {
    document.body.innerHTML = "";
  });

  it("_onChunk text appends to streaming message content", async () => {
    const el = document.createElement("cockpit-chat") as CockpitChat;
    await renderEl(el);

    await setProps(el, {
      currentChatId: "chat-1",
      streaming: true,
      messages: [
        { uuid: "u1", role: "user", content: "hi", timestamp: new Date().toISOString() },
        { uuid: "a1", role: "assistant", content: "Hello", timestamp: new Date().toISOString(), streaming: true },
      ],
    });

    // Call _onChunk directly
    (el as any)._onChunk({ chatId: "chat-1", type: "text", content: " world" });
    await (el as any).updateComplete;

    const lastMsg = (el as any).messages[(el as any).messages.length - 1];
    expect(lastMsg.content).toBe("Hello world");
  });

  it("_onChunk ignores wrong chatId", async () => {
    const el = document.createElement("cockpit-chat") as CockpitChat;
    await renderEl(el);

    await setProps(el, {
      currentChatId: "chat-1",
      streaming: true,
      messages: [
        { uuid: "a1", role: "assistant", content: "Original", timestamp: new Date().toISOString(), streaming: true },
      ],
    });

    (el as any)._onChunk({ chatId: "wrong-id", type: "text", content: " SHOULD NOT APPEAR" });
    await (el as any).updateComplete;

    const lastMsg = (el as any).messages[(el as any).messages.length - 1];
    expect(lastMsg.content).toBe("Original");
  });

  it("_onChunk tool_use adds to tools array", async () => {
    const el = document.createElement("cockpit-chat") as CockpitChat;
    await renderEl(el);

    await setProps(el, {
      currentChatId: "chat-1",
      streaming: true,
      messages: [
        { uuid: "a1", role: "assistant", content: "Working", timestamp: new Date().toISOString(), streaming: true },
      ],
    });

    (el as any)._onChunk({
      chatId: "chat-1",
      type: "tool_use",
      content: "Edit",
      raw: { id: "tool-1", name: "Edit", input: { file_path: "/tmp/a.ts" } },
    });
    await (el as any).updateComplete;

    const lastMsg = (el as any).messages[(el as any).messages.length - 1];
    expect(lastMsg.tools).toHaveLength(1);
    expect(lastMsg.tools[0].name).toBe("Edit");
  });

  it("_onChunk thinking appends to thinking field", async () => {
    const el = document.createElement("cockpit-chat") as CockpitChat;
    await renderEl(el);

    await setProps(el, {
      currentChatId: "chat-1",
      streaming: true,
      messages: [
        { uuid: "a1", role: "assistant", content: "", timestamp: new Date().toISOString(), streaming: true },
      ],
    });

    (el as any)._onChunk({ chatId: "chat-1", type: "thinking", content: "Step 1. " });
    (el as any)._onChunk({ chatId: "chat-1", type: "thinking", content: "Step 2." });
    await (el as any).updateComplete;

    const lastMsg = (el as any).messages[(el as any).messages.length - 1];
    expect(lastMsg.thinking).toBe("Step 1. Step 2.");
  });

  it("_onClose clears streaming state", async () => {
    const el = document.createElement("cockpit-chat") as CockpitChat;
    await renderEl(el);

    await setProps(el, {
      currentChatId: "chat-1",
      streaming: true,
      messages: [
        { uuid: "a1", role: "assistant", content: "Done.", timestamp: new Date().toISOString(), streaming: true },
      ],
    });

    (el as any)._onClose();
    await (el as any).updateComplete;

    expect((el as any).streaming).toBe(false);
    const lastMsg = (el as any).messages[(el as any).messages.length - 1];
    expect(lastMsg.streaming).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Session summary ("Catch me up")
// ---------------------------------------------------------------------------

describe("cockpit-chat session summary", () => {
  beforeEach(() => {
    document.body.innerHTML = "";
  });

  it("does not show summary card by default", async () => {
    const el = document.createElement("cockpit-chat") as CockpitChat;
    await renderEl(el);

    await setProps(el, {
      sessions: [MOCK_SESSION],
      activeSessionId: "abc-123-def",
    });

    expect(el.querySelector(".chat__summary")).toBeNull();
  });

  it("shows summary card when summaryVisible is true", async () => {
    const el = document.createElement("cockpit-chat") as CockpitChat;
    await renderEl(el);

    await setProps(el, {
      sessions: [MOCK_SESSION],
      activeSessionId: "abc-123-def",
      summaryVisible: true,
      summarizing: true,
    });

    const card = el.querySelector(".chat__summary");
    expect(card).not.toBeNull();

    const title = el.querySelector(".chat__summary-title");
    expect(title!.textContent).toContain("Session Summary");

    // Should show loading text when no content yet
    const loading = el.querySelector(".chat__summary-loading");
    expect(loading).not.toBeNull();
    expect(loading!.textContent).toContain("Summarizing");
  });

  it("renders summary content as markdown", async () => {
    const el = document.createElement("cockpit-chat") as CockpitChat;
    await renderEl(el);

    await setProps(el, {
      sessions: [MOCK_SESSION],
      activeSessionId: "abc-123-def",
      summaryVisible: true,
      summarizing: false,
      summaryContent: "- **What:** Fixed the auth bug\n- **Changes:** Updated login.ts\n- **Status:** Complete",
    });

    const card = el.querySelector(".chat__summary");
    expect(card).not.toBeNull();

    // Should render markdown
    const mdBody = card!.querySelector(".markdown-body");
    expect(mdBody).not.toBeNull();

    const strong = mdBody!.querySelector("strong");
    expect(strong).not.toBeNull();

    // Should NOT show loading text
    expect(el.querySelector(".chat__summary-loading")).toBeNull();
    // Should NOT show cursor
    expect(card!.querySelector(".chat__cursor")).toBeNull();
  });

  it("shows streaming cursor while summarizing", async () => {
    const el = document.createElement("cockpit-chat") as CockpitChat;
    await renderEl(el);

    await setProps(el, {
      sessions: [MOCK_SESSION],
      activeSessionId: "abc-123-def",
      summaryVisible: true,
      summarizing: true,
      summaryContent: "- **What:** Partial text",
    });

    const card = el.querySelector(".chat__summary");
    const cursor = card!.querySelector(".chat__cursor");
    expect(cursor).not.toBeNull();
  });

  it("dismisses summary card on close button click", async () => {
    const el = document.createElement("cockpit-chat") as CockpitChat;
    await renderEl(el);

    await setProps(el, {
      sessions: [MOCK_SESSION],
      activeSessionId: "abc-123-def",
      summaryVisible: true,
      summaryContent: "Some summary",
    });

    expect(el.querySelector(".chat__summary")).not.toBeNull();

    // Click the dismiss button (inside summary header)
    const dismissBtn = el.querySelector(".chat__summary-header .chat__toolbar-btn") as HTMLElement;
    dismissBtn.click();
    await (el as unknown as { updateComplete: Promise<boolean> }).updateComplete;

    expect(el.querySelector(".chat__summary")).toBeNull();
  });
});
