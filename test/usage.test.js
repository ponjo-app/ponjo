// Settings > Usage (src/core/usage.js): a run's Claude API tokens, summed by
// period and by model, with what they cost at list prices.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { runUsage, summarizeUsage } from '../src/core/usage.js';

test('a run\'s usage is the sum of its steps\', as the Claude API counts it; none when no step says', () => {
  const steps = [
    { started: 'ask' },
    { role: 'assistant', model: 'claude-opus-5-5', usage: { input_tokens: 100, output_tokens: 20, cache_creation_input_tokens: 3000, cache_read_input_tokens: 0 } },
    { role: 'tool', content: 'read' },
    { role: 'assistant', model: 'claude-opus-5-5', usage: { input_tokens: 50, output_tokens: 10, cache_read_input_tokens: 3000 } },
  ];
  assert.deepEqual(runUsage(steps), { model: 'claude-opus-5-5', input: 150, output: 30, cacheRead: 3000, cacheWrite: 3000 });
  assert.equal(runUsage([{ role: 'assistant', usage: { prompt_tokens: 5 } }, 'not JSON']), null, 'another provider\'s, or none');
});

test('usage by period and by model: all input, the share read from the cache, and the cost at list prices', () => {
  const now = new Date(2026, 10, 16, 12).getTime();
  const at = (daysAgo) => new Date(now - daysAgo * 24 * 60 * 60 * 1000).toISOString();
  const opus = { model: 'claude-opus-5-5', input: 1_000_000, output: 100_000, cacheRead: 2_000_000, cacheWrite: 1_000_000 };
  const entries = [
    { at: at(0), usage: opus },
    { at: at(3), usage: { ...opus, model: 'claude-haiku-5-5' } },
    { at: at(20), usage: { ...opus, model: 'some-new-model' } },
    { at: at(40), usage: opus },
    { at: at(0), outcome: 'ok' }, // another agent: no usage
  ];
  const { periods, models } = summarizeUsage(entries, now);
  const opusCost = 1 * 4 + 0.1 * 20 + 2 * 0.2 + 1 * 5; // $11.40
  const haikuCost = 1 * 0.1 + 0.1 * 0.5 + 2 * 0.01 + 1 * 0.125;
  assert.deepEqual(periods.map(({ label, runs }) => [label, runs]), [['Today', 1], ['Last 7 days', 2], ['Last 30 days', 3]]);
  assert.equal(periods[0].input, 4_000_000, 'input cached or not');
  assert.equal(periods[0].hit, 0.5);
  assert.ok(Math.abs(periods[0].cost - opusCost) < 1e-9);
  assert.ok(Math.abs(periods[2].cost - (opusCost + haikuCost)) < 1e-9, 'a model with no price adds tokens, no cost');
  assert.deepEqual(models.map(({ model, cost }) => [model, cost === null ? null : Math.round(cost * 100) / 100]), [['claude-opus-5-5', 11.4], ['claude-haiku-5-5', 0.3], ['some-new-model', null]], 'the last 30 days, most costly first');
});
