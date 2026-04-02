/**
 * Unit tests for the pricing module.
 *
 * Tests prefix matching for known/unknown models and cost calculation.
 */
import { describe, it, expect } from "vitest";
import { getPricing, estimateSessionCost } from "../../gateway/services/pricing.ts";

describe("getPricing", () => {
  it("returns Opus rates for claude-opus-4 models", () => {
    const p = getPricing("claude-opus-4-6");
    expect(p.inputPerMTok).toBe(15);
    expect(p.outputPerMTok).toBe(75);
    expect(p.cacheReadPerMTok).toBe(1.5);
    expect(p.cacheCreationPerMTok).toBe(18.75);
  });

  it("returns Sonnet rates for claude-sonnet-4 models", () => {
    const p = getPricing("claude-sonnet-4-6");
    expect(p.inputPerMTok).toBe(3);
    expect(p.outputPerMTok).toBe(15);
  });

  it("returns Haiku rates for claude-haiku-4 models", () => {
    const p = getPricing("claude-haiku-4-5-20251001");
    expect(p.inputPerMTok).toBe(0.8);
    expect(p.outputPerMTok).toBe(4);
  });

  it("handles model name variations with date suffixes", () => {
    const p = getPricing("claude-opus-4-6-20260301");
    expect(p.inputPerMTok).toBe(15);
  });

  it("returns Sonnet (default) rates for unknown models", () => {
    const p = getPricing("unknown-model-v2");
    expect(p.inputPerMTok).toBe(3);
    expect(p.outputPerMTok).toBe(15);
  });

  it("returns Sonnet (default) rates for empty string", () => {
    const p = getPricing("");
    expect(p.inputPerMTok).toBe(3);
  });
});

describe("estimateSessionCost", () => {
  it("calculates cost correctly for Opus", () => {
    // 1M input tokens at $15/MTok = $15
    // 500K output tokens at $75/MTok = $37.50
    const cost = estimateSessionCost("claude-opus-4-6", 1_000_000, 500_000, 0, 0);
    expect(cost).toBeCloseTo(52.5);
  });

  it("includes cache token costs", () => {
    // 1M cache read at $1.50/MTok = $1.50
    // 1M cache creation at $18.75/MTok = $18.75
    const cost = estimateSessionCost("claude-opus-4-6", 0, 0, 1_000_000, 1_000_000);
    expect(cost).toBeCloseTo(20.25);
  });

  it("returns 0 for zero tokens", () => {
    expect(estimateSessionCost("claude-opus-4-6", 0, 0, 0, 0)).toBe(0);
  });

  it("uses default pricing for unknown models", () => {
    // 1M input at Sonnet $3/MTok = $3
    const cost = estimateSessionCost("unknown", 1_000_000, 0, 0, 0);
    expect(cost).toBeCloseTo(3);
  });
});
