// Tournament pairing and standings (pure functions, no database).
//
// A pairing is {round, white, black, result}: black is null for a bye; result is '1-0', '0-1',
// '1/2-1/2' or null while unplayed. Byes score 1 point for the player who receives them.

const POINTS = { '1-0': [1, 0], '0-1': [0, 1], '1/2-1/2': [0.5, 0.5] };

/**
 * Standings: points, Buchholz (sum of opponents' points), then rating.
 * @param players [{id, rating}] (withdrawn players included, so their results still count)
 * @returns [{id, points, buchholz, played, wins, draws, losses, byes, rank}] best first
 */
export function standings(players, pairings) {
  const table = new Map(players.map((p) => [p.id, {
    id: p.id, rating: p.rating ?? 0, points: 0, buchholz: 0, played: 0, wins: 0, draws: 0, losses: 0, byes: 0, opponents: [],
  }]));
  for (const p of pairings) {
    const w = table.get(p.white);
    if (p.black === null) {
      if (w) {
        w.points += 1;
        w.byes++;
      }
      continue;
    }
    const b = table.get(p.black);
    if (!p.result || !w || !b) continue;
    const [pw, pb] = POINTS[p.result];
    w.points += pw;
    b.points += pb;
    for (const [me, mine, them] of [[w, pw, b], [b, pb, w]]) {
      me.played++;
      me.opponents.push(them.id);
      if (mine === 1) me.wins++;
      else if (mine === 0.5) me.draws++;
      else me.losses++;
    }
  }
  for (const row of table.values()) row.buchholz = row.opponents.reduce((sum, id) => sum + (table.get(id)?.points || 0), 0);
  const rows = [...table.values()].sort((a, b) => b.points - a.points || b.buchholz - a.buchholz || b.rating - a.rating || a.id - b.id);
  return rows.map(({ opponents, ...row }, i) => ({ ...row, rank: i + 1 }));
}

/**
 * Round-robin schedule by the circle method; with an odd number of players one sits out (bye) each round.
 * @returns rounds: [[{white, black}]] — every player meets every other exactly once, colours alternate.
 */
export function roundRobin(playerIds) {
  const ids = [...playerIds];
  if (ids.length % 2) ids.push(null);
  const n = ids.length;
  const rounds = [];
  let ring = ids.slice(1);
  for (let r = 0; r < n - 1; r++) {
    const order = [ids[0], ...ring];
    const round = [];
    for (let i = 0; i < n / 2; i++) {
      let a = order[i];
      let b = order[n - 1 - i];
      // Alternating only the fixed player's colour keeps everyone within half a game of an even split.
      if (i === 0 && r % 2 === 1) [a, b] = [b, a];
      if (a === null) round.push({ white: b, black: null });
      else if (b === null) round.push({ white: a, black: null });
      else round.push({ white: a, black: b });
    }
    rounds.push(round);
    ring = [ring[ring.length - 1], ...ring.slice(0, -1)];
  }
  return rounds;
}

function colourBalance(id, pairings) {
  let balance = 0;
  let last = null;
  for (const p of pairings) {
    if (p.black === null) continue;
    if (p.white === id) {
      balance++;
      last = 'w';
    } else if (p.black === id) {
      balance--;
      last = 'b';
    }
  }
  return { balance, last };
}

/** Who gets White: the player who has had White less often (or had Black last); else the higher-ranked. */
function assignColours(a, b, pairings) {
  const ca = colourBalance(a, pairings);
  const cb = colourBalance(b, pairings);
  if (ca.balance !== cb.balance) return ca.balance < cb.balance ? { white: a, black: b } : { white: b, black: a };
  if (ca.last !== cb.last && ca.last && cb.last) return ca.last === 'b' ? { white: a, black: b } : { white: b, black: a };
  return { white: a, black: b };
}

/**
 * Pair a Swiss round: players ranked by points then rating; the lowest-ranked player without a bye sits
 * out if the number is odd; then each player is paired with the closest-ranked opponent they haven't
 * met, backtracking when needed (rematches only if there is no other way).
 * @param players [{id, rating}] active players
 * @param pairings all previous pairings
 * @returns [{white, black}] (black null for the bye)
 */
export function swissRound(players, pairings) {
  const table = standings(players, pairings);
  const ranked = table.map((r) => r.id);
  const met = new Set();
  const hadBye = new Set();
  for (const p of pairings) {
    if (p.black === null) hadBye.add(p.white);
    else met.add(`${p.white}-${p.black}`).add(`${p.black}-${p.white}`);
  }
  const result = [];
  let pool = ranked;
  if (pool.length % 2) {
    const bye = [...pool].reverse().find((id) => !hadBye.has(id)) ?? pool[pool.length - 1];
    pool = pool.filter((id) => id !== bye);
    result.push({ white: bye, black: null });
  }

  const pair = (remaining, allowRematch) => {
    if (!remaining.length) return [];
    const [first, ...rest] = remaining;
    for (const opponent of rest) {
      if (!allowRematch && met.has(`${first}-${opponent}`)) continue;
      const tail = pair(rest.filter((id) => id !== opponent), allowRematch);
      if (tail) return [[first, opponent], ...tail];
    }
    return null;
  };
  const pairs = pair(pool, false) || pair(pool, true);
  for (const [a, b] of pairs) result.push(assignColours(a, b, pairings));
  // Top boards first; the bye last.
  return [...result.filter((p) => p.black !== null), ...result.filter((p) => p.black === null)];
}

/** Sensible default number of Swiss rounds for a field. */
export function suggestedSwissRounds(count) {
  return Math.max(1, Math.min(count - 1, Math.ceil(Math.log2(Math.max(2, count))) + 1));
}
