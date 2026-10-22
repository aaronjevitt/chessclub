// A small alpha-beta chess engine that runs entirely in the browser (inside a Web Worker).
// It operates on a chess.js instance, so it has no imports and can also be unit-tested in Node.

const PIECE_VALUE = { p: 100, n: 320, b: 330, r: 500, q: 900, k: 0 };
const MATE = 100000;

// Piece-square tables from White's point of view; index 0 is a8, index 63 is h1.
const PST = {
  p: [
    0, 0, 0, 0, 0, 0, 0, 0,
    50, 50, 50, 50, 50, 50, 50, 50,
    10, 10, 20, 30, 30, 20, 10, 10,
    5, 5, 10, 25, 25, 10, 5, 5,
    0, 0, 0, 20, 20, 0, 0, 0,
    5, -5, -10, 0, 0, -10, -5, 5,
    5, 10, 10, -20, -20, 10, 10, 5,
    0, 0, 0, 0, 0, 0, 0, 0,
  ],
  n: [
    -50, -40, -30, -30, -30, -30, -40, -50,
    -40, -20, 0, 0, 0, 0, -20, -40,
    -30, 0, 10, 15, 15, 10, 0, -30,
    -30, 5, 15, 20, 20, 15, 5, -30,
    -30, 0, 15, 20, 20, 15, 0, -30,
    -30, 5, 10, 15, 15, 10, 5, -30,
    -40, -20, 0, 5, 5, 0, -20, -40,
    -50, -40, -30, -30, -30, -30, -40, -50,
  ],
  b: [
    -20, -10, -10, -10, -10, -10, -10, -20,
    -10, 0, 0, 0, 0, 0, 0, -10,
    -10, 0, 5, 10, 10, 5, 0, -10,
    -10, 5, 5, 10, 10, 5, 5, -10,
    -10, 0, 10, 10, 10, 10, 0, -10,
    -10, 10, 10, 10, 10, 10, 10, -10,
    -10, 5, 0, 0, 0, 0, 5, -10,
    -20, -10, -10, -10, -10, -10, -10, -20,
  ],
  r: [
    0, 0, 0, 0, 0, 0, 0, 0,
    5, 10, 10, 10, 10, 10, 10, 5,
    -5, 0, 0, 0, 0, 0, 0, -5,
    -5, 0, 0, 0, 0, 0, 0, -5,
    -5, 0, 0, 0, 0, 0, 0, -5,
    -5, 0, 0, 0, 0, 0, 0, -5,
    -5, 0, 0, 0, 0, 0, 0, -5,
    0, 0, 0, 5, 5, 0, 0, 0,
  ],
  q: [
    -20, -10, -10, -5, -5, -10, -10, -20,
    -10, 0, 0, 0, 0, 0, 0, -10,
    -10, 0, 5, 5, 5, 5, 0, -10,
    -5, 0, 5, 5, 5, 5, 0, -5,
    0, 0, 5, 5, 5, 5, 0, -5,
    -10, 5, 5, 5, 5, 5, 0, -10,
    -10, 0, 5, 0, 0, 0, 0, -10,
    -20, -10, -10, -5, -5, -10, -10, -20,
  ],
  k: [
    -30, -40, -40, -50, -50, -40, -40, -30,
    -30, -40, -40, -50, -50, -40, -40, -30,
    -30, -40, -40, -50, -50, -40, -40, -30,
    -30, -40, -40, -50, -50, -40, -40, -30,
    -20, -30, -30, -40, -40, -30, -30, -20,
    -10, -20, -20, -20, -20, -20, -20, -10,
    20, 20, 0, 0, 0, 0, 20, 20,
    20, 30, 10, 0, 0, 10, 30, 20,
  ],
  kEnd: [
    -50, -40, -30, -20, -20, -30, -40, -50,
    -30, -20, -10, 0, 0, -10, -20, -30,
    -30, -10, 20, 30, 30, 20, -10, -30,
    -30, -10, 30, 40, 40, 30, -10, -30,
    -30, -10, 30, 40, 40, 30, -10, -30,
    -30, -10, 20, 30, 30, 20, -10, -30,
    -30, -30, 0, 0, 0, 0, -30, -30,
    -50, -30, -30, -30, -30, -30, -30, -50,
  ],
};

/** Difficulty presets. maxDepth is in plies; timeMs bounds iterative deepening; noise randomises root choice. */
export const LEVELS = {
  1: { name: 'Beginner', maxDepth: 1, timeMs: 300, noise: 300 },
  2: { name: 'Casual', maxDepth: 2, timeMs: 600, noise: 100 },
  3: { name: 'Club', maxDepth: 4, timeMs: 1200, noise: 25 },
  4: { name: 'Strong', maxDepth: 6, timeMs: 2500, noise: 0 },
  5: { name: 'Expert', maxDepth: 32, timeMs: 5000, noise: 0 },
};

