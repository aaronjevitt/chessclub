import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { Chess } from 'chess.js';
import { reviewGame, whiteWinPercent, moveAccuracy } from '../public/js/review.js';

const book = JSON.parse(fs.readFileSync(new URL('../public/data/openings.json', import.meta.url)));
const START = 'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1';
const pos = (best, cp, extra = {}) => ({ best, cp, mate: null, alt: null, cp2: null, mate2: null, ...extra });

test('winning chances and accuracy formulas', () => {
  assert.equal(whiteWinPercent({ cp: 0, mate: null }), 50);
  assert.ok(whiteWinPercent({ cp: 300, mate: null }) > 74 && whiteWinPercent({ cp: 300, mate: null }) < 76);
  assert.equal(whiteWinPercent({ cp: null, mate: 3 }), 100);
  assert.equal(whiteWinPercent({ cp: null, mate: -2 }), 0);
  assert.ok(moveAccuracy(0) > 99.9);
  assert.ok(moveAccuracy(20) > 39 && moveAccuracy(20) < 41);
});

test('book moves, opening name, best/blunder/miss labels and accuracy', () => {
  // 1.e4 e5 2.Qh5 Nc6 3.Bc4 Nf6?? 4.Qxf7#  — with a missed mate variation: 4.Qxf7# is best and played.
  const moves = ['e4', 'e5', 'Qh5', 'Nc6', 'Bc4', 'Nf6', 'Qxf7#'];
  const positions = [
    pos('e2e4', 30), pos('e7e5', 30), pos('g1f3', 30), pos('b8c6', 0), pos('f1c4', 20),
    pos('g7g6', -20), pos('h5f7', null, { mate: 1 }), pos(null, 100000, { mate: 0 }),
  ];
  const r = reviewGame({ Chess, startFen: START, moves, positions, book });
  const labels = r.moves.map((m) => m.label);
  assert.deepEqual(labels.slice(0, 2), ['book', 'book']);
  assert.ok(r.opening && r.opening.name.length > 0, 'opening named');
  assert.equal(labels[5], 'blunder'); // Nf6?? allows mate
  assert.equal(r.moves[5].bestSan, 'g6');
  assert.equal(labels[6], 'best'); // Qxf7#
  assert.ok(r.accuracy.w > r.accuracy.b);
  assert.equal(r.counts.b.blunder, 1);
  assert.ok(r.keyMoments.includes(6));
});

test('great (only move) and miss (failed to punish a blunder)', () => {
  const start = '6k1/5ppp/8/8/8/8/5PPP/3R2K1 w - - 0 1';
  // Only one move keeps the advantage: the second-best line is much worse.
  const r1 = reviewGame({ Chess, startFen: '6k1/5ppp/8/8/8/8/5PPP/3R2K1 w - - 0 1', moves: ['Rd7'], positions: [
    pos('d1d7', 300, { alt: 'g1f1', cp2: 0 }), pos('g8f8', 300),
  ], book });
  assert.equal(r1.moves[0].label, 'great');
  // Delivering mate is just "best", even if it is the only winning move.
  const mate = reviewGame({ Chess, startFen: start, moves: ['Rd8#'], positions: [
    pos('d1d8', null, { mate: 1, alt: 'g1f1', cp2: 0 }), pos(null, 100000, { mate: 0 }),
  ], book });
  assert.equal(mate.moves[0].label, 'best');

  // Black blunders, White fails to take advantage but isn't losing: a miss.
  const r2 = reviewGame({ Chess, startFen: START, moves: ['d4', 'e5', 'a3'], positions: [
    pos('d2d4', 20), pos('d7d5', 20), pos('d4e5', 250), pos('e5d4', 0),
  ], book: {} });
  assert.equal(r2.moves[1].label, 'blunder');
  assert.equal(r2.moves[2].label, 'miss');
});

test('brilliant: a sound piece sacrifice', () => {
  // White plays Bxh7+?! style: bishop moves to a square attacked by a pawn, engine says it's best and winning.
  const fen = 'r1bq1rk1/pppn1ppp/4p3/3pP3/1b1P4/2NB1N2/PPP2PPP/R2QK2R w KQ - 0 1';
  const r = reviewGame({ Chess, startFen: fen, moves: ['Bxh7+'], positions: [
    pos('d3h7', 150, { alt: 'e1g1', cp2: 40 }), pos(null, 150),
  ], book: {} });
  assert.equal(r.moves[0].label, 'brilliant');
});
