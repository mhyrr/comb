/**
 * API-equivalent prices for Claude models, for the usage panel. Greg is on a
 * subscription, so these dollars are what the same tokens would cost on the
 * API, never what he paid.
 *
 * Source: Anthropic's model pricing table, as copied into hive's
 * src/lib/pricing.ts (hive TK-120), read 2026-11-15:
 *   https://platform.claude.com/docs/en/about-claude/pricing#model-pricing
 * Cross-checked 2026-11-17 against the claude-api skill's model table (cached
 * 2026-11-03): input and output agree for every row below.
 *
 * Left out on purpose, so they price as unknown rather than wrong:
 * - Haiku 5.5: two price tiers split at 100k prompt tokens.
 * - Fast mode (`usage.speed: "fast"`): a different rate per model.
 * - Every non-Claude model: no first-party price we can vouch for here.
 */

export const PRICING_SOURCE = {
  read: "2026-11-15",
  url: "https://platform.claude.com/docs/en/about-claude/pricing#model-pricing",
};

/** USD per million tokens: input, 5-minute cache write, 1-hour cache write, cache read, output. */
export type Rate = { input: number; write5m: number; write1h: number; read: number; output: number };

const r = (input: number, write5m: number, write1h: number, read: number, output: number): Rate =>
  ({ input, write5m, write1h, read, output });

// prettier-ignore
const RATES: Record<string, Rate> = {
  //                    input  5m write  1h write  read   output
  "claude-fable-5-2":  r(8,     10,       16,      0.2,   40),
  "claude-fable-5-1":  r(10,    12.5,     20,      0.25,  50),
  "claude-fable-5":    r(10,    12.5,     20,      1,     50),
  "claude-opus-5-5":   r(4,     5,        8,       0.2,   20),
  "claude-opus-5":     r(5,     6.25,     10,      0.5,   25),
  "claude-opus-4-8":   r(5,     6.25,     10,      0.5,   25),
  "claude-opus-4-7":   r(5,     6.25,     10,      0.5,   25),
  "claude-opus-4-6":   r(5,     6.25,     10,      0.5,   25),
  "claude-opus-4-5":   r(5,     6.25,     10,      0.5,   25),
  "claude-sonnet-5-5": r(2,     2.5,      4,       0.1,   10),
  "claude-sonnet-5":   r(2,     2.5,      4,       0.2,   10),
  "claude-sonnet-4-6": r(3,     3.75,     6,       0.3,   15),
  "claude-sonnet-4-5": r(3,     3.75,     6,       0.3,   15),
  "claude-haiku-4-5":  r(1,     1.25,     2,       0.1,   5),
};

/**
 * The rate for a model id, or null when we have no price we trust. A trailing
 * `[1m]` (1M context) or date snapshot (`-20251001`) is the same model.
 */
export function rateFor(model: string): Rate | null {
  return RATES[model.replace(/\[1m\]$/, "").replace(/-\d{8}$/, "")] ?? null;
}

export type PricedTokens = { input: number; write5m: number; write1h: number; read: number; output: number };

/** API-equivalent USD for one call's tokens at a rate. */
export function priceOf(t: PricedTokens, rate: Rate): number {
  return (t.input * rate.input + t.write5m * rate.write5m + t.write1h * rate.write1h + t.read * rate.read + t.output * rate.output) / 1e6;
}
