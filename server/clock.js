// Chess clock rules. Times are stored in milliseconds on the game row:
//   time_control     JSON {initial, increment} or NULL for untimed games
//   white_ms/black_ms remaining time as of turn_started_at (or frozen, when no clock runs)
//   turn_started_at  when the side to move's clock started, or NULL while no clock runs
// Like lichess, each side's first move is untimed: clocks start once both players have moved.

export const TIMED_MODES = new Set(['online', 'computer']);
const MAX_INITIAL_S = 3 * 60 * 60;
const MAX_INCREMENT_S = 180;

/** Validate a time control given in seconds ({initial, increment}); returns ms values, or null if untimed. */
export function parseTimeControl(input) {
  if (input == null || input === false) return null;
  const initial = Number(input.initial);
  const increment = Number(input.increment ?? 0);
  if (!Number.isFinite(initial) || initial < 15 || initial > MAX_INITIAL_S) {
    throw new Error('Initial time must be between 15 seconds and 3 hours');
  }
  if (!Number.isFinite(increment) || increment < 0 || increment > MAX_INCREMENT_S) {
    throw new Error('Increment must be between 0 and 180 seconds');
  }
  return { initial: Math.round(initial * 1000), increment: Math.round(increment * 1000) };
}

/** A client-reported remaining time (used when a broadcaster starts or resumes a game), or the fallback. */
export function clampMs(value, fallback) {
  const n = Number(value);
  return Number.isFinite(n) && n > 0 && n <= MAX_INITIAL_S * 1000 * 2 ? Math.round(n) : fallback;
}

export function getTimeControl(g) {
  return g.time_control ? JSON.parse(g.time_control) : null;
}

/** Remaining time for both sides at `now`, and which clock (if any) is running. */
export function remainingTime(g, now = Date.now()) {
  const running = g.status === 'active' && g.turn_started_at ? g.fen.split(' ')[1] : null;
  const elapsed = running ? Math.max(0, now - g.turn_started_at) : 0;
  return {
    running,
    w: Math.max(0, g.white_ms - (running === 'w' ? elapsed : 0)),
    b: Math.max(0, g.black_ms - (running === 'b' ? elapsed : 0)),
  };
}

/**
 * Clock columns after a change to the game at `now`: the running side is charged for its time, gets the
 * increment if it just moved, and the next clock starts if the game stays active past the untimed opening.
 * @param opts.moved  the side to move just completed a move
 * @param opts.status the game's status after the change
 * @param opts.plies  number of moves in the game after the change
 */
export function clockFields(g, { now = Date.now(), moved = false, status = g.status, plies }) {
  const tc = getTimeControl(g);
  if (!tc) return {};
  const { running, w, b } = remainingTime(g, now);
  let white = w;
  let black = b;
  if (moved && running === 'w') white += tc.increment;
  if (moved && running === 'b') black += tc.increment;
  return { white_ms: white, black_ms: black, turn_started_at: status === 'active' && plies >= 2 ? now : null };
}

export { timeoutResult } from '../public/js/clock-rules.js';
