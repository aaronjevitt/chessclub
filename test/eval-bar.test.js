import { test } from 'node:test';
import assert from 'node:assert/strict';
import { evalBarVisibility } from '../public/js/eval-settings.js';

test('eval bar fades out over the last 5 moves before the limit', () => {
  const meta = { evalBar: true, evalBarMoves: 10 };
  assert.equal(evalBarVisibility(meta, 0), 1);
  assert.equal(evalBarVisibility(meta, 10), 1); // after move 5
  assert.equal(evalBarVisibility(meta, 15), 0.5);
  assert.equal(evalBarVisibility(meta, 19), 0.1);
  assert.equal(evalBarVisibility(meta, 20), 0); // both sides have played move 10
  assert.equal(evalBarVisibility(meta, 40), 0);
  assert.equal(evalBarVisibility(meta, 40, false), 1); // finished game: full bar again
  assert.equal(evalBarVisibility({ evalBar: true }, 80), 1); // no limit
  assert.equal(evalBarVisibility({}, 0), 0); // bar off
  assert.equal(evalBarVisibility({ evalBar: true, evalBarMoves: 2 }, 2), 0.5); // short limit fades over its whole span
});
