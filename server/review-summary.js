// Server-side summary of a stored game review (accuracy per side), using the same logic as the browser.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Chess } from 'chess.js';
import { reviewGame } from '../public/js/review.js';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
let book = null;

export function openingBook() {
  book ||= JSON.parse(fs.readFileSync(path.join(ROOT, 'public', 'data', 'openings.json'), 'utf8'));
  return book;
}

/** {accuracy: {w, b}, counts} for a game row with an analysis, or null if it can't be reviewed. */
export function summarizeReview(game, analysis) {
  try {
    const moves = JSON.parse(game.moves);
    if (analysis.positions?.length !== moves.length + 1) return null;
    const r = reviewGame({ Chess, startFen: game.start_fen, moves, positions: analysis.positions, book: openingBook() });
    const round = (v) => (v === null ? null : Math.round(v * 10) / 10);
    return { accuracy: { w: round(r.accuracy.w), b: round(r.accuracy.b) }, counts: r.counts };
  } catch {
    return null;
  }
}
