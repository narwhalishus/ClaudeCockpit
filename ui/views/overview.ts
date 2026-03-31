import { LitElement, html, nothing } from "lit";
import { customElement, property } from "lit/decorators.js";
import type { OverviewStats, DashboardTab } from "../types.ts";

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

type StatCard = {
  kind: string;
  tab: DashboardTab;
  label: string;
  value: string;
  hint: string;
};

@customElement("dashboard-overview")
export class DashboardOverview extends LitElement {
  protected override createRenderRoot() {
    return this;
  }

  @property({ type: Object }) stats: OverviewStats | null = null;
  @property({ attribute: false }) onNavigate: (tab: DashboardTab) => void =
    () => {};

  override render() {
    if (!this.stats) {
      return html`
        <section class="ov-cards">
          ${[0, 1, 2, 3].map(
            (i) => html`
              <div class="ov-card" style="cursor:default;animation-delay:${i * 50}ms">
                <span class="skeleton skeleton-line" style="width:60px;height:10px"></span>
                <span class="skeleton skeleton-stat"></span>
                <span class="skeleton skeleton-line skeleton-line--medium" style="height:12px"></span>
              </div>
            `
          )}
        </section>
      `;
    }

    const s = this.stats;
    const totalTokens = s.totalInputTokens + s.totalOutputTokens;
    const totalWithCache = totalTokens + s.totalCacheReadTokens + s.totalCacheCreationTokens;

    const cards: StatCard[] = [
      {
        kind: "sessions",
        tab: "sessions",
        label: "Total Sessions",
        value: String(s.totalSessions),
        hint: `${s.sessionsToday} today`,
      },
      {
        kind: "projects",
        tab: "projects",
        label: "Projects",
        value: String(s.totalProjects),
        hint: "Unique codebases",
      },
      {
        kind: "tokens",
        tab: "usage",
        label: "Tokens Used",
        value: formatTokens(totalTokens),
        hint: `${formatTokens(totalWithCache)} incl. cache`,
      },
      {
        kind: "cache",
        tab: "usage",
        label: "Cache Read",
        value: formatTokens(s.totalCacheReadTokens),
        hint: `${formatTokens(s.totalCacheCreationTokens)} created`,
      },
    ];

    const recent = s.recentSessions.slice(0, 8);

    return html`
      <div class="content-header">
        <div>
          <h1 class="page-title">Overview</h1>
          <p class="page-sub">Your Claude Code activity at a glance</p>
        </div>
      </div>

      <section class="ov-cards">
        ${cards.map(
          (c) => html`
            <button class="ov-card" data-kind=${c.kind} @click=${() => this.onNavigate(c.tab)}>
              <span class="ov-card__label">${c.label}</span>
              <span class="ov-card__value">${c.value}</span>
              <span class="ov-card__hint">${c.hint}</span>
            </button>
          `
        )}
      </section>

      ${recent.length > 0
        ? html`
            <section class="ov-recent">
              <h3 class="ov-recent__title">Recent Sessions</h3>
              <ul class="ov-recent__list">
                ${recent.map(
                  (s) => html`
                    <li class="ov-recent__row">
                      <span class="ov-recent__key" title=${s.firstPrompt}>
                        ${s.firstPrompt || s.sessionId.slice(0, 8)}
                      </span>
                      <span class="ov-recent__model">${s.model || ""}</span>
                      <span class="ov-recent__time">${formatRelativeTime(s.lastMessageAt)}</span>
                    </li>
                  `
                )}
              </ul>
            </section>
          `
        : nothing}
    `;
  }
}
