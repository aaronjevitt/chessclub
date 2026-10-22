// Small card for a game (mini board, players, status), used on the home, club and profile pages.
import { el, timeAgo } from './dom.js';
import { renderMiniBoard } from './board.js';
import { MODE_LABEL, resultText } from './game-view.js';
import { tcLabel } from './time-control.js';

export function gameCard(g, { local = false } = {}) {
  const href = local ? `#/local/${g.id}` : `#/game/${g.id}`;
  const fen = g.fen || g.startFen;
  let status;
  if (g.status === 'waiting') status = 'Open challenge';
  else status = resultText(g) || `${g.moves.length ? `${g.moves.length} move${g.moves.length === 1 ? '' : 's'}` : 'Not started'} · ${fen.split(' ')[1] === 'w' ? 'White' : 'Black'} to move`;
  return el('a', { href, class: 'game-card' },
    renderMiniBoard(fen),
    el('div', { class: 'game-card-info' },
      el('div', { class: 'players' },
        el('span', { class: 'pw' }, g.white.name || '?'), el('span', { class: 'vs' }, ' vs '), el('span', { class: 'pb' }, g.black.name || '?')),
      el('div', { class: 'badges' },
        el('span', { class: `badge mode-${g.mode}` }, MODE_LABEL[g.mode]),
        g.timeControl ? el('span', { class: 'badge' }, `⏱ ${tcLabel(g.timeControl)}`) : null,
        g.visibility === 'private' || local ? el('span', { class: 'badge private' }, '🔒 Private') : null,
        !local && g.status === 'active' ? el('span', { class: 'badge live' }, '● Live') : null),
      el('div', { class: 'muted small' }, status),
      g.clubName && !local ? el('div', { class: 'muted small' }, g.clubName) : null,
      el('div', { class: 'muted small' }, timeAgo(g.updatedAt))));
}
