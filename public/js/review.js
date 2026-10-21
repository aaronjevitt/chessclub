// Game review: turn per-position engine evaluations into move labels, accuracy and key moments.
// Pure logic (no DOM); the chess.js class is passed in so this also runs under Node tests.
//
// positions[i] describes the position after i moves (positions[0] = start), from White's point of view:
//   { best: 'e2e4' | null, cp: number | null, mate: number | null,   // best line
//     alt: 'd2d4' | null, cp2: number | null, mate2: number | null }  // second-best line, if any
//
// Winning chances and accuracy follow lichess's published formulas. Labels mirror chess.com's names;
// Brilliant, Great and Miss are approximations because chess.com doesn't publish its rules.

export const LABELS = {
  book: { name: 'Book', symbol: '≡', color: '#a88865' },
  brilliant: { name: 'Brilliant', symbol: '!!', color: '#26c2a3' },
  great: { name: 'Great', symbol: '!', color: '#5b8bb0' },
  best: { name: 'Best', symbol: '★', color: '#81b64c' },
  excellent: { name: 'Excellent', symbol: '✦', color: '#98bc4b' },
  good: { name: 'Good', symbol: '✓', color: '#95b776' },
  inaccuracy: { name: 'Inaccuracy', symbol: '?!', color: '#f0c15c' },
  mistake: { name: 'Mistake', symbol: '?', color: '#e6912c' },
  miss: { name: 'Miss', symbol: '✕', color: '#ee6b55' },
  blunder: { name: 'Blunder', symbol: '??', color: '#ca3431' },
};
export const LABEL_ORDER = Object.keys(LABELS);
export const KEY_LABELS = new Set(['brilliant', 'great', 'miss', 'mistake', 'blunder']);
export const RETRY_LABELS = new Set(['miss', 'mistake', 'blunder']);

const VALUES = { p: 1, n: 3, b: 3, r: 5, q: 9, k: 0 };

/** Winning chances 0-100 for White from an evaluation (lichess formula). */
export function whiteWinPercent({ cp, mate }) {
  if (mate !== null && mate !== undefined) {
    if (mate === 0) return cp > 0 ? 100 : 0;
    return mate > 0 ? 100 : 0;
  }
  const c = Math.max(-1500, Math.min(1500, cp));
  return 50 + 50 * (2 / (1 + Math.exp(-0.00368208 * c)) - 1);
}

/** Accuracy of a single move from the drop in the mover's winning chances (lichess formula). */
export function moveAccuracy(winLoss) {
  return Math.max(0, Math.min(100, 103.1668 * Math.exp(-0.04354 * winLoss) - 3.1669));
}

export function positionKey(fen) {
  return fen.split(' ').slice(0, 3).join(' ');
}

function second(p) {
  return p.alt ? { cp: p.cp2, mate: p.mate2 } : null;
}

/** Label from the drop in the mover's winning chances (0-100 scale) — shared by review and explore mode. */
export function labelForLoss(loss, isBest) {
  if (isBest || loss < 0.5) return 'best';
  if (loss < 2) return 'excellent';
  if (loss < 5) return 'good';
  if (loss < 10) return 'inaccuracy';
  if (loss < 15) return 'mistake';
  return 'blunder';
}

/** Did the move just played leave the moved piece en prise for less than it is worth (a sacrifice)? */
function isSacrifice(chess, move) {
  const value = VALUES[move.promotion || move.piece];
  if (value < 3) return false;
  const gained = move.captured ? VALUES[move.captured] : 0;
  if (value - gained < 2) return false;
  const them = move.color === 'w' ? 'b' : 'w';
  const attackers = chess.attackers(move.to, them);
  if (!attackers.length) return false;
  const defenders = chess.attackers(move.to, move.color);
  const cheapest = Math.min(...attackers.map((sq) => VALUES[chess.get(sq).type] || 0));
  return defenders.length === 0 || cheapest < value;
}

function stdev(values) {
  const mean = values.reduce((a, b) => a + b, 0) / values.length;
  return Math.sqrt(values.reduce((a, b) => a + (b - mean) ** 2, 0) / values.length);
}

