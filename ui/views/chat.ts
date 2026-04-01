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

/** Pre-configured Marked instance for rendering assistant messages */
const md = new Marked({
  gfm: true,
  breaks: false,
});

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

function formatRelativeTime(iso: string): string {
  const diff = Date.now() - new Date(iso).getTime();
  const mins = Math.floor(diff / 60_000);
  if (mins < 1) return "now";
  if (mins < 60) return `${mins}m`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${hours}h`;
  const days = Math.floor(hours / 24);
  return `${days}d`;
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
  @state() private pinnedSessionIds: Set<string> = new Set(
    JSON.parse(localStorage.getItem("pinned-sessions") ?? "[]")
  );

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

  /** Public API: open a specific session (called by app shell) */
  openSession(sessionId: string) {
    this._selectSession(sessionId);
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
        limit: 50,
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
        limit: 30,
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
    this._loadSessionMessages(sessionId);
  }

  private _newSession() {
    this.activeSessionId = null;
    this.messages = [];
    this.streaming = false;
    this.currentChatId = null;
    this.pendingApproval = null;
  }

  private _togglePin(sessionId: string) {
    const pins = new Set(this.pinnedSessionIds);
    if (pins.has(sessionId)) {
      pins.delete(sessionId);
    } else {
      pins.add(sessionId);
    }
    this.pinnedSessionIds = pins;
    localStorage.setItem("pinned-sessions", JSON.stringify([...pins]));
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

    await this.gateway.request("sessions.rename", {
      sessionId,
      title: trimmed,
      projectId: this.projectId || undefined,
    });
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
      { uuid: `u-${Date.now()}`, role: "user", content: prompt, timestamp: new Date().toISOString() },
      { uuid: `a-${Date.now()}`, role: "assistant", content: "", timestamp: new Date().toISOString(), streaming: true },
    ];

    this.inputValue = "";
    this.streaming = true;
    this.currentChatId = `chat-${Date.now()}`;

    try {
      await this.gateway.request(
        "chat.send",
        {
          prompt,
          chatId: this.currentChatId,
          sessionId: this.activeSessionId ?? undefined,
        },
        120_000
      );
    } catch {
      // Handled via events
    }
    this._scrollToBottom();
  }

  private _abort() {
    if (this.currentChatId && this.gateway?.connected) {
      this.gateway
        .request("chat.abort", { chatId: this.currentChatId })
        .catch(() => {});
    }
  }

  // ── Stream event handlers ─────────────────────────────────────────────

  private _onChunk(data: ChunkEvent) {
    if (data.chatId !== this.currentChatId) return;

    if (data.type === "text" && data.content) {
      const msgs = [...this.messages];
      const last = msgs[msgs.length - 1];
      if (last?.role === "assistant" && last.streaming) {
        msgs[msgs.length - 1] = {
          ...last,
          content: last.content + data.content,
        };
        this.messages = msgs;
      }
    } else if (data.type === "tool_use" && data.content) {
      const msgs = [...this.messages];
      const last = msgs[msgs.length - 1];
      if (last?.role === "assistant" && last.streaming) {
        const raw = data.raw as Record<string, unknown> | undefined;
        const input = raw?.input as Record<string, string> | undefined;
        if (data.content === "Agent" || raw?.name === "Agent") {
          if (!last.agents) last.agents = [];
          last.agents.push({
            toolUseId: (raw?.id as string) ?? "",
            description: input?.description ?? "",
            subagentType: input?.subagent_type ?? "",
            prompt: (input?.prompt ?? "").slice(0, 200),
          });
        } else {
          if (!last.tools) last.tools = [];
          last.tools.push({
            toolUseId: (raw?.id as string) ?? "",
            name: data.content,
          });
        }
        msgs[msgs.length - 1] = { ...last };
        this.messages = msgs;
      }
    } else if (data.type === "thinking" && data.content) {
      const msgs = [...this.messages];
      const last = msgs[msgs.length - 1];
      if (last?.role === "assistant" && last.streaming) {
        msgs[msgs.length - 1] = {
          ...last,
          thinking: (last.thinking ?? "") + data.content,
        };
        this.messages = msgs;
      }
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
    return html`
      <div class="chat-layout">
        ${this._renderSidebar()}
        ${this._renderConversation()}
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
                  <div class="empty-state__icon">&#9997;</div>
                  <div class="empty-state__text">
                    ${this.activeSessionId
                      ? "No messages in this session"
                      : "Start a new conversation or select a session"}
                  </div>
                </div>
              `
            : nothing}

          ${this.messages.map((msg) => this._renderMessage(msg))}
        </div>

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
          <pre class="tool-approval__code">${(input.content as string)?.slice(0, 500)}</pre>
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
        ? html`<div class="markdown-body">${unsafeHTML(md.parse(preprocessInsights(msg.content)) as string)}</div>`
        : msg.content.trim()
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
    return html`
      <details class="chat__tool-block">
        <summary class="chat__tool-summary">${tool.name}</summary>
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
