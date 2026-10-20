// Projector view: every live club game, as large as the screen allows, updating in real time.
import { Chess } from '/vendor/chess.js';
import { api, getSocket } from './api.js';
import { el, clear } from './dom.js';
import { renderMiniBoard } from './board.js';
import { MODE_LABEL, resultText } from './game-view.js';
import { Evaluator, createEvalBar } from './eval-bar.js';

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

function playerRow(game, color) {
  const side = color === 'w' ? game.white : game.black;
  const toMove = game.status === 'active' && game.turn === color;
  return el('div', { class: `tv-player ${toMove ? 'to-move' : ''}` },
    el('span', { class: `turn-dot ${toMove ? 'on' : ''} ${color === 'w' ? 'white' : 'black'}` }),
    el('span', { class: 'tv-name' }, side.name || '?'));
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
    el('div', { class: 'tv-meta' }, MODE_LABEL[game.mode], moveNo ? ` · move ${moveNo}` : ''));
}

export async function mountTvView(root, clubId) {
  const socket = getSocket();
  const { club, membership } = await api(`/clubs/${clubId}`);
  if (!membership) throw new Error('Join this club to use its projector view');

  const liveCount = el('span', { class: 'tv-live' });
  const clock = el('span', { class: 'tv-clock' });
  const grid = el('div', { class: 'tv-grid' });
  const fullscreenBtn = el('button', {
    type: 'button',
    class: 'btn ghost small',
    onclick: () => (document.fullscreenElement ? document.exitFullscreen() : document.documentElement.requestFullscreen()).catch(() => {}),
  }, '⛶ Fullscreen');
  clear(root, el('div', { class: 'tv' },
    el('header', { class: 'tv-header' },
      el('div', { class: 'tv-title' }, el('span', { class: 'logo-mark' }, '♞'), club.name, liveCount),
      el('div', { class: 'row' }, clock, fullscreenBtn, el('a', { href: `#/club/${club.id}`, class: 'btn ghost small' }, 'Exit'))),
    grid));
  document.body.classList.add('tv-mode');

  let games = [];
  const finishedAt = new Map();
  const evaluator = new Evaluator({ timeMs: 700 });
  // One bar per game, reused across re-renders so it animates from its previous value.
  const evalBars = new Map();

  function evalBarFor(game) {
    if (!game.meta?.evalBar) return null;
    let bar = evalBars.get(game.id);
    if (!bar) {
      bar = createEvalBar();
      evalBars.set(game.id, bar);
    }
    const key = game.moves.length;
    bar.el.dataset.key = key;
    evaluator.evaluate(`game:${game.id}`, game.startFen, game.moves).then((r) => {
      if (r && bar.el.dataset.key === String(key)) bar.set(r);
    });
    return bar;
  }

  const hasEvalBars = () => games.some((g) => g.meta?.evalBar);

  function layout() {
    const n = games.length;
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
    if (!games.length) {
      grid.style.gridTemplateColumns = '';
      clear(grid, el('div', { class: 'tv-empty' },
        el('div', { class: 'tv-empty-icon' }, '♞'),
        el('div', {}, 'No games in progress'),
        el('div', { class: 'muted' }, 'Live club games will appear here automatically.')));
      return;
    }
    for (const id of evalBars.keys()) if (!games.some((g) => g.id === id)) evalBars.delete(id);
    clear(grid, games.map((g) => tile(g, evalBarFor(g))));
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
    for (const g of data.finished) {
      if (finishedAt.has(g.id)) continue;
      // Time games that end while on screen by this display's clock; for games that had already
      // ended when the page loaded, fall back to the server's timestamp.
      finishedAt.set(g.id, games.some((shown) => shown.id === g.id) ? now : g.updatedAt);
    }
    games = [...data.active, ...data.finished.filter((g) => now - finishedAt.get(g.id) < SHOW_FINISHED_MS)]
      // Private games are never shown on a shared screen.
      .filter((g) => g.visibility === 'club')
      // Sort by id so boards keep their place on screen as moves come in.
      .sort((a, b) => a.id - b.id);
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
  socket.on('connect', watch);
  if (socket.connected) watch();
  window.addEventListener('resize', layout);
  // Refresh periodically to update the clock and retire finished games.
  const tick = setInterval(load, 30000);
  await load();

  return () => {
    clearTimeout(timer);
    clearInterval(tick);
    clearTimeout(expiryTimer);
    evaluator.destroy();
    window.removeEventListener('resize', layout);
    document.body.classList.remove('tv-mode');
    socket.emit('unwatch:club', club.id);
    socket.off('club:changed', onChanged);
    socket.off('connect', watch);
    if (document.fullscreenElement) document.exitFullscreen().catch(() => {});
  };
}
