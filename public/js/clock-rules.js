// Clock rules shared by the server (server/clock.js) and the browser (private games). No DOM access.

/** True if `color` has nothing but a king, or a king and a single minor piece (can never deliver mate). */
function cannotMate(fen, color) {
  const placement = fen.split(' ')[0];
  const own = [...placement].filter((ch) => /[a-z]/i.test(ch) && (color === 'w' ? ch === ch.toUpperCase() : ch === ch.toLowerCase()));
  const others = own.map((ch) => ch.toLowerCase()).filter((t) => t !== 'k');
  return others.length === 0 || (others.length === 1 && (others[0] === 'n' || others[0] === 'b'));
}

/** Result when `loser` runs out of time: a loss, or a draw if the opponent could never checkmate. */
export function timeoutResult(fen, loser) {
  const winner = loser === 'w' ? 'b' : 'w';
  const loserName = loser === 'w' ? 'white' : 'black';
  if (cannotMate(fen, winner)) return { result: '1/2-1/2', termination: `${loserName} ran out of time vs insufficient material` };
  return { result: loser === 'w' ? '0-1' : '1-0', termination: `${loserName} ran out of time` };
}