// The search drives chess.js through its internal 0x88 API (_moves/_makeMove/_undoMove), which skips the
// SAN/FEN work the public API does for every move and is ~50x faster. chess.js is pinned to an exact version
// in package.json and test/engine.test.js checks these internals still exist.
const FLAG_CAPTURE = 2;
const FLAG_EP_CAPTURE = 8;
const FLAG_PROMOTION = 16;
const FILES = 'abcdefgh';

function squareName(sq) {
  return FILES[sq & 7] + (8 - (sq >> 4));
}

/** Static evaluation in centipawns from the side to move's point of view. */
export function evaluate(chess) {
  const board = chess._board;
  let score = 0;
  let nonPawnMaterial = 0;
  let whiteKing = -1;
  let blackKing = -1;
  for (let sq = 0; sq < 120; sq++) {
    if (sq & 0x88) {
      sq += 7;
      continue;
    }
    const piece = board[sq];
    if (!piece) continue;
    const r = sq >> 4;
    const idx = piece.color === 'w' ? r * 8 + (sq & 7) : (7 - r) * 8 + (sq & 7);
    if (piece.type === 'k') {
      if (piece.color === 'w') whiteKing = idx;
      else blackKing = idx;
      continue;
    }
    if (piece.type !== 'p') nonPawnMaterial += PIECE_VALUE[piece.type];
    const value = PIECE_VALUE[piece.type] + PST[piece.type][idx];
    score += piece.color === 'w' ? value : -value;
  }
  const kingTable = nonPawnMaterial <= 1300 ? PST.kEnd : PST.k;
  if (whiteKing >= 0) score += kingTable[whiteKing];
  if (blackKing >= 0) score -= kingTable[blackKing];
  return chess._turn === 'w' ? score : -score;
}

function moveKey(m) {
  return m.from * 128 + m.to + (m.promotion ? PIECE_VALUE[m.promotion] * 100000 : 0);
}

function isTactical(m) {
  return (m.flags & (FLAG_CAPTURE | FLAG_EP_CAPTURE | FLAG_PROMOTION)) !== 0;
}

function orderScore(m, hashKey, killers) {
  if (hashKey !== undefined && moveKey(m) === hashKey) return 1e6;
  let s = 0;
  if (m.captured) s += 10000 + 10 * PIECE_VALUE[m.captured] - PIECE_VALUE[m.piece];
  if (m.promotion) s += 9000 + PIECE_VALUE[m.promotion];
  if (killers && (killers[0] === moveKey(m) || killers[1] === moveKey(m))) s += 5000;
  return s;
}

class SearchTimeout extends Error {}

const TT_EXACT = 0;
const TT_LOWER = 1;
const TT_UPPER = 2;
const TT_MAX = 200000;

/**
 * Pick a move for the side to move.
 * @param chess   a chess.js instance (left unchanged on return)
 * @param options { level?: 1-5, maxDepth?, timeMs?, noise?, random?: () => number }
 * @returns { move: {from,to,promotion,san} | null, score, depth, nodes }
 */
