/**
 * Unit tests for shared format utilities.
 */
import { describe, it, expect, vi, afterEach } from "vitest";
import {
  formatTokens,
  formatRelativeTime,
  formatRelativeTimeVerbose,
  formatDuration,
} from "../../ui/utils/format.ts";

describe("formatTokens", () => {
  it("formats millions", () => {
    expect(formatTokens(1_500_000)).toBe("1.5M");
    expect(formatTokens(1_000_000)).toBe("1.0M");
  });

  it("formats thousands", () => {
    expect(formatTokens(45_200)).toBe("45.2K");
    expect(formatTokens(1_000)).toBe("1.0K");
  });

  it("returns raw number below 1000", () => {
    expect(formatTokens(999)).toBe("999");
    expect(formatTokens(0)).toBe("0");
  });
});

describe("formatRelativeTime (compact)", () => {
  afterEach(() => { vi.useRealTimers(); });

  it("returns 'now' for < 1 minute", () => {
    vi.useFakeTimers({ now: new Date("2026-04-01T12:00:30Z") });
    expect(formatRelativeTime("2026-04-01T12:00:00Z")).toBe("now");
  });

  it("returns minutes", () => {
    vi.useFakeTimers({ now: new Date("2026-04-01T12:05:00Z") });
    expect(formatRelativeTime("2026-04-01T12:00:00Z")).toBe("5m");
  });

  it("returns hours", () => {
    vi.useFakeTimers({ now: new Date("2026-04-01T15:00:00Z") });
    expect(formatRelativeTime("2026-04-01T12:00:00Z")).toBe("3h");
  });

  it("returns days", () => {
    vi.useFakeTimers({ now: new Date("2026-04-03T12:00:00Z") });
    expect(formatRelativeTime("2026-04-01T12:00:00Z")).toBe("2d");
  });
});

describe("formatRelativeTimeVerbose", () => {
  afterEach(() => { vi.useRealTimers(); });

  it("returns 'just now' for < 1 minute", () => {
    vi.useFakeTimers({ now: new Date("2026-04-01T12:00:10Z") });
    expect(formatRelativeTimeVerbose("2026-04-01T12:00:00Z")).toBe("just now");
  });

  it("returns '5m ago'", () => {
    vi.useFakeTimers({ now: new Date("2026-04-01T12:05:00Z") });
    expect(formatRelativeTimeVerbose("2026-04-01T12:00:00Z")).toBe("5m ago");
  });
});

describe("formatDuration", () => {
  it("formats seconds", () => {
    expect(formatDuration("2026-04-01T12:00:00Z", "2026-04-01T12:00:45Z")).toBe("45s");
  });

  it("formats minutes and seconds", () => {
    expect(formatDuration("2026-04-01T12:00:00Z", "2026-04-01T12:03:20Z")).toBe("3m 20s");
  });

  it("formats hours and minutes", () => {
    expect(formatDuration("2026-04-01T10:00:00Z", "2026-04-01T11:05:00Z")).toBe("1h 5m");
  });

  it("returns dash for negative duration", () => {
    expect(formatDuration("2026-04-01T12:00:00Z", "2026-04-01T11:00:00Z")).toBe("—");
  });
});
