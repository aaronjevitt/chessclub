import { Chess } from 'chess.js';

export const START_FEN = 'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1';

/** Rebuild a chess.js instance from a starting FEN and a list of SAN moves. Throws on an illegal move. */
export function replay(startFen, moves) {
  const chess = new Chess(startFen || START_FEN);
  for (const san of moves) {
    chess.move(san);
  }
  return chess;
}

/** Returns { result, termination } if the position is game over, otherwise null. */
export function gameOverInfo(chess) {
  if (chess.isCheckmate()) {
    return { result: chess.turn() === 'w' ? '0-1' : '1-0', termination: 'checkmate' };
  }
  if (chess.isStalemate()) return { result: '1/2-1/2', termination: 'stalemate' };
  if (chess.isInsufficientMaterial()) return { result: '1/2-1/2', termination: 'insufficient material' };
  if (chess.isThreefoldRepetition()) return { result: '1/2-1/2', termination: 'threefold repetition' };
  if (chess.isDrawByFiftyMoves()) return { result: '1/2-1/2', termination: 'fifty-move rule' };
  return null;
}

/** Apply a move given as SAN string or {from, to, promotion}. Returns the SAN, or null if illegal. */
export function tryMove(chess, move) {
  try {
    const input = typeof move === 'string' ? move : { from: move.from, to: move.to, promotion: move.promotion };
    return chess.move(input).san;
  } catch {
    return null;
  }
}

export function isValidFen(fen) {
  try {
    new Chess(fen);
    return true;
  } catch {
    return false;
  }
}
