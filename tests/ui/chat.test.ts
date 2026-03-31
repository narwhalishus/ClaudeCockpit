/**
 * UI component tests for the Chat view — markdown rendering.
 *
 * Verifies that assistant messages render markdown as HTML,
 * while user messages stay as plain text.
 */
import { describe, it, expect, beforeEach, vi } from "vitest";

import "../../ui/views/chat.ts";
import type { DashboardChat } from "../../ui/views/chat.ts";

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

describe("dashboard-chat markdown rendering", () => {
  beforeEach(() => {
    document.body.innerHTML = "";
  });

  it("renders assistant markdown as HTML with .markdown-body wrapper", async () => {
    const el = document.createElement("dashboard-chat") as DashboardChat;
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
    const el = document.createElement("dashboard-chat") as DashboardChat;
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
    const el = document.createElement("dashboard-chat") as DashboardChat;
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
    const el = document.createElement("dashboard-chat") as DashboardChat;
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
    const el = document.createElement("dashboard-chat") as DashboardChat;
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
    const el = document.createElement("dashboard-chat") as DashboardChat;
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
    const el = document.createElement("dashboard-chat") as DashboardChat;
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
    const el = document.createElement("dashboard-chat") as DashboardChat;
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
    const el = document.createElement("dashboard-chat") as DashboardChat;
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
    const el = document.createElement("dashboard-chat") as DashboardChat;
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
    const el = document.createElement("dashboard-chat") as DashboardChat;
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

describe("dashboard-chat session titles", () => {
  beforeEach(() => {
    document.body.innerHTML = "";
  });

  it("displays customTitle when available", async () => {
    const el = document.createElement("dashboard-chat") as DashboardChat;
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
    const el = document.createElement("dashboard-chat") as DashboardChat;
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
    const el = document.createElement("dashboard-chat") as DashboardChat;
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
    const el = document.createElement("dashboard-chat") as DashboardChat;
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