/** Game accuracy per side: average of a volatility-weighted mean and a harmonic mean (as lichess does). */
function sideAccuracy(moves, whiteWins, color) {
  const windowSize = Math.max(2, Math.min(8, Math.floor(whiteWins.length / 10)));
  let weighted = 0;
  let weights = 0;
  let inverse = 0;
  let n = 0;
  moves.forEach((m, i) => {
    if (m.color !== color) return;
    const from = Math.max(0, Math.min(i, whiteWins.length - windowSize));
    const weight = Math.max(0.5, Math.min(12, stdev(whiteWins.slice(from, from + windowSize))));
    weighted += m.accuracy * weight;
    weights += weight;
    inverse += 1 / Math.max(1, m.accuracy);
    n++;
  });
  if (!n) return null;
  return (weighted / weights + n / inverse) / 2;
}

/**
 * Classify every move of a game.
 * @param opts.Chess      chess.js class
 * @param opts.startFen   starting position
 * @param opts.moves      SAN moves
 * @param opts.positions  engine evaluations, moves.length + 1 entries (see top of file)
 * @param opts.book       opening book: position key → "ECO|Name" or "" (book position without a name)
 */
export function reviewGame({ Chess, startFen, moves, positions, book = {} }) {
  const chess = new Chess(startFen);
  const whiteWins = positions.map(whiteWinPercent);
  const result = [];
  let inBook = startFen.split(' ')[0] === 'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR';
  let opening = null;

  moves.forEach((san, i) => {
    const before = positions[i];
    const after = positions[i + 1];
    const fenBefore = chess.fen();
    const move = chess.move(san);
    const color = move.color;
    const mine = (w) => (color === 'w' ? w : 100 - w);
    const winBefore = mine(whiteWins[i]);
    const winAfter = mine(whiteWins[i + 1]);
    const loss = Math.max(0, winBefore - winAfter);
    const uci = move.from + move.to + (move.promotion || '');
    const isBest = before.best === uci;

    const bookEntry = inBook ? book[positionKey(chess.fen())] : undefined;
    if (bookEntry === undefined) inBook = false;
    else if (bookEntry) {
      const [eco, name] = bookEntry.split('|');
      opening = { eco, name, ply: i + 1 };
    }

    let label;
    const alt = second(before);
    const winAlt = alt ? mine(whiteWinPercent(alt)) : null;
    const prev = result[i - 1];
    const opponentErred = prev && (prev.label === 'mistake' || prev.label === 'blunder');
    const hadMate = before.mate !== null && before.mate !== undefined && Math.sign(before.mate) === (color === 'w' ? 1 : -1);
    if (inBook) label = 'book';
    else if (loss < 2 && winAfter >= 50 && winBefore < 97 && isSacrifice(chess, move)) label = 'brilliant';
    // Delivering mate is simply the best move, even when it is the only one that wins.
    else if ((isBest || loss < 1) && alt && winBefore - winAlt >= 15 && winAlt < 80 && !chess.isCheckmate()) label = 'great';
    else if ((opponentErred || hadMate) && loss >= 10 && winAfter >= 30) label = 'miss';
    else label = labelForLoss(loss, isBest);

    let bestSan = null;
    if (before.best && !isBest) {
      try {
        const probe = new Chess(fenBefore);
        bestSan = probe.move({ from: before.best.slice(0, 2), to: before.best.slice(2, 4), promotion: before.best[4] }).san;
      } catch {
        bestSan = null;
      }
    }

    result.push({
      ply: i + 1, color, san, uci, label, loss, accuracy: label === 'book' ? 100 : moveAccuracy(loss),
      bestUci: before.best, bestSan, from: move.from, to: move.to,
    });
  });

  const counts = { w: {}, b: {} };
  for (const color of ['w', 'b']) for (const key of LABEL_ORDER) counts[color][key] = 0;
  for (const m of result) counts[m.color][m.label]++;

  return {
    moves: result,
    whiteWins,
    accuracy: { w: sideAccuracy(result, whiteWins, 'w'), b: sideAccuracy(result, whiteWins, 'b') },
    counts,
    opening,
    keyMoments: result.filter((m) => KEY_LABELS.has(m.label)).map((m) => m.ply),
  };
}
