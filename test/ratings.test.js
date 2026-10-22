import { test } from 'node:test';
import assert from 'node:assert/strict';
import { eloUpdate, expectedScore, kFactor } from '../server/ratings.js';

test('Elo: expected scores, K-factors and zero-sum updates between equals', () => {
  assert.equal(expectedScore(1500, 1500), 0.5);
  assert.ok(expectedScore(1600, 1400) > 0.75);
  assert.equal(kFactor(1200, 0), 40);
  assert.equal(kFactor(1500, 30), 24);
  assert.equal(kFactor(2200, 30), 16);
  const win = eloUpdate({ rating: 1200, games: 0 }, { rating: 1200, games: 0 }, 1);
  assert.deepEqual(win, { white: 1220, black: 1180, whiteDelta: 20, blackDelta: -20 });
  const draw = eloUpdate({ rating: 1400, games: 20 }, { rating: 1200, games: 20 }, 0.5);
  assert.ok(draw.whiteDelta < 0 && draw.blackDelta > 0, 'the favourite loses points for a draw');
  const upset = eloUpdate({ rating: 1000, games: 20 }, { rating: 1600, games: 20 }, 1);
  assert.ok(upset.whiteDelta > 20);
});
