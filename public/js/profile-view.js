// Player profile page: club ratings with history graphs, records, review accuracy, recent games.
import { api } from './api.js';
import { el, clear } from './dom.js';
import { gameCard } from './game-card.js';
import { changePasswordForm, notificationsCard } from './account-view.js';
import { lichessProfileCard } from './lichess.js';
import { START_RATING } from './rating-constants.js';

/** Small line chart of a rating over time (starts from the initial rating). */
function ratingGraph(history) {
  const NS = 'http://www.w3.org/2000/svg';
  const points = [START_RATING, ...history.map((h) => h.rating)];
  const min = Math.min(...points) - 20;
  const max = Math.max(...points) + 20;
  const W = 300;
  const H = 70;
  const x = (i) => (points.length === 1 ? W / 2 : (i / (points.length - 1)) * W);
  const y = (r) => H - ((r - min) / (max - min)) * H;
  const svg = document.createElementNS(NS, 'svg');
  svg.setAttribute('viewBox', `0 0 ${W} ${H}`);
  svg.setAttribute('preserveAspectRatio', 'none');
  svg.setAttribute('class', 'rating-graph');
  const line = document.createElementNS(NS, 'polyline');
  line.setAttribute('points', points.map((r, i) => `${x(i)},${y(r)}`).join(' '));
  svg.appendChild(line);
  return svg;
}

function record(label, r) {
  const total = r.w + r.d + r.l;
  return el('div', { class: 'stat' },
    el('div', { class: 'stat-value' }, total ? `${r.w}–${r.d}–${r.l}` : '—'),
    el('div', { class: 'stat-label muted small' }, `${label}${total ? ` · ${Math.round(((r.w + r.d / 2) / total) * 100)}%` : ''}`));
}

export async function profileView(main, id, params = new URLSearchParams()) {
  const p = await api(`/users/${id}`);
  const { user } = p;
  clear(main, el('div', { class: 'profile' },
    el('section', { class: 'card profile-header' },
      el('div', {},
        el('h1', {}, user.username, user.isMe ? el('span', { class: 'muted small' }, ' (you)') : null),
        el('div', { class: 'muted small' }, `Member since ${new Date(user.joinedAt).toLocaleDateString()}`),
        user.isMe ? el('button', {
          type: 'button', class: 'btn small profile-logout',
          onclick: async () => {
            await api('/logout', { method: 'POST' }).catch(() => {});
            location.hash = '#/login';
            location.reload();
          },
        }, 'Log out') : null),
      el('div', { class: 'stats' },
        record('vs members', p.record.members),
        record('vs computer', p.record.computer),
        el('div', { class: 'stat' },
          el('div', { class: 'stat-value' }, p.accuracy === null ? '—' : `${p.accuracy}%`),
          el('div', { class: 'stat-label muted small' }, `avg accuracy · ${p.reviewedGames} reviewed`)))),
    el('section', {},
      el('h2', {}, 'Club ratings'),
      el('div', { class: 'rating-cards' }, p.clubs.map((c) => el('a', { href: `#/club/${c.id}`, class: 'card rating-card' },
        el('div', { class: 'muted small' }, c.name),
        el('div', { class: 'rating-big' }, `${c.rating}${c.provisional ? '?' : ''}`),
        el('div', { class: 'muted small' }, c.games ? `${c.games} rated game${c.games === 1 ? '' : 's'}${c.provisional ? ' · provisional' : ''}` : 'No rated games yet'),
        c.history.length ? ratingGraph(c.history) : null)))),
    lichessProfileCard({ isMe: user.isMe, info: p.lichess, status: user.isMe ? params.get('lichess') : null }),
    el('section', {},
      el('h2', {}, 'Recent games'),
      p.recent.length
        ? el('div', { class: 'game-grid' }, p.recent.map((g) => gameCard(g, { extra: g.accuracy !== null ? `Accuracy ${g.accuracy}%` : null })))
        : el('p', { class: 'muted' }, 'No finished games yet.')),
    user.isMe ? el('section', {},
      el('h2', {}, 'Settings'),
      el('div', { class: 'settings-grid' },
        notificationsCard(),
        el('section', { class: 'card' }, el('h2', {}, 'Change password'), changePasswordForm()))) : null));
}
