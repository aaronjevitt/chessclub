import { el } from './dom.js';

/** Ranked list of rated members (club page, projector). */
export function leaderboardTable(board, { limit = Infinity, me = null } = {}) {
  return el('ol', { class: 'leaderboard' }, board.slice(0, limit).map((r, i) => el('li', { class: r.id === me ? 'me' : '' },
    el('span', { class: 'lb-rank' }, String(i + 1)),
    el('a', { href: `#/player/${r.id}`, class: 'lb-name' }, r.username),
    el('span', { class: 'lb-record muted small' }, `${r.wins}–${r.draws}–${r.losses}`),
    el('span', { class: 'lb-rating', title: r.provisional ? `Provisional (${r.games} of 10 games)` : `${r.games} rated games` },
      `${r.rating}${r.provisional ? '?' : ''}`))));
}
