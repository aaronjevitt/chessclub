// Small card for a game (mini board, players, status), used on the home, club and profile pages.
import { el, timeAgo } from './dom.js';
import { renderMiniBoard } from './board.js';
import { MODE_LABEL, resultText } from './game-view.js';
import { tcLabel } from './time-control.js';

/**
 * @param opts.showClub  include the club name (off on the club's own page)
 * @param opts.extra     an extra line, e.g. review accuracy on profiles
 */
export function gameCard(g, { local = false, showClub = true, extra = null } = {}) {
  const href = g.href || (local ? `#/local/${g.id}` : `#/game/${g.id}`);
  // A member's live Lichess game: say whose it is, since the names are Lichess usernames.
  if (g.source === 'lichess' && g.member && !extra) extra = `${g.member.username}'s game on Lichess`;
  const fen = g.fen || g.startFen;
  let status;
  if (g.status === 'waiting') status = 'Open challenge';
  else if (g.status === 'active') status = `${g.moves.length ? `Move ${Math.ceil(g.moves.length / 2)}` : 'Not started'} · ${fen.split(' ')[1] === 'w' ? 'White' : 'Black'} to move`;
  else status = resultText(g);
  const facts = [g.mode !== 'online' ? MODE_LABEL[g.mode] : null, g.timeControl ? tcLabel(g.timeControl) : null].filter(Boolean);
  const where = [showClub && !local ? g.clubName : null, timeAgo(g.updatedAt)].filter(Boolean);
  return el('a', { href, class: 'game-card' },
    renderMiniBoard(fen),
    el('div', { class: 'game-card-info' },
      el('div', { class: 'players' },
        el('span', { class: 'pw' }, g.white.name || '?'), el('span', { class: 'vs' }, ' vs '), el('span', { class: 'pb' }, g.black.name || '?'),
        !local && g.status === 'active' ? el('span', { class: 'badge live' }, 'Live') : null,
        g.visibility === 'private' || local ? el('span', { class: 'badge private' }, 'Private') : null),
      el('div', { class: 'small' }, status),
      el('div', { class: 'muted small' }, [...facts, ...where].join(' · ')),
      extra ? el('div', { class: 'muted small' }, extra) : null));
}
