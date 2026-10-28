// The benchmark's checks (scripts/bench-cases.js), without a model: each
// passes the answers it must and fails the ones it must, so a check that is
// too loose (a wrong answer passes) or too strict (a right one fails) shows
// here and not as a model's score.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { CASES } from '../scripts/bench-cases.js';

const failing = (c, answer) => Object.entries(c.checks).filter(([, check]) => !check({ doc: c.doc, ...answer }, c)).map(([name]) => name);

for (const c of CASES) {
  test(`bench: ${c.kind}: ${c.name}`, () => {
    if (c.quote) assert.equal(c.doc.split(c.quote).length, 2, 'the thread is on text found once');
    for (const answer of c.pass) assert.deepEqual(failing(c, answer), [], `passes ${JSON.stringify(answer)}`);
    for (const [check, answer] of c.fail) assert.ok(failing(c, answer).includes(check), `${check} fails ${JSON.stringify(answer)}`);
  });
}
