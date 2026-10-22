// Player profiles: club ratings and history, records, review accuracy and recent games.
import { summarizeReview } from './review-summary.js';
import { PROVISIONAL_GAMES } from './ratings.js';
import { colourOf } from './colour.js';

export function registerProfileRoutes({ app, db, q, HttpError, ratings, serializeGame, canView }) {
  const user = db.prepare('SELECT id, username, created_at FROM users WHERE id = ?');
  const sharedClubs = db.prepare(`
    SELECT c.id, c.name, theirs.rating, theirs.rated_games FROM memberships theirs
    JOIN memberships mine ON mine.club_id = theirs.club_id AND mine.user_id = ?
    JOIN clubs c ON c.id = theirs.club_id
    WHERE theirs.user_id = ? ORDER BY c.name COLLATE NOCASE`);
  const games = db.prepare(`
    SELECT g.*, c.name AS club_name FROM games g JOIN clubs c ON c.id = g.club_id
    WHERE g.status = 'finished' AND (g.white_id = ?1 OR g.black_id = ?1 OR (g.mode IN ('computer', 'import') AND g.created_by = ?1))
      AND g.club_id IN (SELECT club_id FROM memberships WHERE user_id = ?2)
    ORDER BY g.updated_at DESC LIMIT 300`);
  const saveAnalysis = db.prepare('UPDATE games SET analysis = ? WHERE id = ?');

  /** Stored review summary for a game, computing (and saving) it for older reviews. */
  function reviewSummary(g) {
    if (!g.analysis) return null;
    const analysis = JSON.parse(g.analysis);
    if (!analysis.summary) {
      analysis.summary = summarizeReview(g, analysis);
      if (!analysis.summary) return null;
      saveAnalysis.run(JSON.stringify(analysis), g.id);
    }
    return analysis.summary;
  }

  app.get('/api/users/:id', (req, res) => {
    const target = user.get(Number(req.params.id));
    const clubs = target ? sharedClubs.all(req.user.id, target.id) : [];
    // You can see your own profile, and those of people who share a club with you.
    if (!target || (target.id !== req.user.id && !clubs.length)) throw new HttpError(404, 'Player not found');

    const record = { members: { w: 0, d: 0, l: 0 }, computer: { w: 0, d: 0, l: 0 } };
    const accuracies = [];
    const recent = [];
    for (const g of games.all(target.id, req.user.id)) {
      const colour = colourOf(g, target.id);
      if (!colour || !canView(req.user, g)) continue;
      // Imported games (played elsewhere) count towards accuracy but not the club records.
      const bucket = g.mode === 'online' ? record.members : g.mode === 'computer' ? record.computer : null;
      if (bucket) {
        if (g.result === '1/2-1/2') bucket.d++;
        else if ((g.result === '1-0') === (colour === 'w')) bucket.w++;
        else if (g.result === '1-0' || g.result === '0-1') bucket.l++;
      }
      const summary = reviewSummary(g);
      const accuracy = summary?.accuracy?.[colour] ?? null;
      if (accuracy !== null) accuracies.push(accuracy);
      if (recent.length < 30) recent.push({ ...serializeGame(g), colour, accuracy });
    }
    res.json({
      user: { id: target.id, username: target.username, joinedAt: target.created_at, isMe: target.id === req.user.id },
      clubs: clubs.map((c) => ({
        id: c.id, name: c.name, rating: c.rating, games: c.rated_games, provisional: c.rated_games < PROVISIONAL_GAMES,
        history: ratings.history(c.id, target.id).map((h) => ({ rating: h.rating, delta: h.delta, at: h.at })),
      })),
      record,
      accuracy: accuracies.length ? Math.round((accuracies.reduce((a, b) => a + b, 0) / accuracies.length) * 10) / 10 : null,
      reviewedGames: accuracies.length,
      recent,
    });
  });

  return { reviewSummary };
}
