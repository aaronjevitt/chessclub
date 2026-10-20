import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Chess } from 'chess.js';
import { findBestMove, evaluate, evaluatePosition, LEVELS } from '../public/js/engine.js';

test('chess.js internals used by the engine are present', () => {
  const chess = new Chess();
  for (const name of ['_moves', '_makeMove', '_undoMove', '_isKingAttacked', '_getPositionCount']) {
    assert.equal(typeof chess[name], 'function', name);
  }
  assert.equal(chess._board.length, 128);
  assert.equal(chess._turn, 'w');
  assert.equal(typeof chess._hash, 'bigint');
  assert.ok(Array.isArray(chess._history));
});

test('start position evaluates as balanced', () => {
  assert.equal(evaluate(new Chess()), 0);
});

test('finds mate in one', () => {
  const chess = new Chess('r1bqkb1r/pppp1ppp/2n2n2/4p2Q/2B1P3/8/PPPP1PPP/RNB1K1NR w KQkq - 4 4');
  assert.equal(findBestMove(chess, { level: 3 }).move.san, 'Qxf7#');
});

test('finds back-rank mate for black', () => {
  const chess = new Chess('3r2k1/5ppp/8/8/8/8/5PPP/6K1 b - - 0 1');
  assert.equal(findBestMove(chess, { level: 4 }).move.san, 'Rd1#');
});

test('wins a hanging queen', () => {
  const chess = new Chess('rnb1kbnr/pppp1ppp/8/4p1q1/3P4/2N5/PPP1PPPP/R1BQKBNR w KQkq - 0 3');
  assert.equal(findBestMove(chess, { level: 3 }).move.san, 'Bxg5');
});

test('promotes a pawn', () => {
  const chess = new Chess('8/4P1k1/8/8/8/8/6K1/8 w - - 0 1');
  const { move } = findBestMove(chess, { level: 3 });
  assert.equal(move.from, 'e7');
  assert.equal(move.promotion, 'q');
});

test('leaves the position unchanged, including after a timeout', () => {
  const chess = new Chess('r1bqkbnr/pppp1ppp/2n5/4p3/4P3/5N2/PPPP1PPP/RNBQKB1R w KQkq - 2 3');
  const fen = chess.fen();
  findBestMove(chess, { maxDepth: 20, timeMs: 150, noise: 0 });
  assert.equal(chess.fen(), fen);
  assert.equal(chess.history().length, 0);
});

test('returns null when there are no legal moves', () => {
  const mated = new Chess('rnb1kbnr/pppp1ppp/8/4p3/6Pq/5P2/PPPPP2P/RNBQKBNR w KQkq - 1 3');
  assert.equal(findBestMove(mated, { level: 1 }).move, null);
});

test('every level returns a legal move quickly from the start', () => {
  for (const level of Object.keys(LEVELS)) {
    const chess = new Chess();
    const { move } = findBestMove(chess, { level: Number(level), timeMs: 300 });
    assert.ok(chess.moves().includes(move.san), `level ${level}: ${move.san}`);
  }
});

test('evaluatePosition reports from White\'s point of view, including mates', () => {
  assert.equal(evaluatePosition(new Chess('r1bqkb1r/pppp1ppp/2n2n2/4p2Q/2B1P3/8/PPPP1PPP/RNB1K1NR w KQkq - 4 4'), { timeMs: 300 }).mate, 1);
  assert.equal(evaluatePosition(new Chess('rnbqkbnr/pppp1ppp/8/4p3/6P1/5P2/PPPPP2P/RNBQKBNR b KQkq - 0 2'), { timeMs: 300 }).mate, -1);
  const mated = evaluatePosition(new Chess('rnb1kbnr/pppp1ppp/8/4p3/6Pq/5P2/PPPPP2P/RNBQKBNR w KQkq - 1 3'));
  assert.equal(mated.mate, 0);
  assert.ok(mated.cp < 0);
  // Black to move but a queen down: still clearly better for White.
  assert.ok(evaluatePosition(new Chess('4k3/8/8/8/8/8/8/Q3K3 b - - 0 1'), { timeMs: 200 }).cp > 500);
  assert.equal(evaluatePosition(new Chess('7k/5Q2/6K1/8/8/8/8/8 b - - 0 1')).cp, 0); // stalemate
});
