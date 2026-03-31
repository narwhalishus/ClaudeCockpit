/**
 * UI component tests for the Overview view.
 *
 * Uses Vitest + jsdom to render Lit components and assert DOM structure.
 * Lit components render asynchronously, so we await `updateComplete` after
 * each property change.
 */
import { describe, it, expect, beforeEach, vi } from "vitest";

// Import the component to register the custom element
import "../../ui/views/overview.ts";
import type { DashboardOverview } from "../../ui/views/overview.ts";
import type { OverviewStats } from "../../ui/types.ts";

/** Wait for Lit's async render cycle to complete */
async function renderEl<T extends HTMLElement>(el: T): Promise<T> {
  document.body.appendChild(el);
  await (el as unknown as { updateComplete: Promise<boolean> }).updateComplete;
  return el;
}

function makeStats(overrides: Partial<OverviewStats> = {}): OverviewStats {
  return {
    totalSessions: 32,
    totalProjects: 2,
    totalInputTokens: 5000,
    totalOutputTokens: 25000,
    totalCacheReadTokens: 1_000_000,
    totalCacheCreationTokens: 50_000,
    sessionsToday: 4,
    recentSessions: [
      {
        sessionId: "abc-123",
        projectId: "-Users-bryao-code-test",
        projectPath: "/Users/bryao/code/test",
        cwd: "/Users/bryao/code/test",
        startedAt: "2026-03-31T10:00:00.000Z",
        lastMessageAt: "2026-03-31T12:00:00.000Z",
        messageCount: 10,
        model: "claude-opus-4-6",
        version: "2.1.87",
        totalInputTokens: 500,
        totalOutputTokens: 2000,
        totalCacheReadTokens: 100_000,
        totalCacheCreationTokens: 5000,
        firstPrompt: "Fix the authentication bug",
      },
    ],
    ...overrides,
  };
}

describe("dashboard-overview", () => {
  beforeEach(() => {
    document.body.innerHTML = "";
  });

  it("renders skeleton cards when stats is null", async () => {
    const el = document.createElement(
      "dashboard-overview"
    ) as DashboardOverview;
    el.stats = null;
    await renderEl(el);

    const skeletons = el.querySelectorAll(".skeleton");
    expect(skeletons.length).toBeGreaterThan(0);

    // Should NOT have real stat values
    const values = el.querySelectorAll(".ov-card__value");
    expect(values.length).toBe(0);
  });

  it("renders four stat cards when stats are provided", async () => {
    const el = document.createElement(
      "dashboard-overview"
    ) as DashboardOverview;
    el.stats = makeStats();
    await renderEl(el);

    const cards = el.querySelectorAll(".ov-card");
    expect(cards.length).toBe(4);

    // Check labels
    const labels = Array.from(el.querySelectorAll(".ov-card__label")).map(
      (l) => l.textContent
    );
    expect(labels).toContain("Total Sessions");
    expect(labels).toContain("Projects");
    expect(labels).toContain("Tokens Used");
    expect(labels).toContain("Cache Read");
  });

  it("displays correct values from stats", async () => {
    const el = document.createElement(
      "dashboard-overview"
    ) as DashboardOverview;
    el.stats = makeStats();
    await renderEl(el);

    const values = Array.from(el.querySelectorAll(".ov-card__value")).map(
      (v) => v.textContent?.trim()
    );

    expect(values).toContain("32"); // totalSessions
    expect(values).toContain("2"); // totalProjects
    expect(values).toContain("30.0K"); // 5000 + 25000 = 30K tokens
    expect(values).toContain("1.0M"); // 1M cache read tokens
  });

  it("renders recent sessions list", async () => {
    const el = document.createElement(
      "dashboard-overview"
    ) as DashboardOverview;
    el.stats = makeStats();
    await renderEl(el);

    const rows = el.querySelectorAll(".ov-recent__row");
    expect(rows.length).toBe(1);

    const key = el.querySelector(".ov-recent__key");
    expect(key?.textContent?.trim()).toBe("Fix the authentication bug");

    const model = el.querySelector(".ov-recent__model");
    expect(model?.textContent?.trim()).toBe("claude-opus-4-6");
  });

  it("hides recent sessions section when list is empty", async () => {
    const el = document.createElement(
      "dashboard-overview"
    ) as DashboardOverview;
    el.stats = makeStats({ recentSessions: [] });
    await renderEl(el);

    const recent = el.querySelector(".ov-recent");
    expect(recent).toBeNull();
  });

  it("calls onNavigate when a stat card is clicked", async () => {
    const el = document.createElement(
      "dashboard-overview"
    ) as DashboardOverview;
    el.stats = makeStats();
    const navigateSpy = vi.fn();
    el.onNavigate = navigateSpy;
    await renderEl(el);

    const sessionsCard = el.querySelector(
      '.ov-card[data-kind="sessions"]'
    ) as HTMLButtonElement;
    sessionsCard.click();

    expect(navigateSpy).toHaveBeenCalledWith("sessions");
  });

  it("formats large token counts with K/M suffixes", async () => {
    const el = document.createElement(
      "dashboard-overview"
    ) as DashboardOverview;
    el.stats = makeStats({
      totalInputTokens: 500_000,
      totalOutputTokens: 1_500_000,
      totalCacheReadTokens: 50_000_000,
    });
    await renderEl(el);

    const values = Array.from(el.querySelectorAll(".ov-card__value")).map(
      (v) => v.textContent?.trim()
    );

    expect(values).toContain("2.0M"); // 500K + 1.5M = 2M tokens
    expect(values).toContain("50.0M"); // 50M cache read
  });
});
