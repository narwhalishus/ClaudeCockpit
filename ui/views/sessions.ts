import { LitElement, html, nothing } from "lit";
import { customElement, property, state } from "lit/decorators.js";
import type { SessionSummary, SortState, SortDir, CockpitTab } from "../types.ts";

function formatTokens(n: number): string {
  if (n >= 1_000_000) return (n / 1_000_000).toFixed(1) + "M";
  if (n >= 1_000) return (n / 1_000).toFixed(1) + "K";
  return String(n);
}

function formatRelativeTime(iso: string): string {
  const diff = Date.now() - new Date(iso).getTime();
  const mins = Math.floor(diff / 60_000);
  if (mins < 1) return "just now";
  if (mins < 60) return `${mins}m ago`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  return `${days}d ago`;
}

function formatDate(iso: string): string {
  return new Date(iso).toLocaleDateString("en-US", {
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
}

type Column = {
  key: string;
  label: string;
  sortable: boolean;
};

const COLUMNS: Column[] = [
  { key: "firstPrompt", label: "Prompt", sortable: false },
  { key: "projectPath", label: "Project", sortable: true },
  { key: "model", label: "Model", sortable: true },
  { key: "messageCount", label: "Messages", sortable: true },
  { key: "totalOutputTokens", label: "Tokens Out", sortable: true },
  { key: "lastMessageAt", label: "Last Active", sortable: true },
];

@customElement("cockpit-sessions")
export class CockpitSessions extends LitElement {
  protected override createRenderRoot() {
    return this;
  }

  @property({ type: Array }) sessions: SessionSummary[] = [];
  @property({ type: String }) projectId = "";
  @property({ attribute: false }) onOpenSession: (sessionId: string) => void = () => {};
  @state() private sort: SortState = { column: "lastMessageAt", dir: "desc" };
  @state() private filter = "";

  private _toggleSort(col: string) {
    if (this.sort.column === col) {
      this.sort = { column: col, dir: this.sort.dir === "asc" ? "desc" : "asc" };
    } else {
      this.sort = { column: col, dir: "desc" };
    }
  }

  private get _filteredSessions(): SessionSummary[] {
    let rows = this.sessions;

    if (this.filter) {
      const q = this.filter.toLowerCase();
      rows = rows.filter(
        (s) =>
          s.firstPrompt.toLowerCase().includes(q) ||
          s.projectPath.toLowerCase().includes(q) ||
          s.model.toLowerCase().includes(q) ||
          s.sessionId.toLowerCase().includes(q)
      );
    }

    const { column, dir } = this.sort;
    const mult = dir === "asc" ? 1 : -1;

    rows = [...rows].sort((a, b) => {
      const av = (a as unknown as Record<string, unknown>)[column];
      const bv = (b as unknown as Record<string, unknown>)[column];
      if (typeof av === "number" && typeof bv === "number") {
        return (av - bv) * mult;
      }
      return String(av ?? "").localeCompare(String(bv ?? "")) * mult;
    });

    return rows;
  }

  private _sortIndicator(col: string): string {
    if (this.sort.column !== col) return "";
    return this.sort.dir === "asc" ? " ↑" : " ↓";
  }

  override render() {
    const rows = this._filteredSessions;

    return html`
      <div class="filters">
        <input
          class="btn"
          type="text"
          placeholder="Filter sessions..."
          .value=${this.filter}
          @input=${(e: InputEvent) => {
            this.filter = (e.target as HTMLInputElement).value;
          }}
          style="min-width:240px;background:var(--bg-elevated);border-color:var(--border)"
        />
      </div>

      ${rows.length === 0
        ? html`
            <div class="empty-state">
              <div class="empty-state__icon">&#128172;</div>
              <div class="empty-state__text">No sessions found</div>
              <div class="empty-state__hint">
                ${this.filter ? "Try a different search" : "Start a Claude Code session to see data here"}
              </div>
            </div>
          `
        : html`
            <table class="data-table">
              <thead>
                <tr>
                  ${COLUMNS.map(
                    (col) => html`
                      <th
                        class="${this.sort.column === col.key ? "sorted" : ""}"
                        @click=${col.sortable ? () => this._toggleSort(col.key) : nothing}
                        style="${col.sortable ? "cursor:pointer" : "cursor:default"}"
                      >
                        ${col.label}${this._sortIndicator(col.key)}
                      </th>
                    `
                  )}
                </tr>
              </thead>
              <tbody>
                ${rows.map(
                  (s) => html`
                    <tr style="cursor:pointer" @click=${() => this.onOpenSession(s.sessionId)}>
                      <td class="truncate" title=${s.firstPrompt}>
                        ${s.firstPrompt || s.sessionId.slice(0, 8) + "..."}
                      </td>
                      <td class="mono muted">${this._shortProjectPath(s.projectPath)}</td>
                      <td class="mono">${this._shortModel(s.model)}</td>
                      <td>${s.messageCount}</td>
                      <td class="mono">${formatTokens(s.totalOutputTokens)}</td>
                      <td class="muted" title=${formatDate(s.lastMessageAt)}>
                        ${formatRelativeTime(s.lastMessageAt)}
                      </td>
                    </tr>
                  `
                )}
              </tbody>
            </table>
          `}
    `;
  }

  private _shortProjectPath(path: string): string {
    // /Users/bryao/code/foo → ~/code/foo
    return path.replace(/^\/Users\/[^/]+/, "~");
  }

  private _shortModel(model: string): string {
    // claude-opus-4-6 → opus-4-6
    return model.replace("claude-", "").replace("us.anthropic.", "");
  }
}
