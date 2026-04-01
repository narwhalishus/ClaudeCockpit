import { LitElement, html, nothing } from "lit";
import { customElement, property } from "lit/decorators.js";
import type { OverviewStats, CockpitTab } from "../types.ts";
import { formatTokens, formatRelativeTimeVerbose as formatRelativeTime } from "../utils/format.ts";

type StatCard = {
  kind: string;
  tab: CockpitTab;
  label: string;
  value: string;
  hint: string;
};

@customElement("cockpit-overview")
export class CockpitOverview extends LitElement {
  protected override createRenderRoot() {
    return this;
  }

  @property({ type: Object }) stats: OverviewStats | null = null;
  @property({ type: String }) projectId = "";
  @property({ attribute: false }) onNavigate: (tab: CockpitTab) => void =
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
        tab: "chat",
        label: "Total Sessions",
        value: String(s.totalSessions),
        hint: `${s.sessionsToday} today`,
      },
      {
        kind: "projects",
        tab: "overview",
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
