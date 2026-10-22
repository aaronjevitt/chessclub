// Projector view: every live club game, as large as the screen allows, updating in real time.
import { Chess } from '/vendor/chess.js';
import { api, getSocket } from './api.js';
import { el, clear, timeAgo } from './dom.js';
import { renderMiniBoard } from './board.js';
import { MODE_LABEL, resultText } from './game-view.js';
import { Evaluator, createEvalBar } from './eval-bar.js';
import { evalBarVisibility, evalBarLabel } from './eval-settings.js';
import { formatClock, tcLabel, speedName } from './time-control.js';
import { leaderboardTable } from './leaderboard-view.js';
import { tournamentPanel } from './tournament-view.js';

// Finished games stay on screen this long so the room can see the result.
const SHOW_FINISHED_MS = 30 * 1000;
const GAP = 20;
// Width of the eval bar plus its gap, relative to the board size (see .tv-board-row in style.css).
const EVAL_BAR_WIDTH = 0.07;

function boardDecorations(game) {
  const chess = new Chess(game.startFen);
  for (const san of game.moves) chess.move(san);
  const last = chess.history({ verbose: true }).at(-1);
  let check = null;
  if (chess.inCheck()) {
    for (const row of chess.board()) {
      for (const p of row) if (p && p.type === 'k' && p.color === chess.turn()) check = p.square;
    }
  }
  return { lastMove: last ? { from: last.from, to: last.to } : null, check };
}

// Clock elements on screen, ticked between server updates.
let clockRefs = [];

function clockRemaining(game, color) {
  const c = game.clock;
  const base = color === 'w' ? c.white : c.black;
  return Math.max(0, base - (game.status === 'active' && c.running === color ? Date.now() - c.since : 0));
}

function tickClocks() {
  for (const { el: clockEl, game, color } of clockRefs) {
    const ms = clockRemaining(game, color);
    clockEl.textContent = formatClock(ms);
    const running = game.status === 'active' && game.clock.running === color;
    clockEl.classList.toggle('running', running);
    clockEl.classList.toggle('low', running && ms < Math.min(20000, game.timeControl.initial * 200));
  }
}

function playerRow(game, color) {
  const side = color === 'w' ? game.white : game.black;
  const toMove = game.status === 'active' && game.turn === color;
  let clockEl = null;
  if (game.clock) {
    clockEl = el('span', { class: 'clock' });
    clockRefs.push({ el: clockEl, game, color });
  }
  return el('div', { class: `tv-player ${toMove ? 'to-move' : ''}` },
    el('span', { class: `turn-dot ${toMove ? 'on' : ''} ${color === 'w' ? 'white' : 'black'}` }),
    el('span', { class: 'tv-name' }, side.name || '?'),
    clockEl);
}

function tile(game, evalBar) {
  const moveNo = Math.ceil(game.moves.length / 2);
  const board = renderMiniBoard(game.fen, 'white', boardDecorations(game));
  const result = resultText(game);
  const boardEl = el('div', { class: 'tv-board' }, board,
    result ? el('div', { class: 'tv-result' }, el('strong', {}, game.result.replace('1/2', '½')), el('span', {}, result)) : null);
  return el('a', { href: `#/game/${game.id}`, class: `tv-tile ${game.status !== 'active' ? 'finished' : ''}` },
    playerRow(game, 'b'),
    evalBar ? el('div', { class: 'tv-board-row' }, evalBar.el, boardEl) : boardEl,
    playerRow(game, 'w'),
    el('div', { class: 'tv-meta' }, MODE_LABEL[game.mode], game.timeControl ? ` · ${tcLabel(game.timeControl)}` : '',
      moveNo ? ` · move ${moveNo}` : ''));
}

/** Small tile for the strip of just-finished games along the bottom of the screen. */
function finishedTile(game) {
  const score = game.result === '1/2-1/2' ? '½-½' : game.result;
  return el('a', { href: `#/game/${game.id}`, class: 'tv-done' },
    renderMiniBoard(game.fen, 'white', boardDecorations(game)),
    el('div', { class: 'tv-done-info' },
      el('div', { class: 'tv-done-score' }, score),
      el('div', { class: 'tv-done-names' }, game.white.name || '?'),
      el('div', { class: 'tv-done-names' }, game.black.name || '?'),
      el('div', { class: 'tv-done-why' }, game.termination || '')));
}

