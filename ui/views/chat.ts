import { LitElement, html, nothing } from "lit";
import { customElement, property, state } from "lit/decorators.js";
import { unsafeHTML } from "lit/directives/unsafe-html.js";
import { Marked } from "marked";
import type {
  GatewayBrowserClient,
} from "../gateway.ts";
import type {
  SessionSummary,
  ChatMessage,
  SessionMessagesResult,
  AgentBlock,
  ToolBlock,
  ToolApprovalEvent,
} from "../types.ts";
import { formatTokens, formatRelativeTime, formatDuration, shortenHomePath } from "../utils/format.ts";
import {
  MODEL_OPTIONS,
  CHAT_REQUEST_TIMEOUT_MS,
  SUMMARY_REQUEST_TIMEOUT_MS,
  SESSION_PAGE_SIZE,
  SESSION_OLDER_PAGE_SIZE,
  WRITE_PREVIEW_MAX_CHARS,
  AGENT_PROMPT_INLINE_PREVIEW,
} from "../constants.ts";

const PINNED_SESSIONS_KEY = "pinned-sessions";

/** Pre-configured Marked instance for rendering assistant messages. */
const md = new Marked({
  gfm: true,
  breaks: false,
});

/** Strip dangerous HTML elements from rendered markdown output to prevent XSS.
 *  Uses a blocklist of elements (script, iframe, etc.) and event handler attributes.
 *  Runs AFTER marked rendering so code blocks and insight blocks are preserved. */
