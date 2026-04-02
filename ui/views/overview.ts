import { LitElement, html, nothing } from "lit";
import { customElement, property } from "lit/decorators.js";
import type { OverviewStats, CockpitTab } from "../types.ts";
import { formatTokens, formatRelativeTimeVerbose as formatRelativeTime, formatCost, formatUptime } from "../utils/format.ts";

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

  private _uptimeTimer: ReturnType<typeof setInterval> | undefined;

  override connectedCallback() {
    super.connectedCallback();
    this._uptimeTimer = setInterval(() => this.requestUpdate(), 1000);
  }

  override disconnectedCallback() {
    super.disconnectedCallback();
    clearInterval(this._uptimeTimer);
    this._uptimeTimer = undefined;
  }

  override render() {
    if (!this.stats) {
      return html`
        <section class="ov-cards">
          ${[0, 1, 2, 3, 4, 5].map(
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
    const avgTokens = s.totalSessions > 0 ? Math.round(totalTokens / s.totalSessions) : 0;
    const avgIn = s.totalSessions > 0 ? Math.round(s.totalInputTokens / s.totalSessions) : 0;
    const avgOut = s.totalSessions > 0 ? Math.round(s.totalOutputTokens / s.totalSessions) : 0;

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
        tab: "overview",
        label: "Tokens Used",
        value: formatTokens(totalTokens),
        hint: `${formatTokens(totalWithCache)} incl. cache`,
      },
      {
        kind: "cost",
        tab: "overview",
        label: "Est. Cost",
        value: formatCost(s.estimatedTotalCostUsd),
        hint: "Bedrock pricing",
      },
      {
        kind: "uptime",
        tab: "overview",
        label: "Uptime",
        value: formatUptime(s.gatewayStartedAt),
        hint: "Gateway process",
      },
      {
        kind: "avg-tokens",
        tab: "overview",
        label: "Avg Tokens/Session",
        value: formatTokens(avgTokens),
        hint: `${formatTokens(avgIn)} in / ${formatTokens(avgOut)} out`,
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
