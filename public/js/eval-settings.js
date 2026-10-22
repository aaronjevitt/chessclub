// Evaluation bar settings shared by the setup forms, game view and projector (no DOM or engine imports).

// With a move limit, the bar fades out over this many half-moves before it disappears.
export const EVAL_FADE_PLIES = 10;

/**
 * How visible a game's eval bar is (0-1) after `plies` half-moves of live play. Without a limit it is
 * always fully shown; with meta.evalBarMoves = N it fades over the last 5 moves and is gone once both
 * sides have played move N. Finished games always show it in full.
 */
export function evalBarVisibility(meta, plies, active = true) {
  if (!meta?.evalBar) return 0;
  const limit = Number(meta.evalBarMoves);
  if (!active || !limit) return 1;
  const fade = Math.min(EVAL_FADE_PLIES, limit * 2);
  return Math.max(0, Math.min(1, (limit * 2 - plies) / fade));
}

export function evalBarLabel(meta) {
  return meta?.evalBarMoves ? `Eval bar · first ${meta.evalBarMoves} moves` : 'Eval bar';
}