export function sanitizeHtml(html: string): string {
  return html
    .replace(/<script\b[^<]*(?:(?!<\/script>)<[^<]*)*<\/script\s*>/gi, "")
    .replace(/<\/script\s*>/gi, "")
    .replace(/<iframe\b[^<]*(?:(?!<\/iframe>)<[^<]*)*<\/iframe\s*>/gi, "")
    .replace(/<object\b[^<]*(?:(?!<\/object>)<[^<]*)*<\/object\s*>/gi, "")
    .replace(/<embed\b[^>]*\/?>/gi, "")
    .replace(/<style\b[^<]*(?:(?!<\/style>)<[^<]*)*<\/style\s*>/gi, "")
    .replace(/<link\b[^>]*\/?>/gi, "")
    .replace(/<meta\b[^>]*\/?>/gi, "")
    .replace(/<base\b[^>]*\/?>/gi, "")
    .replace(/\s+on\w+\s*=\s*(?:"[^"]*"|'[^']*'|[^\s>]+)/gi, "")
    .replace(/\bhref\s*=\s*["']?\s*javascript\s*:/gi, 'href="');
}

/**
 * Preprocess markdown to convert ★ Insight blocks into HTML callouts
 * before marked parses them. The pattern is backtick-delimited:
 *   `★ Insight ────...`
 *   [content]
 *   `────...`
 */
const INSIGHT_RE = /`★\s*Insight\s*─+`\s*\n([\s\S]*?)\n\s*`─+`/g;

function preprocessInsights(src: string): string {
  return src.replace(INSIGHT_RE, (_match, body: string) => {
    const escapedBody = body.trim();
    return `<div class="chat__insight"><div class="chat__insight-header">★ Insight</div>\n\n${escapedBody}\n\n</div>`;
  });
}

// ── Structured user message rendering ─────────────────────────────────
// Claude Code wraps slash commands in XML tags. Parse them into styled blocks.

interface UserContentSegment {
  type: "text" | "command" | "stdout" | "caveat";
  commandName?: string;
  commandArgs?: string;
  content?: string;
}

const USER_TAG_RE = /<(command-name|command-args|local-command-stdout|local-command-caveat)>([\s\S]*?)<\/\1>/g;

function parseUserContent(text: string): UserContentSegment[] {
  const segments: UserContentSegment[] = [];
  let lastIndex = 0;
  let commandName: string | undefined;
  let commandArgs: string | undefined;

  // First pass: extract tags and interleaved text
  const matches = [...text.matchAll(USER_TAG_RE)];
  for (const m of matches) {
    // Add any plain text before this tag
    if (m.index! > lastIndex) {
      const plain = text.slice(lastIndex, m.index!).trim();
      if (plain) segments.push({ type: "text", content: plain });
    }

    const [, tagName, tagContent] = m;
    switch (tagName) {
      case "command-name":
        commandName = tagContent.trim();
        break;
      case "command-args":
        commandArgs = tagContent.trim();
        break;
      case "local-command-stdout":
        segments.push({ type: "stdout", content: tagContent });
        break;
      case "local-command-caveat":
        segments.push({ type: "caveat", content: tagContent.trim() });
        break;
    }
    lastIndex = m.index! + m[0].length;
  }

  // If we found command-name/args, emit a command segment at the front
  if (commandName) {
    segments.unshift({ type: "command", commandName, commandArgs });
  }

  // Trailing plain text
  if (lastIndex < text.length) {
    const trailing = text.slice(lastIndex).trim();
    if (trailing) segments.push({ type: "text", content: trailing });
  }

  return segments;
}

function renderUserContent(text: string) {
  // Quick path: no XML tags → plain text
  if (!text.includes("<command-name") && !text.includes("<local-command-")) {
    return text.trim();
  }

  const segments = parseUserContent(text);
  if (segments.length === 0) return text.trim();

  return segments.map((seg) => {
    switch (seg.type) {
      case "command":
        return html`<span class="chat__user-command">
          <span class="chat__user-command-name">/${seg.commandName}</span>${seg.commandArgs
            ? html`<span class="chat__user-command-args">${seg.commandArgs}</span>`
            : nothing}
        </span>`;
      case "stdout":
        return html`<pre class="chat__user-stdout">${seg.content}</pre>`;
      case "caveat":
        return html`<span class="chat__user-caveat">${seg.content}</span>`;
      default:
        return html`<span>${seg.content}</span>`;
    }
  });
}

// ── Per-tool visual styling ───────────────────────────────────────────

interface ToolVisual {
  symbol: string;
  color: string;
}

const TOOL_VISUALS: Record<string, ToolVisual> = {
  Bash:          { symbol: "▶", color: "var(--ok)" },
  Read:          { symbol: "□", color: "var(--info)" },
  Write:         { symbol: "✎", color: "var(--warn)" },
  Edit:          { symbol: "✐", color: "var(--warn)" },
  Glob:          { symbol: "✶", color: "var(--accent-2)" },
  Grep:          { symbol: "⌕", color: "var(--accent-2)" },
  WebFetch:      { symbol: "☉", color: "var(--info)" },
  WebSearch:     { symbol: "☉", color: "var(--info)" },
  AskUserQuestion: { symbol: "❓", color: "var(--accent)" },
};

const DEFAULT_TOOL_VISUAL: ToolVisual = { symbol: "✦", color: "var(--muted)" };

function getToolVisual(name: string): ToolVisual {
  return TOOL_VISUALS[name] ?? DEFAULT_TOOL_VISUAL;
}

function groupSessionsByDay(
  sessions: SessionSummary[]
): { label: string; sessions: SessionSummary[] }[] {
  const now = new Date();
  const todayStr = now.toDateString();
  const yesterday = new Date(now);
  yesterday.setDate(yesterday.getDate() - 1);
  const yesterdayStr = yesterday.toDateString();

  const groups = new Map<string, SessionSummary[]>();
  for (const s of sessions) {
    const d = new Date(s.lastMessageAt).toDateString();
    let label: string;
    if (d === todayStr) label = "Today";
    else if (d === yesterdayStr) label = "Yesterday";
    else
      label = new Date(s.lastMessageAt).toLocaleDateString("en-US", {
        month: "short",
        day: "numeric",
      });
    if (!groups.has(label)) groups.set(label, []);
    groups.get(label)!.push(s);
  }
  return Array.from(groups, ([label, sessions]) => ({ label, sessions }));
}

/**
 * Session cockpit — three-panel layout: session sidebar | conversation | detail sidebar.
 *
 * Data flow: setGateway() wires event subscriptions → gateway events update @state
 * properties → Lit re-renders. Key state: `messages` (conversation history),
 * `streaming`/`currentChatId` (active chat), `pendingApproval` (tool approval UI).
 */
@customElement("cockpit-chat")
export class CockpitChat extends LitElement {
  protected override createRenderRoot() {
    return this;
  }

  @property({ type: String }) projectId = "";

  @state() private sessions: SessionSummary[] = [];
  @state() private activeSessionId: string | null = null;
  @state() private messages: ChatMessage[] = [];
  @state() private inputValue = "";
  @state() private streaming = false;
  @state() private currentChatId: string | null = null;
  @state() private pendingApproval: ToolApprovalEvent | null = null;
  @state() private loadingHistory = false;
  @state() private renamingSessionId: string | null = null;
  @state() private hasMoreHistory = false;
  @state() private sidebarOpen = true;
  @state() private detailOpen = false;
  @state() private pinnedSessionIds: Set<string> = new Set(
    (() => { try { return JSON.parse(localStorage.getItem(PINNED_SESSIONS_KEY) ?? "[]"); } catch { return []; } })()
  );
  @state() private summaryContent = "";
  @state() private summarizing = false;
  @state() private summaryVisible = false;
  @state() private selectedModel: string | null = null;

  private gateway: GatewayBrowserClient | null = null;
  private unsubscribers: (() => void)[] = [];

  setGateway(gw: GatewayBrowserClient) {
    if (this.gateway === gw) return;
    this.unsubscribers.forEach((fn) => fn());
    this.unsubscribers = [];
    this.gateway = gw;

    this.unsubscribers.push(
      gw.on("chat.chunk", (data: unknown) =>
        this._onChunk(data as ChunkEvent)
      ),
      gw.on("chat.close", () => this._onClose()),
      gw.on("chat.started", () => {
        this.streaming = true;
      }),
      gw.on("session.titled", (data: unknown) => {
        const { sessionId, title } = data as { sessionId: string; title: string };
        this.sessions = this.sessions.map((s) =>
          s.sessionId === sessionId ? { ...s, customTitle: title } : s
        );
      }),
      gw.on("tool.approval", (data: unknown) => {
        this.pendingApproval = data as ToolApprovalEvent;
      }),
      gw.on("summary.chunk", (data: unknown) => {
        const d = data as { sessionId: string; content: string };
        if (d.sessionId === this.activeSessionId) {
          this.summaryContent += d.content;
        }
      }),
      gw.on("summary.done", (data: unknown) => {
        const d = data as { sessionId: string };
        if (d.sessionId === this.activeSessionId) {
          this.summarizing = false;
        }
      }),
      gw.on("summary.error", (data: unknown) => {
        const d = data as { sessionId: string; message: string };
        if (d.sessionId === this.activeSessionId) {
          this.summarizing = false;
          this.summaryContent = "Failed to generate summary.";
        }
      })
    );

    this._loadSessionList();
  }

  override connectedCallback() {
    super.connectedCallback();
    document.addEventListener("keydown", this._onApprovalKeyDown);
  }

  override disconnectedCallback() {
    super.disconnectedCallback();
    document.removeEventListener("keydown", this._onApprovalKeyDown);
    this.unsubscribers.forEach((fn) => fn());
    this.unsubscribers = [];
  }

  override willUpdate(changed: Map<string, unknown>) {
    if (changed.has("projectId") && this.gateway) {
      this._newSession();
      this._loadSessionList();
    }
  }

  // ── Data loading ──────────────────────────────────────────────────────

  private async _loadSessionList() {
    if (!this.gateway?.connected) return;
    try {
      const result = await this.gateway.request("sessions.list", {
        project: this.projectId || undefined,
      });
      this.sessions = (result as { sessions: SessionSummary[] }).sessions;
    } catch (err) {
      console.error("Failed to load sessions:", err);
    }
  }

  private async _loadSessionMessages(sessionId: string) {
    if (!this.gateway?.connected) return;
    this.loadingHistory = true;
    try {
      const result = (await this.gateway.request("sessions.messages", {
        sessionId,
        projectId: this.projectId || undefined,
        limit: SESSION_PAGE_SIZE,
      })) as SessionMessagesResult;
      this.messages = result.messages;
      this.hasMoreHistory = result.hasMore;
      this.activeSessionId = sessionId;
      this._scrollToBottom();
    } catch (err) {
      console.error("Failed to load messages:", err);
    } finally {
      this.loadingHistory = false;
    }
  }

  private async _loadOlderMessages() {
    if (
      !this.gateway?.connected ||
      !this.activeSessionId ||
      !this.hasMoreHistory ||
      this.loadingHistory
    )
      return;
    this.loadingHistory = true;
    try {
      // First, get total count so we can calculate the right offset
      const peek = (await this.gateway.request("sessions.messages", {
        sessionId: this.activeSessionId,
        projectId: this.projectId || undefined,
        limit: 1,
      })) as SessionMessagesResult;
      const beforeIdx = peek.total - this.messages.length;

      const result = (await this.gateway.request("sessions.messages", {
        sessionId: this.activeSessionId,
        projectId: this.projectId || undefined,
        limit: SESSION_OLDER_PAGE_SIZE,
        beforeIndex: beforeIdx,
      })) as SessionMessagesResult;
      this.messages = [...result.messages, ...this.messages];
      this.hasMoreHistory = result.hasMore;
    } catch (err) {
      console.error("Failed to load older messages:", err);
    } finally {
      this.loadingHistory = false;
    }
  }

  // ── Session actions ───────────────────────────────────────────────────

  private _selectSession(sessionId: string) {
    this.summaryVisible = false;
    this.summaryContent = "";
    this.summarizing = false;
    const session = this.sessions.find((s) => s.sessionId === sessionId);
    this.selectedModel = session?.model ?? null;
    this._loadSessionMessages(sessionId);
  }

  private _newSession() {
    this.activeSessionId = null;
    this.messages = [];
    this.streaming = false;
    this.currentChatId = null;
    this.pendingApproval = null;
    this.summaryVisible = false;
    this.summaryContent = "";
    this.summarizing = false;
    this.selectedModel = null;
  }

  private _togglePin(sessionId: string) {
    const pins = new Set(this.pinnedSessionIds);
    if (pins.has(sessionId)) {
      pins.delete(sessionId);
    } else {
      pins.add(sessionId);
    }
    this.pinnedSessionIds = pins;
    localStorage.setItem(PINNED_SESSIONS_KEY, JSON.stringify([...pins]));
  }

  private _startRename(sessionId: string) {
    this.renamingSessionId = sessionId;
    // Focus the input after Lit re-renders
    this.updateComplete.then(() => {
      const input = this.querySelector(`.chat__rename-input[data-session="${sessionId}"]`) as HTMLInputElement | null;
      input?.focus();
      input?.select();
    });
  }

  private async _commitRename(sessionId: string, title: string) {
    this.renamingSessionId = null;
    const trimmed = title.trim().slice(0, 100);
    if (!trimmed || !this.gateway?.connected) return;

    // Optimistic update
    this.sessions = this.sessions.map((s) =>
      s.sessionId === sessionId ? { ...s, customTitle: trimmed } : s
    );

    this.gateway.request("sessions.rename", {
      sessionId,
      title: trimmed,
      projectId: this.projectId || undefined,
    }).catch((err: unknown) => console.error("Rename failed:", err));
  }

  private _onRenameKeyDown(e: KeyboardEvent, sessionId: string) {
    if (e.key === "Enter") {
      e.preventDefault();
      this._commitRename(sessionId, (e.target as HTMLInputElement).value);
    } else if (e.key === "Escape") {
      this.renamingSessionId = null;
    }
  }

  // ── Tool approval ─────────────────────────────────────────────────────

  private async _approveToolUse() {
    if (!this.pendingApproval || !this.gateway?.connected) return;
    await this.gateway.request("tool.respond", {
      chatId: this.pendingApproval.chatId,
      requestId: this.pendingApproval.request_id,
      behavior: "allow",
    });
    this.pendingApproval = null;
  }

  private async _denyToolUse() {
    if (!this.pendingApproval || !this.gateway?.connected) return;
    await this.gateway.request("tool.respond", {
      chatId: this.pendingApproval.chatId,
      requestId: this.pendingApproval.request_id,
      behavior: "deny",
      message: "User denied tool use",
    });
    this.pendingApproval = null;
  }

  private _onApprovalKeyDown = (e: KeyboardEvent) => {
    if (!this.pendingApproval) return;
    const tag = (e.target as HTMLElement)?.tagName;
    if (tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT") return;
    if (e.key === "y" || e.key === "Y") {
      e.preventDefault();
      this._approveToolUse();
    } else if (e.key === "n" || e.key === "N" || e.key === "Escape") {
      e.preventDefault();
      this._denyToolUse();
    }
  };

  // ── Chat sending ──────────────────────────────────────────────────────

  private async _send() {
    const prompt = this.inputValue.trim();
    if (!prompt || !this.gateway?.connected) return;

    this.messages = [
      ...this.messages,
      { uuid: crypto.randomUUID(), role: "user", content: prompt, timestamp: new Date().toISOString() },
      { uuid: crypto.randomUUID(), role: "assistant", content: "", timestamp: new Date().toISOString(), streaming: true },
    ];

    this.inputValue = "";
    this.streaming = true;
    this.currentChatId = crypto.randomUUID();

    // Decode projectId to a real path so claude spawns in the right cwd
    const cwd = this.projectId
      ? this.projectId.replace(/-/g, "/")
      : undefined;

    const model = this.activeSessionId
      ? undefined
      : (this.selectedModel ?? this._getDefaultModel() ?? undefined);

    try {
      await this.gateway.request(
        "chat.send",
        {
          prompt,
          chatId: this.currentChatId,
          sessionId: this.activeSessionId ?? undefined,
          cwd,
          model,
        },
        CHAT_REQUEST_TIMEOUT_MS
      );
    } catch {
      /* Request lifecycle handled by chat.close/chat.error events */
    }
    this._scrollToBottom();
  }

  private _abort() {
    if (this.currentChatId && this.gateway?.connected) {
      this.gateway
        .request("chat.abort", { chatId: this.currentChatId })
        .catch((err: unknown) => console.error("Abort failed:", err));
    }
  }

  private _getDefaultModel(): string | null {
    try {
      const raw = localStorage.getItem("cockpit-settings");
      if (raw) {
        const settings = JSON.parse(raw);
        return settings.defaultModel || null;
      }
    } catch { /* localStorage may be unavailable in tests */ }
    return null;
  }

  // ── Session summary ────────────────────────────────────────────────────

  private async _requestSummary() {
    if (!this.activeSessionId || !this.gateway?.connected || this.summarizing) return;

    this.summaryContent = "";
    this.summarizing = true;
    this.summaryVisible = true;

    try {
      await this.gateway.request(
        "sessions.summarize",
        {
          sessionId: this.activeSessionId,
          projectId: this.projectId || undefined,
        },
        SUMMARY_REQUEST_TIMEOUT_MS
      );
    } catch {
      /* Request lifecycle handled by summary.error/summary.done events */
    }
  }

  private _dismissSummary() {
    this.summaryVisible = false;
    this.summaryContent = "";
    this.summarizing = false;
  }

  // ── Stream event handlers ─────────────────────────────────────────────

  private _updateLastStreamingMessage(patch: Partial<ChatMessage>) {
    const msgs = [...this.messages];
    const last = msgs[msgs.length - 1];
    if (last?.role === "assistant" && last.streaming) {
      msgs[msgs.length - 1] = { ...last, ...patch };
      this.messages = msgs;
    }
  }

  private _onChunk(data: ChunkEvent) {
    if (data.chatId !== this.currentChatId) return;

    const last = this.messages[this.messages.length - 1];
    if (!last?.streaming || last.role !== "assistant") return;

    if (data.type === "text" && data.content) {
      this._updateLastStreamingMessage({ content: last.content + data.content });
    } else if (data.type === "tool_use" && data.content) {
      const raw = data.raw as Record<string, unknown> | undefined;
      const input = raw?.input as Record<string, string> | undefined;
      if (data.content === "Agent" || raw?.name === "Agent") {
        this._updateLastStreamingMessage({
          agents: [
            ...(last.agents ?? []),
            {
              toolUseId: (raw?.id as string) ?? "",
              description: input?.description ?? "",
              subagentType: input?.subagent_type ?? "",
              prompt: (input?.prompt ?? "").slice(0, AGENT_PROMPT_INLINE_PREVIEW),
            },
          ],
        });
      } else {
        this._updateLastStreamingMessage({
          tools: [
            ...(last.tools ?? []),
            {
              toolUseId: (raw?.id as string) ?? "",
              name: data.content,
            },
          ],
        });
      }
    } else if (data.type === "thinking" && data.content) {
      this._updateLastStreamingMessage({ thinking: (last.thinking ?? "") + data.content });
    }
    this._scrollToBottom();
  }

  private _onClose() {
    this.streaming = false;
    this.pendingApproval = null;
    const msgs = [...this.messages];
    const last = msgs[msgs.length - 1];
    if (last?.role === "assistant" && last.streaming) {
      msgs[msgs.length - 1] = { ...last, streaming: false };
      this.messages = msgs;
    }
    // Reload session list to pick up the new session
    this._loadSessionList();
  }

  private _onKeyDown(e: KeyboardEvent) {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      this._send();
    }
  }

  private _scrollToBottom() {
    requestAnimationFrame(() => {
      const el = this.querySelector(".chat__conversation");
      if (el) el.scrollTop = el.scrollHeight;
    });
  }

  // ── Render ────────────────────────────────────────────────────────────

  override render() {
    const classes = [
      "chat-layout",
      this.sidebarOpen ? "" : "chat-layout--sidebar-collapsed",
      this.detailOpen && this.activeSessionId ? "chat-layout--with-detail" : "",
    ].filter(Boolean).join(" ");

    return html`
      <div class=${classes}>
        ${this.sidebarOpen ? this._renderSidebar() : nothing}
        ${this._renderConversation()}
        ${this.detailOpen && this.activeSessionId ? this._renderDetailSidebar() : nothing}
      </div>
    `;
  }

  private _renderSidebar() {
    const pinned = this.sessions.filter((s) =>
      this.pinnedSessionIds.has(s.sessionId)
    );
    const unpinned = this.sessions.filter(
      (s) => !this.pinnedSessionIds.has(s.sessionId)
    );
    const groups = groupSessionsByDay(unpinned);

    return html`
      <aside class="chat__sidebar">
        <div class="chat__sidebar-header">
          <button class="btn btn--primary chat__new-btn" @click=${this._newSession}>
            + New Session
          </button>
        </div>

        <div class="chat__session-list">
          ${pinned.length > 0
            ? html`
                <div class="chat__session-group">
                  <div class="chat__session-group-label">Pinned</div>
                  ${pinned.map((s) => this._renderSessionItem(s, true))}
                </div>
              `
            : nothing}

          ${groups.map(
            (g) => html`
              <div class="chat__session-group">
                <div class="chat__session-group-label">${g.label}</div>
                ${g.sessions.map((s) => this._renderSessionItem(s, false))}
              </div>
            `
          )}

          ${this.sessions.length === 0
            ? html`<div class="chat__sidebar-empty">No sessions yet</div>`
            : nothing}
        </div>
      </aside>
    `;
  }

  private _renderSessionItem(s: SessionSummary, isPinned: boolean) {
    const active = s.sessionId === this.activeSessionId;
    const isRenaming = this.renamingSessionId === s.sessionId;
    const displayTitle = s.customTitle || s.firstPrompt || s.sessionId.slice(0, 8) + "...";

    return html`
      <div
        class="chat__session-item ${active ? "chat__session-item--active" : ""}"
        @click=${() => this._selectSession(s.sessionId)}
      >
        <div class="chat__session-item-main">
          ${isRenaming
            ? html`<input
                class="chat__rename-input"
                data-session=${s.sessionId}
                type="text"
                maxlength="100"
                .value=${s.customTitle || s.firstPrompt || ""}
                @click=${(e: Event) => e.stopPropagation()}
                @keydown=${(e: KeyboardEvent) => this._onRenameKeyDown(e, s.sessionId)}
                @blur=${(e: FocusEvent) => this._commitRename(s.sessionId, (e.target as HTMLInputElement).value)}
              />`
            : html`<span
                class="chat__session-item-title"
                @dblclick=${(e: Event) => {
                  e.stopPropagation();
                  this._startRename(s.sessionId);
                }}
                title="Double-click to rename"
              >${displayTitle}</span>`}
          <span class="chat__session-item-time">${formatRelativeTime(s.lastMessageAt)}</span>
        </div>
        <div class="chat__session-item-meta">
          <span class="chat__session-item-model">${s.model.replace("claude-", "")}</span>
          <span class="chat__session-item-msgs">${s.messageCount} msgs</span>
          <button
            class="chat__pin-btn ${isPinned || this.pinnedSessionIds.has(s.sessionId) ? "chat__pin-btn--active" : ""}"
            @click=${(e: Event) => {
              e.stopPropagation();
              this._togglePin(s.sessionId);
            }}
            title="${this.pinnedSessionIds.has(s.sessionId) ? "Unpin" : "Pin"}"
          >&#9733;</button>
        </div>
      </div>
    `;
  }

  private _renderConversation() {
    return html`
      <div class="chat__main">
        <div class="chat__toolbar">
          <button
            class="chat__toolbar-btn"
            @click=${() => { this.sidebarOpen = !this.sidebarOpen; }}
            title="${this.sidebarOpen ? "Hide sessions" : "Show sessions"}"
          >
            <svg viewBox="0 0 24 24" width="16" height="16"><path d="M3 12h18M3 6h18M3 18h18"/></svg>
          </button>
          <div class="chat__toolbar-spacer"></div>
          ${this.activeSessionId
            ? html`<button
                class="chat__toolbar-btn"
                @click=${this._requestSummary}
                ?disabled=${this.summarizing || this.streaming}
                title="Catch me up — summarize this session"
              >
                <svg viewBox="0 0 24 24" width="16" height="16"><path d="M14 4l1 3 3 1-3 1-1 3-1-3-3-1 3-1z"/><path d="M5 12l.67 2 2 .67-2 .66L5 17.33l-.67-2-2-.66 2-.67z"/><path d="M18 14l.5 1.5 1.5.5-1.5.5-.5 1.5-.5-1.5L16 16l1.5-.5z"/></svg>
              </button>`
            : nothing}
          ${this.activeSessionId
            ? html`<button
                class="chat__toolbar-btn ${this.detailOpen ? "chat__toolbar-btn--active" : ""}"
                @click=${() => { this.detailOpen = !this.detailOpen; }}
                title="${this.detailOpen ? "Hide session info" : "Show session info"}"
              >
                <svg viewBox="0 0 24 24" width="16" height="16"><circle cx="12" cy="12" r="10"/><path d="M12 16v-4"/><path d="M12 8h.01"/></svg>
              </button>`
            : nothing}
        </div>
        <div class="chat__conversation">
          ${this.hasMoreHistory
            ? html`
                <button
                  class="btn chat__load-more"
                  @click=${this._loadOlderMessages}
                  ?disabled=${this.loadingHistory}
                >
                  ${this.loadingHistory ? "Loading..." : "Load older messages"}
                </button>
              `
            : nothing}

          ${this.loadingHistory && this.messages.length === 0
            ? html`<div class="loading-spinner"></div>`
            : nothing}

          ${this.messages.length === 0 && !this.loadingHistory
            ? html`
                <div class="empty-state">
                  <div class="empty-state__icon empty-state__icon--logo">
                    <svg viewBox="0 0 48 48" width="48" height="48" fill="none">
                      <circle cx="24" cy="24" r="22" stroke="var(--accent)" stroke-width="1.5" opacity="0.3"/>
                      <path d="M24 14c-5.52 0-10 4.48-10 10s4.48 10 10 10 10-4.48 10-10-4.48-10-10-10zm-1 15.5l-4.5-4.5 1.41-1.41L23 26.67l6.09-6.08L30.5 22 23 29.5z" fill="var(--accent)" opacity="0.6"/>
                    </svg>
                  </div>
                  <div class="empty-state__text">
                    ${this.activeSessionId
                      ? "No messages in this session"
                      : "Start a new conversation or select a session"}
                  </div>
                  ${!this.activeSessionId
                    ? html`<div class="empty-state__hint">Type a message below or pick a session from the sidebar</div>`
                    : nothing}
                </div>
              `
            : nothing}

          ${this.messages.map((msg) => this._renderMessage(msg))}
        </div>

        ${this.summaryVisible ? this._renderSummaryCard() : nothing}
        ${this.pendingApproval ? this._renderApprovalBanner() : nothing}

        <div class="chat__input-area">
          ${this.streaming
            ? html`<button class="btn" @click=${this._abort}>Stop</button>`
            : nothing}
          <div class="chat__input-row">
            <textarea
              class="chat__textarea"
              placeholder=${this.activeSessionId
                ? "Continue this session..."
                : "Start a new conversation..."}
              .value=${this.inputValue}
              @input=${(e: InputEvent) => {
                this.inputValue = (e.target as HTMLTextAreaElement).value;
              }}
              @keydown=${this._onKeyDown}
              ?disabled=${this.streaming}
              rows="1"
            ></textarea>
            <button
              class="btn btn--primary chat__send-btn"
              @click=${this._send}
              ?disabled=${this.streaming || !this.inputValue.trim()}
            >
              Send
            </button>
          </div>
        </div>
      </div>
    `;
  }

  private _renderDetailSidebar() {
    const session = this.sessions.find((s) => s.sessionId === this.activeSessionId);
    if (!session) return nothing;

    const displayTitle = session.customTitle || session.firstPrompt || session.sessionId.slice(0, 8) + "...";
    const shortPath = shortenHomePath(session.projectPath);
    const shortCwd = shortenHomePath(session.cwd);

    return html`
      <aside class="chat__detail">
        <div class="chat__detail-header">
          <span class="chat__detail-header-title">Session Info</span>
          <button
            class="chat__toolbar-btn"
            @click=${() => { this.detailOpen = false; }}
            title="Close"
          >
            <svg viewBox="0 0 24 24" width="14" height="14"><path d="M18 6L6 18"/><path d="M6 6l12 12"/></svg>
          </button>
        </div>

        <div class="chat__detail-body">
          <div class="chat__detail-section">
            <div class="chat__detail-title">${displayTitle}</div>
          </div>

          <div class="chat__detail-section">
            <div class="chat__detail-row">
              <span class="chat__detail-label">Model</span>
              <select
                class="chat__detail-select"
                @change=${(e: Event) => {
                  this.selectedModel = (e.target as HTMLSelectElement).value;
                }}
              >
                ${MODEL_OPTIONS.map(
                  (opt) => html`
                    <option value=${opt.value} ?selected=${opt.value === this.selectedModel}>${opt.label}</option>
                  `
                )}
              </select>
            </div>
            <div class="chat__detail-row">
              <span class="chat__detail-label">Messages</span>
              <span class="chat__detail-value">${session.messageCount}</span>
            </div>
            <div class="chat__detail-row">
              <span class="chat__detail-label">Duration</span>
              <span class="chat__detail-value">${formatDuration(session.startedAt, session.lastMessageAt)}</span>
            </div>
          </div>

          <div class="chat__detail-section">
            <div class="chat__detail-section-title">Tokens</div>
            <div class="chat__detail-row">
              <span class="chat__detail-label">Input</span>
              <span class="chat__detail-value chat__detail-value--mono">${formatTokens(session.totalInputTokens)}</span>
            </div>
            <div class="chat__detail-row">
              <span class="chat__detail-label">Output</span>
              <span class="chat__detail-value chat__detail-value--mono">${formatTokens(session.totalOutputTokens)}</span>
            </div>
          </div>

          ${session.totalCacheReadTokens > 0 || session.totalCacheCreationTokens > 0
            ? html`
              <div class="chat__detail-section">
                <div class="chat__detail-section-title">Cache</div>
                <div class="chat__detail-row">
                  <span class="chat__detail-label">Read</span>
                  <span class="chat__detail-value chat__detail-value--mono">${formatTokens(session.totalCacheReadTokens)}</span>
                </div>
                <div class="chat__detail-row">
                  <span class="chat__detail-label">Creation</span>
                  <span class="chat__detail-value chat__detail-value--mono">${formatTokens(session.totalCacheCreationTokens)}</span>
                </div>
              </div>`
            : nothing}

          <div class="chat__detail-section">
            <div class="chat__detail-section-title">Location</div>
            <div class="chat__detail-row">
              <span class="chat__detail-label">Project</span>
              <span class="chat__detail-value chat__detail-value--path" title=${session.projectPath}>${shortPath}</span>
            </div>
            <div class="chat__detail-row">
              <span class="chat__detail-label">CWD</span>
              <span class="chat__detail-value chat__detail-value--path" title=${session.cwd}>${shortCwd}</span>
            </div>
          </div>

          <div class="chat__detail-section chat__detail-section--id">
            <span class="chat__detail-label">Session ID</span>
            <span class="chat__detail-value chat__detail-value--mono chat__detail-value--id">${session.sessionId}</span>
          </div>
        </div>
      </aside>
    `;
  }

  private _renderSummaryCard() {
    const cursor = this.summarizing
      ? html`<span class="chat__cursor"></span>`
      : nothing;

    return html`
      <div class="chat__summary">
        <div class="chat__summary-header">
          <span class="chat__summary-title">Session Summary</span>
          <button
            class="chat__toolbar-btn"
            @click=${this._dismissSummary}
            title="Dismiss"
          >
            <svg viewBox="0 0 24 24" width="14" height="14"><path d="M18 6L6 18"/><path d="M6 6l12 12"/></svg>
          </button>
        </div>
        <div class="chat__summary-body">
          ${this.summaryContent
            ? html`<div class="markdown-body">${unsafeHTML(
                sanitizeHtml(md.parse(this.summaryContent) as string)
              )}</div>`
            : this.summarizing
              ? html`<span class="chat__summary-loading"
                  >Summarizing session...</span
                >`
              : nothing}
          ${cursor}
        </div>
      </div>
    `;
  }

  private _renderApprovalBanner() {
    const req = this.pendingApproval!.request;
    const toolName = req.display_name || req.tool_name;

    return html`
      <div class="tool-approval">
        <div class="tool-approval__header">
          <span class="tool-approval__icon">&#9888;</span>
          <span class="tool-approval__title">Tool Approval Required</span>
        </div>
        <div class="tool-approval__tool-name">${toolName}</div>
        ${req.description
          ? html`<div class="tool-approval__desc">${req.description}</div>`
          : nothing}
        <div class="tool-approval__input">
          ${this._renderToolInput(req.tool_name, req.input)}
        </div>
        <div class="tool-approval__actions">
          <button class="btn tool-approval__deny" @click=${this._denyToolUse}>
            Deny <kbd>N</kbd>
          </button>
          <button class="btn btn--primary tool-approval__allow" @click=${this._approveToolUse}>
            Allow <kbd>Y</kbd>
          </button>
        </div>
      </div>
    `;
  }

  private _renderToolInput(toolName: string, input: Record<string, unknown>) {
    switch (toolName) {
      case "Bash":
        return html`<pre class="tool-approval__code">${input.command as string}</pre>`;
      case "Edit":
        return html`
          <div class="tool-approval__file">${input.file_path as string}</div>
          ${input.old_string
            ? html`<pre class="tool-approval__code tool-approval__code--del">${input.old_string as string}</pre>`
            : nothing}
          ${input.new_string
            ? html`<pre class="tool-approval__code tool-approval__code--add">${input.new_string as string}</pre>`
            : nothing}
        `;
      case "Write":
        return html`
          <div class="tool-approval__file">${input.file_path as string}</div>
          <pre class="tool-approval__code">${(input.content as string)?.slice(0, WRITE_PREVIEW_MAX_CHARS)}</pre>
        `;
      case "Read":
      case "Glob":
      case "Grep":
        return html`<div class="tool-approval__file">${input.file_path ?? input.pattern ?? input.path ?? ""}</div>`;
      default:
        return html`<pre class="tool-approval__code">${JSON.stringify(input, null, 2)}</pre>`;
    }
  }

  private _renderMessage(msg: ChatMessage) {
    const isAssistant = msg.role === "assistant";
    const content = msg.content
      ? isAssistant
        ? html`<div class="markdown-body">${unsafeHTML(sanitizeHtml(md.parse(preprocessInsights(msg.content)) as string))}</div>`
        : renderUserContent(msg.content)
      : msg.streaming
        ? html`<span class="chat__cursor"></span>`
        : "";
    const cursor = msg.streaming && msg.content
      ? html`<span class="chat__cursor"></span>`
      : "";

    return html`
      <div class="chat__msg chat__msg--${msg.role}">
        <div class="chat__msg-role">${msg.role}</div>
        ${msg.thinking
          ? html`
            <details class="chat__thinking-block">
              <summary class="chat__thinking-summary">
                <span class="chat__thinking-label">Thinking</span>
                <span class="chat__thinking-hint">${msg.thinking.length > 200 ? `${Math.ceil(msg.thinking.length / 4)} tokens` : ""}</span>
              </summary>
              <div class="chat__thinking-content">${msg.thinking}</div>
            </details>`
          : nothing}
        <div class="chat__msg-content">${content}${cursor}</div>
        ${msg.agents?.length
          ? msg.agents.map((a) => this._renderAgentBlock(a))
          : nothing}
        ${msg.tools?.length
          ? msg.tools.map((t) => this._renderToolBlock(t))
          : nothing}
      </div>
    `;
  }

  private _renderAgentBlock(agent: AgentBlock) {
    return html`
      <details class="chat__agent-block">
        <summary class="chat__agent-summary">
          <span class="chat__agent-type">${agent.subagentType || "Agent"}</span>
          <span class="chat__agent-desc">${agent.description}</span>
        </summary>
        ${agent.result
          ? html`<div class="chat__agent-result">${agent.result}</div>`
          : html`<div class="chat__agent-result chat__agent-result--pending">Running...</div>`}
      </details>
    `;
  }

  private _renderToolBlock(tool: ToolBlock) {
    const visual = getToolVisual(tool.name);
    return html`
      <details class="chat__tool-block">
        <summary class="chat__tool-summary">
          <span class="chat__tool-type" style="color: ${visual.color}; background: color-mix(in srgb, ${visual.color} 10%, transparent)">${visual.symbol}</span>
          <span class="chat__tool-name">${tool.name}</span>
        </summary>
        ${tool.result
          ? html`<div class="chat__tool-result">${tool.result}</div>`
          : nothing}
      </details>
    `;
  }
}

interface ChunkEvent {
  chatId: string;
  type: string;
  content?: string;
  raw?: unknown;
}
