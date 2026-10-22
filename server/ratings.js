// Club ratings: Elo, per member per club. New members start at 1200; the first 10 rated games
// move the rating faster so players settle near their level quickly.

export const START_RATING = 1200;
export const PROVISIONAL_GAMES = 10;

export function kFactor(rating, games) {
  if (games < PROVISIONAL_GAMES) return 40;
  if (rating >= 2100) return 16;
  return 24;
}

export function expectedScore(rating, opponent) {
  return 1 / (1 + 10 ** ((opponent - rating) / 400));
}

/** New ratings after a game; `score` is White's result (1, 0.5 or 0). */
export function eloUpdate(white, black, score) {
  const kw = kFactor(white.rating, white.games);
  const kb = kFactor(black.rating, black.games);
  const ew = expectedScore(white.rating, black.rating);
  const dw = Math.round(kw * (score - ew));
  const db = Math.round(kb * ((1 - score) - (1 - ew)));
  return { white: white.rating + dw, black: black.rating + db, whiteDelta: dw, blackDelta: db };
}

export function scoreFromResult(result) {
  return { '1-0': 1, '0-1': 0, '1/2-1/2': 0.5 }[result];
}

/**
 * Rating storage and updates. `rateResult` records a finished game or tournament result and returns
 * {w: {before, after, delta}, b: {...}}, or null if either player is no longer in the club.
 */
export function createRatings(db) {
  const member = db.prepare('SELECT rating, rated_games FROM memberships WHERE club_id = ? AND user_id = ?');
  const setRating = db.prepare('UPDATE memberships SET rating = ?, rated_games = rated_games + 1 WHERE club_id = ? AND user_id = ?');
  const addHistory = db.prepare(`INSERT INTO rating_history (club_id, user_id, game_id, pairing_id, opponent_id, result, rating, delta, at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`);
  const leaderboard = db.prepare(`
    SELECT u.id, u.username, m.rating, m.rated_games,
      (SELECT COUNT(*) FROM rating_history h WHERE h.club_id = m.club_id AND h.user_id = u.id AND h.result = 1) AS wins,
      (SELECT COUNT(*) FROM rating_history h WHERE h.club_id = m.club_id AND h.user_id = u.id AND h.result = 0.5) AS draws,
      (SELECT COUNT(*) FROM rating_history h WHERE h.club_id = m.club_id AND h.user_id = u.id AND h.result = 0) AS losses
    FROM memberships m JOIN users u ON u.id = m.user_id
    WHERE m.club_id = ? AND m.rated_games > 0
    ORDER BY m.rating DESC, m.rated_games DESC, u.username COLLATE NOCASE`);
  const history = db.prepare('SELECT rating, delta, at, game_id, pairing_id FROM rating_history WHERE club_id = ? AND user_id = ? ORDER BY at, rowid');

  function rateResult({ clubId, whiteId, blackId, result, gameId = null, pairingId = null, at = Date.now() }) {
    const score = scoreFromResult(result);
    const w = member.get(clubId, whiteId);
    const b = member.get(clubId, blackId);
    if (score === undefined || !w || !b || whiteId === blackId) return null;
    const next = eloUpdate({ rating: w.rating, games: w.rated_games }, { rating: b.rating, games: b.rated_games }, score);
    setRating.run(next.white, clubId, whiteId);
    setRating.run(next.black, clubId, blackId);
    addHistory.run(clubId, whiteId, gameId, pairingId, blackId, score, next.white, next.whiteDelta, at);
    addHistory.run(clubId, blackId, gameId, pairingId, whiteId, 1 - score, next.black, next.blackDelta, at);
    return {
      w: { before: w.rating, after: next.white, delta: next.whiteDelta },
      b: { before: b.rating, after: next.black, delta: next.blackDelta },
    };
  }

  return {
    rateResult,
    ratingOf: (clubId, userId) => member.get(clubId, userId) || null,
    leaderboard: (clubId) => leaderboard.all(clubId).map((r) => ({
      id: r.id, username: r.username, rating: r.rating, games: r.rated_games,
      provisional: r.rated_games < PROVISIONAL_GAMES, wins: r.wins, draws: r.draws, losses: r.losses,
    })),
    history: (clubId, userId) => history.all(clubId, userId),
  };
}
