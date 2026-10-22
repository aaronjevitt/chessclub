// Computer opponents: named Stockfish bots at fixed ratings, or any custom Elo.

export const MIN_ELO = 400;
export const MAX_ELO = 3190;
// Stockfish's own strength limiter (UCI_Elo) covers 1320-3190; below that we weaken it further ourselves.
export const STOCKFISH_MIN_ELO = 1320;

export const BOTS = [
  { name: 'Pip', elo: 400, blurb: 'Just learned how the pieces move' },
  { name: 'Rae', elo: 800, blurb: 'Knows the basics, still hangs pieces' },
  { name: 'Cal', elo: 1200, blurb: 'Casual player' },
  { name: 'Clara', elo: 1500, blurb: 'Solid club player' },
  { name: 'Theo', elo: 1800, blurb: 'Strong tournament player' },
  { name: 'Eva', elo: 2100, blurb: 'Expert' },
  { name: 'Max', elo: 2400, blurb: 'International Master strength' },
  { name: 'Gia', elo: 2800, blurb: 'World-class grandmaster' },
  { name: 'Stockfish', elo: MAX_ELO, blurb: 'Full strength' },
];

// Games created before Elo bots stored a level 1-5.
const LEGACY_LEVEL_ELO = { 1: 600, 2: 1000, 3: 1400, 4: 1800, 5: 2200 };

export function clampElo(elo) {
  const n = Math.round(Number(elo));
  return Number.isFinite(n) ? Math.min(MAX_ELO, Math.max(MIN_ELO, n)) : 1500;
}

/** The rating the computer plays at in a game (meta from a computer game). */
export function gameElo(meta = {}) {
  if (meta.elo) return clampElo(meta.elo);
  return LEGACY_LEVEL_ELO[meta.level] || 1400;
}

export function botName(elo, name) {
  return name ? `${name} (${elo})` : `Stockfish (${elo})`;
}

export function isApproximate(elo) {
  return elo < STOCKFISH_MIN_ELO;
}
