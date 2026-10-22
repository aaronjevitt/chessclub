import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseTimeControl, remainingTime, clockFields, timeoutResult } from '../server/clock.js';

const START = 'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1';

test('parseTimeControl validates and converts to milliseconds', () => {
  assert.equal(parseTimeControl(null), null);
  assert.deepEqual(parseTimeControl({ initial: 180, increment: 2 }), { initial: 180000, increment: 2000 });
  assert.deepEqual(parseTimeControl({ initial: 60 }), { initial: 60000, increment: 0 });
  assert.throws(() => parseTimeControl({ initial: 5 }));
  assert.throws(() => parseTimeControl({ initial: 60, increment: -1 }));
  assert.throws(() => parseTimeControl({ initial: 'abc' }));
});

test('running clock is charged for elapsed time; increment added after a move', () => {
  const g = {
    status: 'active', fen: START, time_control: JSON.stringify({ initial: 60000, increment: 1000 }),
    white_ms: 60000, black_ms: 55000, turn_started_at: 1000,
  };
  assert.deepEqual(remainingTime(g, 11000), { running: 'w', w: 50000, b: 55000 });
  assert.deepEqual(clockFields(g, { now: 11000, moved: true, plies: 3 }), { white_ms: 51000, black_ms: 55000, turn_started_at: 11000 });
  // Game over: clocks freeze.
  assert.equal(clockFields(g, { now: 11000, status: 'finished', plies: 3 }).turn_started_at, null);
  // Opening moves are untimed: no clock runs until both sides have moved.
  assert.equal(clockFields({ ...g, turn_started_at: null }, { now: 11000, moved: true, plies: 1 }).turn_started_at, null);
  assert.equal(clockFields({ ...g, turn_started_at: null }, { now: 11000, moved: true, plies: 1 }).white_ms, 60000);
  // Untimed games have no clock columns.
  assert.deepEqual(clockFields({ ...g, time_control: null }, { plies: 3 }), {});
});

test('timeout is a draw when the opponent cannot mate', () => {
  assert.deepEqual(timeoutResult(START, 'w'), { result: '0-1', termination: 'white ran out of time' });
  assert.equal(timeoutResult('4k3/8/8/8/8/8/PPPP4/4K3 b - - 0 1', 'b').result, '1-0');
  assert.equal(timeoutResult('4k3/8/8/8/8/8/PPPP4/4K3 w - - 0 1', 'w').result, '1/2-1/2'); // black has a bare king
  assert.equal(timeoutResult('4kn2/8/8/8/8/8/PPPP4/4K3 w - - 0 1', 'w').result, '1/2-1/2'); // king + knight
  assert.equal(timeoutResult('4kr2/8/8/8/8/8/PPPP4/4K3 w - - 0 1', 'w').result, '0-1'); // king + rook can mate
});
