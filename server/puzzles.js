// Puzzles from your own mistakes: every mistake, blunder or miss you made in a reviewed game becomes a
// position to solve. The solution is checked in the browser (the engine's move, or one nearly as good).
import { Chess } from 'chess.js';
import { reviewGame, RETRY_LABELS } from '../public/js/review.js';
import { openingBook } from './review-summary.js';
import { colourOf } from './colour.js';

const MAX_GAMES = 200;

export function registerPuzzleRoutes({ app, db, q, HttpError, canView }) {
  const games = db.prepare(`
    SELECT * FROM games
    WHERE status = 'finished' AND analysis IS NOT NULL
      AND (white_id = ?1 OR black_id = ?1 OR (mode IN ('computer', 'import') AND created_by = ?1))
      AND club_id IN (SELECT club_id FROM memberships WHERE user_id = ?1)
    ORDER BY updated_at DESC LIMIT ${MAX_GAMES}`);
  const progress = db.prepare('SELECT * FROM puzzle_progress WHERE user_id = ?');
  const record = db.prepare(`
    INSERT INTO puzzle_progress (user_id, game_id, ply, solved, failed, last_result, last_at) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)
    ON CONFLICT(user_id, game_id, ply) DO UPDATE SET solved = solved + ?4, failed = failed + ?5, last_result = ?6, last_at = ?7`);

  // Reviewing a game is the slow part; positions only change when the analysis does.
  const cache = new Map();
  function mistakesIn(g) {
    const key = `${g.id}:${g.updated_at}:${g.analysis.length}`;
    const hit = cache.get(g.id);
    if (hit?.key === key) return hit.list;
    let list = [];
    try {
      const moves = JSON.parse(g.moves);
      const { positions } = JSON.parse(g.analysis);
      const review = reviewGame({ Chess, startFen: g.start_fen, moves, positions, book: openingBook() });
      const chess = new Chess(g.start_fen);
      let prev = null;
      for (const m of review.moves) {
        if (RETRY_LABELS.has(m.label) && m.bestUci && m.bestSan) {
          list.push({ ply: m.ply, color: m.color, fen: chess.fen(), played: m.san, playedUci: m.uci, bestUci: m.bestUci, bestSan: m.bestSan, label: m.label, loss: Math.round(m.loss), before: positions[m.ply - 1], lastMove: prev });
        }
        chess.move(m.san);
        prev = { from: m.from, to: m.to };
      }
    } catch {
      list = [];
    }
    cache.set(g.id, { key, list });
    if (cache.size > 2000) cache.delete(cache.keys().next().value);
    return list;
  }

  function puzzlesFor(user) {
    const seen = new Map(progress.all(user.id).map((p) => [`${p.game_id}-${p.ply}`, p]));
    const out = [];
    for (const g of games.all(user.id)) {
      const colour = colourOf(g, user.id);
      if (!colour || !canView(user, g)) continue;
      for (const m of mistakesIn(g)) {
        if (m.color !== colour) continue;
        const id = `${g.id}-${m.ply}`;
        const p = seen.get(id);
        out.push({
          id, gameId: g.id, ...m,
          opponent: colour === 'w' ? g.black_name : g.white_name,
          playedAt: g.updated_at,
          status: p ? p.last_result : 'new',
          solved: p?.solved || 0, failed: p?.failed || 0, lastAt: p?.last_at || null,
        });
      }
    }
    // Missed ones first (oldest attempt first), then new ones (most recent games first), then solved.
    const rank = { failed: 0, new: 1, solved: 2 };
    out.sort((a, b) => rank[a.status] - rank[b.status]
      || (a.status === 'new' ? b.playedAt - a.playedAt : (a.lastAt || 0) - (b.lastAt || 0))
      || a.ply - b.ply);
    return out;
  }

  app.get('/api/puzzles', (req, res) => {
    const puzzles = puzzlesFor(req.user);
    const stats = { total: puzzles.length, new: 0, solved: 0, failed: 0 };
    for (const p of puzzles) stats[p.status]++;
    res.json({ puzzles, stats });
  });

  /** Record an attempt: solved (first try, without seeing the answer) or not. */
  app.post('/api/puzzles/attempt', (req, res) => {
    const gameId = Number(req.body?.gameId);
    const ply = Number(req.body?.ply);
    const g = q.game.get(gameId);
    const colour = g && colourOf(g, req.user.id);
    if (!g || !g.analysis || !colour || !canView(req.user, g)) throw new HttpError(404, 'Puzzle not found');
    if (!mistakesIn(g).some((m) => m.ply === ply && m.color === colour)) throw new HttpError(404, 'Puzzle not found');
    const solved = req.body?.solved === true;
    record.run(req.user.id, gameId, ply, solved ? 1 : 0, solved ? 0 : 1, solved ? 'solved' : 'failed', Date.now());
    res.json({ ok: true });
  });
}
