// What buddies' runs used of the Claude API, and what that costs at list
// prices: each run's usage, summed from the steps its agent wrote to its
// trace (agents/ponjo.mjs), is in its line of logs/runs.jsonl
// (src/host/runner.js); Settings > Usage sums them (web/settings-dialog.js).

// List prices in dollars per million tokens: input, output, a cache read and
// a cache write (five minutes: 1.25 times input). A model not here has no cost.
const PRICES = {
  'claude-fable-5-2': { input: 8, output: 40, cacheRead: 0.2, cacheWrite: 10 },
  'claude-opus-5-5': { input: 4, output: 20, cacheRead: 0.2, cacheWrite: 5 },
  'claude-opus-5': { input: 5, output: 25, cacheRead: 0.5, cacheWrite: 6.25 },
  'claude-sonnet-5-5': { input: 2, output: 10, cacheRead: 0.1, cacheWrite: 2.5 },
  'claude-sonnet-5': { input: 2, output: 10, cacheRead: 0.2, cacheWrite: 2.5 },
  'claude-haiku-5-5': { input: 0.1, output: 0.5, cacheRead: 0.01, cacheWrite: 0.125 },
};
const KINDS = ['input', 'output', 'cacheRead', 'cacheWrite'];
const DAY = 24 * 60 * 60 * 1000;
const PERIODS = [['Today', 1], ['Last 7 days', 7], ['Last 30 days', 30]];

/**
 * A run's usage from its trace's steps, as the Claude API counts it:
 * { model, input, output, cacheRead, cacheWrite } in tokens, or null when
 * no step says (another agent, or another provider's API).
 */
export function runUsage(steps) {
  const counted = steps.filter((step) => Number.isFinite(step?.usage?.input_tokens));
  if (counted.length === 0) return null;
  const sum = (key) => counted.reduce((n, { usage }) => n + (usage[key] ?? 0), 0);
  return {
    model: counted.at(-1).model ?? null,
    input: sum('input_tokens'),
    output: sum('output_tokens'),
    cacheRead: sum('cache_read_input_tokens'),
    cacheWrite: sum('cache_creation_input_tokens'),
  };
}

/** What a run's `usage` costs in dollars, or null for a model with no price. */
function costOf(usage) {
  const price = PRICES[usage.model];
  return price ? KINDS.reduce((dollars, kind) => dollars + (usage[kind] * price[kind]) / 1e6, 0) : null;
}

/**
 * The runs' usage (runs.jsonl's entries, each { at, usage? }) as Settings >
 * Usage shows it, by `now`: { periods: [{ label, ...totals }] for today and
 * the last 7 and 30 days, models: [{ model, ...totals }] for the last 30
 * days, most costly first }, totals being { runs, input (all input tokens,
 * cached or not), output, hit (the share of input read from the cache, or
 * null), cost (of the runs whose model has a price; null when none has) }.
 */
export function summarizeUsage(entries, now) {
  const used = entries.filter((entry) => entry?.usage && typeof entry.at === 'string');
  const midnight = new Date(now).setHours(0, 0, 0, 0);
  const since = (days) => used.filter((entry) => Date.parse(entry.at) >= midnight - (days - 1) * DAY);
  const periods = PERIODS.map(([label, days]) => ({ label, ...totals(since(days)) }));
  const byModel = Map.groupBy(since(30), (entry) => entry.usage.model ?? 'Unknown model');
  const models = [...byModel].map(([model, runs]) => ({ model, ...totals(runs) })).sort((a, b) => (b.cost ?? 0) - (a.cost ?? 0));
  return { periods, models };
}

function totals(entries) {
  const sum = (kind) => entries.reduce((n, { usage }) => n + (usage[kind] ?? 0), 0);
  const input = sum('input') + sum('cacheRead') + sum('cacheWrite');
  const costs = entries.map(({ usage }) => costOf(usage)).filter((cost) => cost !== null);
  return {
    runs: entries.length,
    input,
    output: sum('output'),
    hit: input ? sum('cacheRead') / input : null,
    cost: costs.length ? costs.reduce((a, b) => a + b, 0) : null,
  };
}
