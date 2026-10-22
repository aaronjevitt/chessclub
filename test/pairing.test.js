import { test } from 'node:test';
import assert from 'node:assert/strict';
import { standings, roundRobin, swissRound, suggestedSwissRounds } from '../server/pairing.js';

const pairKey = (a, b) => [a, b].sort((x, y) => x - y).join('-');

test('round robin: everyone meets everyone once, byes rotate, colours roughly balanced', () => {
  for (const n of [2, 3, 4, 5, 6, 7, 8]) {
    const ids = Array.from({ length: n }, (_, i) => i + 1);
    const rounds = roundRobin(ids);
    assert.equal(rounds.length, n % 2 ? n : n - 1);
    const seen = new Set();
    const byes = new Map();
    const whites = new Map(ids.map((id) => [id, 0]));
    for (const round of rounds) {
      const inRound = new Set();
      for (const p of round) {
        assert.ok(!inRound.has(p.white) && !inRound.has(p.black), 'nobody plays twice in a round');
        inRound.add(p.white);
        if (p.black === null) {
          byes.set(p.white, (byes.get(p.white) || 0) + 1);
          continue;
        }
        inRound.add(p.black);
        const key = pairKey(p.white, p.black);
        assert.ok(!seen.has(key), `rematch ${key}`);
        seen.add(key);
        whites.set(p.white, whites.get(p.white) + 1);
      }
    }
    assert.equal(seen.size, (n * (n - 1)) / 2);
    if (n % 2) assert.deepEqual([...byes.values()].sort(), Array(n).fill(1));
    const games = n - 1; // each player plays everyone else once
    for (const w of whites.values()) assert.ok(Math.abs(w - games / 2) <= 0.5, `colour balance for n=${n}`);
  }
});

test('standings: points, Buchholz tiebreak, byes', () => {
  const players = [{ id: 1, rating: 1500 }, { id: 2, rating: 1400 }, { id: 3, rating: 1300 }];
  const pairings = [
    { round: 1, white: 1, black: 2, result: '1-0' },
    { round: 1, white: 3, black: null, result: '1-0' },
    { round: 2, white: 3, black: 1, result: '1/2-1/2' },
    { round: 2, white: 2, black: null, result: '1-0' },
  ];
  const table = standings(players, pairings);
  assert.deepEqual(table.map((r) => [r.id, r.points]), [[1, 1.5], [3, 1.5], [2, 1]]);
  assert.equal(table[0].buchholz, 2.5); // opponents 2 (1) + 3 (1.5)
  assert.equal(table[1].byes, 1);
});

test('swiss: no rematches while avoidable, fair byes, winners meet winners', () => {
  const players = Array.from({ length: 7 }, (_, i) => ({ id: i + 1, rating: 2000 - i * 100 }));
  const pairings = [];
  const byeCount = new Map();
  for (let round = 1; round <= 5; round++) {
    const next = swissRound(players, pairings);
    const ids = next.flatMap((p) => [p.white, p.black]).filter((x) => x !== null);
    assert.equal(new Set(ids).size, 7, 'everyone paired once');
    for (const p of next) {
      if (p.black === null) {
        byeCount.set(p.white, (byeCount.get(p.white) || 0) + 1);
        pairings.push({ round, ...p, result: '1-0' });
        continue;
      }
      assert.ok(!pairings.some((q) => q.black !== null && pairKey(q.white, q.black) === pairKey(p.white, p.black)), `rematch in round ${round}`);
      // Higher rating wins.
      const winner = players.find((x) => x.id === p.white).rating > players.find((x) => x.id === p.black).rating ? '1-0' : '0-1';
      pairings.push({ round, ...p, result: winner });
    }
  }
  assert.ok([...byeCount.values()].every((c) => c === 1), 'no second bye while others had none');
  const round2 = swissRound(players, pairings.filter((p) => p.round === 1));
  const table = standings(players, pairings.filter((p) => p.round === 1));
  const leaders = new Set(table.filter((r) => r.points === 1).map((r) => r.id));
  const topBoard = round2[0];
  assert.ok(leaders.has(topBoard.white) && leaders.has(topBoard.black), 'leaders meet on board 1');
  assert.equal(suggestedSwissRounds(8), 4);
  assert.equal(suggestedSwissRounds(3), 2);
});
