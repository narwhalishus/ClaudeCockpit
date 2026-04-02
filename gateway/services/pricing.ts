/**
 * Model pricing table and cost estimation for Claude API (Bedrock rates).
 *
 * Source: AWS Bedrock on-demand pricing (us-east-1), last updated 2026-03-15.
 * Prices are per million tokens (USD). Update when new models or rate changes ship.
 */

export interface ModelPricing {
  inputPerMTok: number;
  outputPerMTok: number;
  cacheReadPerMTok: number;
  cacheCreationPerMTok: number;
}

const PRICING_TABLE: { prefix: string; pricing: ModelPricing }[] = [
  {
    prefix: "claude-opus-4",
    pricing: { inputPerMTok: 15, outputPerMTok: 75, cacheReadPerMTok: 1.5, cacheCreationPerMTok: 18.75 },
  },
  {
    prefix: "claude-sonnet-4",
    pricing: { inputPerMTok: 3, outputPerMTok: 15, cacheReadPerMTok: 0.3, cacheCreationPerMTok: 3.75 },
  },
  {
    prefix: "claude-haiku-4",
    pricing: { inputPerMTok: 0.8, outputPerMTok: 4, cacheReadPerMTok: 0.08, cacheCreationPerMTok: 1 },
  },
];

/** Default to Sonnet rates for unknown models (logged as warning) */
const DEFAULT_PRICING: ModelPricing = PRICING_TABLE[1].pricing;

/** Get pricing for a model by prefix match (handles date suffixes like claude-sonnet-4-20260301). */
export function getPricing(model: string): ModelPricing {
  for (const entry of PRICING_TABLE) {
    if (model.startsWith(entry.prefix)) return entry.pricing;
  }
  if (model) {
    console.warn(`Unknown model "${model}" — using default Sonnet pricing for cost estimate`);
  }
  return DEFAULT_PRICING;
}

/** Estimate cost in USD for a single session's token usage. */
export function estimateSessionCost(
  model: string,
  inputTokens: number,
  outputTokens: number,
  cacheReadTokens: number,
  cacheCreationTokens: number,
): number {
  const p = getPricing(model);
  return (
    (inputTokens / 1_000_000) * p.inputPerMTok +
    (outputTokens / 1_000_000) * p.outputPerMTok +
    (cacheReadTokens / 1_000_000) * p.cacheReadPerMTok +
    (cacheCreationTokens / 1_000_000) * p.cacheCreationPerMTok
  );
}