export function findBestMove(chess, options = {}) {
  const preset = LEVELS[options.level] || LEVELS[3];
  const maxDepth = options.maxDepth ?? preset.maxDepth;
  const timeMs = options.timeMs ?? preset.timeMs;
  const noise = options.noise ?? preset.noise;
  const random = options.random || Math.random;
  const deadline = Date.now() + timeMs;

  let nodes = 0;
  const killers = [];
  const tt = new Map();
  // Positions on the current search path; a repeat of one of these, or of a game position, scores as a draw.
  const path = [];

  function checkTime() {
    if ((++nodes & 1023) === 0 && Date.now() > deadline) throw new SearchTimeout();
  }

  function isRepetition() {
    const hash = chess._hash;
    if (chess._getPositionCount(hash) > 0) return true;
    for (let i = path.length - 2; i >= 0; i -= 2) if (path[i] === hash) return true;
    return false;
  }

  function quiesce(alpha, beta, qdepth) {
    checkTime();
    const standPat = evaluate(chess);
    if (standPat >= beta) return beta;
    if (standPat > alpha) alpha = standPat;
    if (qdepth <= 0) return alpha;
    const captures = chess._moves({ legal: true }).filter(isTactical);
    captures.sort((a, b) => orderScore(b) - orderScore(a));
    for (const m of captures) {
      chess._makeMove(m);
      const score = -quiesce(-beta, -alpha, qdepth - 1);
      chess._undoMove();
      if (score >= beta) return beta;
      if (score > alpha) alpha = score;
    }
    return alpha;
  }

  function negamax(depth, alpha, beta, ply) {
    checkTime();
    if (chess._halfMoves >= 100 || isRepetition()) return 0;

    const hash = chess._hash;
    const entry = tt.get(hash);
    let hashKey;
    if (entry) {
      hashKey = entry.key;
      if (entry.depth >= depth) {
        let s = entry.score;
        if (s > MATE - 1000) s -= ply;
        else if (s < -MATE + 1000) s += ply;
        if (entry.flag === TT_EXACT) return s;
        if (entry.flag === TT_LOWER && s >= beta) return s;
        if (entry.flag === TT_UPPER && s <= alpha) return s;
      }
    }

    const inCheck = chess._isKingAttacked(chess._turn);
    // Check extension: never stop searching while in check.
    if (depth <= 0 && !inCheck) return quiesce(alpha, beta, 8);

    const moves = chess._moves({ legal: true });
    if (moves.length === 0) return inCheck ? -MATE + ply : 0;

    const plyKillers = killers[ply] || (killers[ply] = [0, 0]);
    moves.sort((a, b) => orderScore(b, hashKey, plyKillers) - orderScore(a, hashKey, plyKillers));
    const alphaOrig = alpha;
    let best = -Infinity;
    let bestKey;
    path.push(hash);
    for (const m of moves) {
      chess._makeMove(m);
      const score = -negamax(depth - 1, -beta, -alpha, ply + 1);
      chess._undoMove();
      if (score > best) {
        best = score;
        bestKey = moveKey(m);
      }
      if (score > alpha) alpha = score;
      if (alpha >= beta) {
        if (!m.captured && plyKillers[0] !== moveKey(m)) {
          plyKillers[1] = plyKillers[0];
          plyKillers[0] = moveKey(m);
        }
        break;
      }
    }
    path.pop();

    if (tt.size > TT_MAX) tt.clear();
    let stored = best;
    if (stored > MATE - 1000) stored += ply;
    else if (stored < -MATE + 1000) stored -= ply;
    tt.set(hash, {
      depth,
      score: stored,
      key: bestKey,
      flag: best <= alphaOrig ? TT_UPPER : best >= beta ? TT_LOWER : TT_EXACT,
    });
    return best;
  }

  const rootMoves = chess._moves({ legal: true });
  if (rootMoves.length === 0) {
    return { move: null, score: chess.inCheck() ? -MATE : 0, depth: 0, nodes: 0 };
  }

  let bestMove = rootMoves[0];
  let bestScore = -Infinity;
  let completedDepth = 0;
  let scored = [];
  const historyLength = chess._history.length;

  try {
    for (let depth = 1; depth <= maxDepth; depth++) {
      const pvKey = moveKey(bestMove);
      // Re-sort by the previous iteration's scores so the best candidates are searched first.
      const prev = new Map(scored.map(({ m, score }) => [m, score]));
      rootMoves.sort((a, b) => {
        if (moveKey(a) === pvKey) return -1;
        if (moveKey(b) === pvKey) return 1;
        if (prev.size) return prev.get(b) - prev.get(a);
        return orderScore(b) - orderScore(a);
      });
      const iteration = [];
      let alpha = -Infinity;
      path.push(chess._hash);
      for (const m of rootMoves) {
        chess._makeMove(m);
        // With noise we need roughly accurate scores for every root move, so search each with a wider window.
        const score = -negamax(depth - 1, -Infinity, noise > 0 ? -(alpha - noise) : -alpha, 1);
        chess._undoMove();
        iteration.push({ m, score });
        if (score > alpha) alpha = score;
      }
      path.pop();
      scored = iteration;
      completedDepth = depth;
      const top = iteration.reduce((a, b) => (b.score > a.score ? b : a));
      bestMove = top.m;
      bestScore = top.score;
      if (Math.abs(bestScore) > MATE - 1000) break;
    }
  } catch (err) {
    if (!(err instanceof SearchTimeout)) throw err;
    // The timeout can fire mid-search: restore the position.
    while (chess._history.length > historyLength) chess._undoMove();
  }

  if (noise > 0 && completedDepth > 0 && Math.abs(bestScore) < MATE - 1000) {
    let choiceScore = -Infinity;
    for (const { m, score } of scored) {
      // Moves searched with the widened window have exact scores only if within `noise` of the best.
      if (score <= bestScore - noise) continue;
      const jittered = score + (random() * 2 - 1) * noise;
      if (jittered > choiceScore) {
        choiceScore = jittered;
        bestMove = m;
      }
    }
  }

  const move = { from: squareName(bestMove.from), to: squareName(bestMove.to), promotion: bestMove.promotion };
  // Use the public API once to produce SAN for the chosen move.
  move.san = chess.move(move).san;
  chess.undo();
  return { move, score: bestScore, depth: completedDepth, nodes };
}

/**
 * Evaluate a position for an evaluation bar, from White's point of view.
 * @returns { cp, mate, depth } — cp in centipawns; mate is moves to mate (positive: White mates,
 *          negative: Black mates, 0: the side to move is already mated) or null.
 */
export function evaluatePosition(chess, { timeMs = 800 } = {}) {
  const sign = chess.turn() === 'w' ? 1 : -1;
  if (chess.isCheckmate()) return { cp: -sign * MATE, mate: 0, depth: 0, winner: sign > 0 ? 'b' : 'w' };
  if (chess.isDraw()) return { cp: 0, mate: null, depth: 0 };
  const { score, depth } = findBestMove(chess, { maxDepth: 32, timeMs, noise: 0 });
  if (Math.abs(score) > MATE - 1000) {
    const moves = Math.ceil((MATE - Math.abs(score)) / 2);
    return { cp: sign * score, mate: sign * Math.sign(score) * moves, depth };
  }
  return { cp: sign * score, mate: null, depth };
}