/** An open challenge, for the strip shown when no games are in progress. */
function challengeCard(g) {
  const colour = g.creatorColor === 'random' ? 'random colours' : `plays ${g.creatorColor}`;
  return el('div', { class: 'tv-challenge' },
    el('div', { class: 'tv-challenge-tc' },
      el('strong', {}, g.timeControl ? tcLabel(g.timeControl) : '∞'),
      el('span', {}, speedName(g.timeControl))),
    el('div', { class: 'tv-challenge-info' },
      el('div', { class: 'tv-challenge-who' }, g.creatorName,
        el('span', { class: 'muted' }, g.invitedName ? ` challenges ${g.invitedName}` : ' is looking for a game')),
      el('div', { class: 'muted' }, `${colour}${g.meta?.evalBar ? ` · ${evalBarLabel(g.meta).toLowerCase()}` : ''} · ${timeAgo(g.createdAt)}`)));
}

export async function mountTvView(root, clubId) {
  const socket = getSocket();
  const { club, membership } = await api(`/clubs/${clubId}`);
  if (!membership) throw new Error('Join this club to use its projector view');

  const liveCount = el('span', { class: 'tv-live' });
  const clock = el('span', { class: 'tv-clock' });
  const grid = el('div', { class: 'tv-grid' });
  const finishedStrip = el('div', { class: 'tv-finished', hidden: true });
  const challengeStrip = el('div', { class: 'tv-challenges', hidden: true });
  // A running tournament gets a side panel with the current round and standings.
  const side = el('div', { class: 'tv-side', hidden: true });
  const fullscreenBtn = el('button', {
    type: 'button',
    class: 'btn ghost small',
    onclick: () => (document.fullscreenElement ? document.exitFullscreen() : document.documentElement.requestFullscreen()).catch(() => {}),
  }, '⛶ Fullscreen');
  clear(root, el('div', { class: 'tv' },
    el('header', { class: 'tv-header' },
      el('div', { class: 'tv-title' }, el('span', { class: 'logo-mark' }, '♞'), club.name, liveCount),
      el('div', { class: 'row' }, clock, fullscreenBtn, el('a', { href: `#/club/${club.id}`, class: 'btn ghost small' }, 'Exit'))),
    el('div', { class: 'tv-body' }, grid, side),
    finishedStrip,
    challengeStrip));
  document.body.classList.add('tv-mode');

  let games = [];
  let challenges = [];
  let leaderboard = [];
  const finishedAt = new Map();
  const evaluator = new Evaluator({ timeMs: 700 });
  // One bar per game, reused across re-renders so it animates from its previous value.
  const evalBars = new Map();

  function evalBarFor(game) {
    const visibility = evalBarVisibility(game.meta, game.moves.length, game.status === 'active');
    if (!visibility) return null;
    let bar = evalBars.get(game.id);
    if (!bar) {
      bar = createEvalBar();
      evalBars.set(game.id, bar);
    }
    bar.el.style.opacity = String(visibility);
    const key = game.moves.length;
    bar.el.dataset.key = key;
    evaluator.evaluate(`game:${game.id}`, game.startFen, game.moves).then((r) => {
      if (r && bar.el.dataset.key === String(key)) bar.set(r);
    });
    return bar;
  }

  const liveGames = () => games.filter((g) => g.status === 'active');
  const hasEvalBars = () => liveGames().some((g) => evalBarVisibility(g.meta, g.moves.length) > 0);

  function layout() {
    const n = liveGames().length;
    if (!n) return;
    const style = getComputedStyle(grid);
    const width = grid.clientWidth - parseFloat(style.paddingLeft) - parseFloat(style.paddingRight);
    const height = grid.clientHeight - parseFloat(style.paddingTop) - parseFloat(style.paddingBottom);
    // Each tile is a square board plus player rows (~22% of the board height). Pick the column count
    // that gives the biggest boards.
    let best = { size: 0, cols: 1 };
    for (let cols = 1; cols <= n; cols++) {
      const rows = Math.ceil(n / cols);
      const byWidth = (width - GAP * (cols - 1)) / cols / (hasEvalBars() ? 1 + EVAL_BAR_WIDTH : 1);
      const byHeight = (height - GAP * (rows - 1)) / rows / 1.22;
      const size = Math.floor(Math.min(byWidth, byHeight));
      if (size > best.size) best = { size, cols };
    }
    grid.style.setProperty('--tv-board', `${best.size}px`);
    const tileWidth = Math.floor(best.size * (hasEvalBars() ? 1 + EVAL_BAR_WIDTH : 1));
    grid.style.gridTemplateColumns = `repeat(${best.cols}, ${tileWidth}px)`;
  }

  function render() {
    const now = Date.now();
    const live = games.filter((g) => g.status === 'active').length;
    clear(liveCount, live ? el('span', { class: 'live-text' }, ` ● ${live} live`) : '');
    clear(clock, new Date(now).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }));
    // Just-finished games sit small along the bottom; live games get the rest of the screen.
    const finished = games.filter((g) => g.status !== 'active');
    finishedStrip.hidden = !finished.length;
    clear(finishedStrip, finished.length ? el('div', { class: 'tv-finished-label' }, 'Finished') : null, finished.map(finishedTile));
    const active = liveGames();
    for (const id of evalBars.keys()) if (!active.some((g) => g.id === id)) evalBars.delete(id);
    clockRefs = [];
    // With nothing being played, open challenges fill the bottom of the screen so people can pick one up.
    const showChallenges = !active.length && challenges.length > 0;
    challengeStrip.hidden = !showChallenges;
    clear(challengeStrip, showChallenges
      ? [el('div', { class: 'tv-challenges-title' }, `Open challenges (${challenges.length})`),
        el('div', { class: 'tv-challenges-list' }, challenges.map(challengeCard))]
      : null);
    if (!active.length) {
      grid.style.gridTemplateColumns = '';
      const message = el('div', { class: 'tv-empty' },
        el('div', { class: 'tv-empty-icon' }, '♞'),
        el('div', {}, 'No games in progress'),
        el('div', { class: 'muted' }, showChallenges
          ? `Accept a challenge on your phone: ${club.name} → Open challenges.`
          : 'Live club games will appear here automatically.'));
      // Between games, the club leaderboard keeps the screen interesting.
      clear(grid, leaderboard.length
        ? el('div', { class: 'tv-idle' }, message, el('div', { class: 'tv-leaderboard' }, el('h2', {}, 'Club ratings'), leaderboardTable(leaderboard, { limit: 10 })))
        : message);
      return;
    }
    clear(grid, active.map((g) => tile(g, evalBarFor(g))));
    tickClocks();
    layout();
  }

  async function load() {
    let data;
    try {
      data = await api(`/clubs/${club.id}/games`);
    } catch {
      return;
    }
    const now = Date.now();
    // Clock readings count down from the moment they arrived.
    for (const g of [...data.active, ...data.finished]) if (g.clock) g.clock.since = now;
    for (const g of data.finished) {
      if (finishedAt.has(g.id)) continue;
      // Time games that end while on screen by this display's clock; for games that had already
      // ended when the page loaded, fall back to the server's timestamp.
      finishedAt.set(g.id, games.some((shown) => shown.id === g.id) ? now : g.updatedAt);
    }
    games = [...data.active, ...data.finished.filter((g) => g.mode !== 'import' && now - finishedAt.get(g.id) < SHOW_FINISHED_MS)]
      // Private games are never shown on a shared screen.
      .filter((g) => g.visibility === 'club')
      // Sort by id so boards keep their place on screen as moves come in.
      .sort((a, b) => a.id - b.id);
    challenges = data.waiting.filter((g) => g.visibility === 'club').sort((a, b) => a.createdAt - b.createdAt);
    try {
      ({ leaderboard } = await api(`/clubs/${club.id}/leaderboard`));
    } catch {
      leaderboard = [];
    }
    try {
      const { tournaments } = await api(`/clubs/${club.id}/tournaments`);
      const running = tournaments.find((t) => t.status === 'running');
      const detail = running ? await api(`/tournaments/${running.id}`) : null;
      side.hidden = !detail;
      clear(side, detail ? tournamentPanel(detail) : null);
    } catch {
      side.hidden = true;
    }
    render();
    scheduleExpiry();
  }

  // Re-render exactly when the next finished game's time on screen is up.
  let expiryTimer = null;
  function scheduleExpiry() {
    clearTimeout(expiryTimer);
    const remaining = games
      .filter((g) => g.status !== 'active')
      .map((g) => finishedAt.get(g.id) + SHOW_FINISHED_MS - Date.now());
    if (remaining.length) expiryTimer = setTimeout(load, Math.max(0, Math.min(...remaining)) + 50);
  }

  let timer = null;
  const onChanged = ({ clubId: changed }) => {
    if (changed !== club.id) return;
    clearTimeout(timer);
    timer = setTimeout(load, 100);
  };
  const watch = () => socket.emit('watch:club', club.id);
  socket.on('club:changed', onChanged);
  socket.on('tournament:changed', onChanged);
  socket.on('connect', watch);
  if (socket.connected) watch();
  window.addEventListener('resize', layout);
  // Refresh periodically to update the clock and retire finished games.
  const tick = setInterval(load, 30000);
  const clockTick = setInterval(tickClocks, 200);
  await load();

  return () => {
    clearTimeout(timer);
    clearInterval(tick);
    clearInterval(clockTick);
    clockRefs = [];
    clearTimeout(expiryTimer);
    evaluator.destroy();
    window.removeEventListener('resize', layout);
    document.body.classList.remove('tv-mode');
    socket.emit('unwatch:club', club.id);
    socket.off('club:changed', onChanged);
    socket.off('tournament:changed', onChanged);
    socket.off('connect', watch);
    if (document.fullscreenElement) document.exitFullscreen().catch(() => {});
  };
}
