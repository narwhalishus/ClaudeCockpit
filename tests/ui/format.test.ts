/**
 * Unit tests for shared format utilities.
 */
import { describe, it, expect, vi, afterEach } from "vitest";
import {
  formatTokens,
  formatRelativeTime,
  formatDuration,
  formatUptime,
  formatCost,
  shortenHomePath,
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

describe("formatRelativeTime (verbose)", () => {
  afterEach(() => { vi.useRealTimers(); });

  it("returns 'just now' for < 1 minute", () => {
    vi.useFakeTimers({ now: new Date("2026-04-01T12:00:10Z") });
    expect(formatRelativeTime("2026-04-01T12:00:00Z", true)).toBe("just now");
  });

  it("returns '5m ago'", () => {
    vi.useFakeTimers({ now: new Date("2026-04-01T12:05:00Z") });
    expect(formatRelativeTime("2026-04-01T12:00:00Z", true)).toBe("5m ago");
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

describe("formatUptime", () => {
  afterEach(() => { vi.useRealTimers(); });

  it("shows seconds for short uptimes", () => {
    vi.useFakeTimers({ now: new Date("2026-04-01T12:00:45Z") });
    expect(formatUptime("2026-04-01T12:00:00Z")).toBe("45s");
  });

  it("shows minutes and seconds", () => {
    vi.useFakeTimers({ now: new Date("2026-04-01T12:03:20Z") });
    expect(formatUptime("2026-04-01T12:00:00Z")).toBe("3m 20s");
  });

  it("shows hours and minutes", () => {
    vi.useFakeTimers({ now: new Date("2026-04-01T14:30:00Z") });
    expect(formatUptime("2026-04-01T12:00:00Z")).toBe("2h 30m");
  });

  it("shows days and hours", () => {
    vi.useFakeTimers({ now: new Date("2026-04-03T15:00:00Z") });
    expect(formatUptime("2026-04-01T12:00:00Z")).toBe("2d 3h");
  });

  it("returns '0s' for future start time", () => {
    vi.useFakeTimers({ now: new Date("2026-04-01T12:00:00Z") });
    expect(formatUptime("2026-04-01T13:00:00Z")).toBe("0s");
  });
});

describe("shortenHomePath", () => {
  it("replaces /Users/<user> with ~", () => {
    expect(shortenHomePath("/Users/bryao/Code/MyProject")).toBe("~/Code/MyProject");
  });

  it("handles different usernames", () => {
    expect(shortenHomePath("/Users/alice/projects/app")).toBe("~/projects/app");
  });

  it("returns non-home paths unchanged", () => {
    expect(shortenHomePath("/var/log/syslog")).toBe("/var/log/syslog");
    expect(shortenHomePath("/tmp/test")).toBe("/tmp/test");
  });

  it("handles root-level home directory", () => {
    expect(shortenHomePath("/Users/bryao")).toBe("~");
  });

  it("returns empty string unchanged", () => {
    expect(shortenHomePath("")).toBe("");
  });
});

describe("formatCost", () => {
  it("formats zero cost", () => {
    expect(formatCost(0)).toBe("$0.00");
  });

  it("formats sub-penny amounts", () => {
    expect(formatCost(0.005)).toBe("<$0.01");
    expect(formatCost(0.001)).toBe("<$0.01");
  });

  it("formats normal amounts", () => {
    expect(formatCost(1.23)).toBe("$1.23");
    expect(formatCost(0.50)).toBe("$0.50");
    expect(formatCost(99.99)).toBe("$99.99");
  });

  it("formats amounts at the penny boundary", () => {
    expect(formatCost(0.01)).toBe("$0.01");
  });
});
