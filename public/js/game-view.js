import { Chess } from '/vendor/chess.js';
import { Board, makePiece } from './board.js';
import { api, getSocket } from './api.js';
import { el, clear, toast } from './dom.js';
import { saveLocalGame, getLocalGame, deleteLocalGame, newLocalId } from './local-games.js';
import { Engine } from './stockfish.js';
import { gameElo, isApproximate } from './bots.js';
import { Evaluator, createEvalBar } from './eval-bar.js';
import { formatClock, tcDescription } from './time-control.js';
import { timeoutResult } from './clock-rules.js';
import { reviewGame, whiteWinPercent, RETRY_LABELS, LABELS } from './review.js';
import { loadOpeningBook, labelIcon, explainMove, renderSummary, renderGraph } from './review-view.js';

const ANALYSIS_MS = 350;

export const MODE_LABEL = { online: 'Online', computer: 'vs Computer', self: 'Self-play', otb: 'Over the board' };
const BROADCAST_MODES = new Set(['computer', 'self', 'otb']);
const VALUES = { p: 1, n: 3, b: 3, r: 5, q: 9 };


export function resultText(state) {
  if (state.status === 'aborted') return state.termination === 'broadcast stopped' ? 'Broadcast stopped' : 'Aborted';
  if (state.status === 'paused') return null;
  if (state.status !== 'finished') return null;
  const who = state.result === '1-0' ? `${state.white.name} wins` : state.result === '0-1' ? `${state.black.name} wins` : 'Draw';
  return `${who}${state.termination ? ` — ${state.termination}` : ''}`;
}

function buildChess(state, ply = state.moves.length) {
  const chess = new Chess(state.startFen);
  for (let i = 0; i < ply; i++) chess.move(state.moves[i]);
  return chess;
}

function gameOverInfo(chess) {
  if (chess.isCheckmate()) return { result: chess.turn() === 'w' ? '0-1' : '1-0', termination: 'checkmate' };
  if (chess.isStalemate()) return { result: '1/2-1/2', termination: 'stalemate' };
  if (chess.isInsufficientMaterial()) return { result: '1/2-1/2', termination: 'insufficient material' };
  if (chess.isThreefoldRepetition()) return { result: '1/2-1/2', termination: 'threefold repetition' };
  if (chess.isDrawByFiftyMoves()) return { result: '1/2-1/2', termination: 'fifty-move rule' };
  return null;
}

function pieceCounts(chess) {
  const counts = { w: { p: 0, n: 0, b: 0, r: 0, q: 0 }, b: { p: 0, n: 0, b: 0, r: 0, q: 0 } };
  for (const row of chess.board()) for (const p of row) if (p && p.type !== 'k') counts[p.color][p.type]++;
  return counts;
}

export function toPgn(state) {
  const chess = buildChess(state);
  chess.setHeader('Event', state.meta?.event || (state.clubName ? `${state.clubName} club game` : 'Casual game'));
  chess.setHeader('Site', location.host);
  chess.setHeader('Date', new Date(state.createdAt || Date.now()).toISOString().slice(0, 10).replaceAll('-', '.'));
  chess.setHeader('White', state.white.name || '?');
  chess.setHeader('Black', state.black.name || '?');
  chess.setHeader('Result', state.status === 'finished' ? state.result : '*');
  return chess.pgn();
}

/**
 * Render a game (server-hosted or a private local game) into root.
 * @returns cleanup function
 */
export function mountGameView(root, { user, kind, id, navigate }) {
  let state = null;
  let viewPly = null; // null = following the live position
  let pending = false;
  let thinking = false;
  let bot = null;
  // Game review: {data (from reviewGame), positions, retry} once open; `analysing` while Stockfish runs.
  let review = null;
  let analysing = null;
  let reviewEngine = null;
  let engineRequest = 0;
  let evaluator = null;
  let orientationSet = false;
  let myClubs = [];
  let destroyed = false;
  const clockEls = { w: null, b: null };
  let clockTimer = null;
  const socket = kind === 'server' ? getSocket() : null;

  const topBar = el('div', { class: 'player-bar' });
  const bottomBar = el('div', { class: 'player-bar' });
  const boardWrap = el('div', { class: 'board-wrap' });
  const evalBar = createEvalBar();
  evalBar.el.hidden = true;
  const meta = el('div', { class: 'game-meta' });
  const status = el('div', { class: 'status' });
  const notice = el('div', { class: 'notice-area' });
  const moveList = el('div', { class: 'move-list' });
  const nav = el('div', { class: 'nav-buttons' });
  const controls = el('div', { class: 'controls' });
  const broadcast = el('div', { class: 'broadcast-panel' });
  const reviewPanel = el('div', { class: 'review-panel' });
  // Small screens: explanation and move stepping pinned to the bottom, so the board stays in view.
  const reviewDock = el('div', { class: 'review-dock', hidden: true });
  const smallScreen = () => window.matchMedia('(max-width: 900px)').matches;

  clear(root, el('div', { class: 'game-layout' },
    el('div', { class: 'board-col' }, topBar, el('div', { class: 'board-row' }, evalBar.el, boardWrap), bottomBar),
    el('aside', { class: 'side-panel card' }, meta, status, notice, reviewPanel, moveList, nav, controls, broadcast),
    reviewDock,
  ));

  const board = new Board(boardWrap, {
    canMove: (color) => (review?.retry
      ? !review.retry.done && !review.retry.busy && !review.retry.solved && color === review.retry.color
      : viewPly === null && !pending && !thinking && canMoveColor(color)),
    onMove: (from, to, promotion) => (review?.retry ? retryMove({ from, to, promotion }) : makeMove({ from, to, promotion })),
  });

  // ---------- roles ----------

  const isOwner = () => kind === 'local' || state.createdBy === user.id;
  const myOnlineColor = () => {
    if (state.mode !== 'online') return null;
    if (state.white.id === user.id) return 'w';
    if (state.black.id === user.id) return 'b';
    return null;
  };
  const engineColor = () => (state.mode === 'computer' ? (state.meta.playerColor === 'black' ? 'w' : 'b') : null);

  function canMoveColor(color) {
    if (!state || state.status !== 'active') return false;
    if (state.mode === 'online') return myOnlineColor() === color;
    if (!isOwner()) return false;
    if (state.mode === 'computer') return color !== engineColor();
    return true;
  }

  // ---------- clocks ----------
  // state.clock is {white, black, running, since}: remaining ms as of `since` (a local timestamp), with
  // `running` ('w'/'b'/null) counting down. Server games: the server sends the remaining time and we count
  // down from when it arrived. Private games: this device keeps the clock, with the same rules.

  function remainingMs(color) {
    const c = state.clock;
    if (!c) return null;
    const base = color === 'w' ? c.white : c.black;
    const elapsed = c.running === color && state.status === 'active' ? Date.now() - c.since : 0;
    return Math.max(0, base - elapsed);
  }

  /** Private games: stop the clock, keeping the current readings. */
  function freezeLocalClock() {
    if (!state.clock) return;
    state.clock = { white: remainingMs('w'), black: remainingMs('b'), running: null, since: Date.now() };
  }

  /** Private games: start the side to move's clock (once both sides have made their first move). */
  function startLocalClock() {
    if (!state.clock) return;
    freezeLocalClock();
    if (state.status === 'active' && state.moves.length >= 2) state.clock.running = buildChess(state).turn();
  }

  function flagLocal(color) {
    freezeLocalClock();
    state.clock[color === 'w' ? 'white' : 'black'] = 0;
    Object.assign(state, { status: 'finished', ...timeoutResult(buildChess(state).fen(), color) });
    stopEngine();
    persistLocal();
    render();
  }

  function tickClocks() {
    if (!state?.clock || destroyed) return;
    const lowAt = Math.min(20000, (state.timeControl?.initial ?? 60) * 1000 * 0.2);
    for (const color of ['w', 'b']) {
      const elClock = clockEls[color];
      if (!elClock) continue;
      const ms = remainingMs(color);
      elClock.textContent = formatClock(ms);
      const running = state.status === 'active' && state.clock.running === color;
      elClock.classList.toggle('running', running);
      elClock.classList.toggle('low', running && ms < lowAt);
      if (kind === 'local' && running && ms <= 0) return flagLocal(color);
    }
  }

  // ---------- actions ----------

  function persistLocal() {
    saveLocalGame(user.id, state);
  }

  async function makeMove(move) {
    if (kind === 'local') {
      const chess = buildChess(state);
      let san;
      try {
        san = chess.move(move).san;
      } catch {
        return render();
      }
      const mover = chess.turn() === 'w' ? 'b' : 'w';
      if (state.clock?.running) {
        const left = remainingMs(mover);
        if (left <= 0) return flagLocal(mover);
        state.clock[mover === 'w' ? 'white' : 'black'] = left + state.timeControl.increment * 1000;
        state.clock.since = Date.now();
      }
      state.moves = [...state.moves, san];
      const over = gameOverInfo(chess);
      if (over) Object.assign(state, { status: 'finished', ...over });
      startLocalClock();
      persistLocal();
      return render();
    }
    // Server game: show the move immediately, then let the server confirm it.
    const previous = state;
    try {
      const chess = buildChess(state);
      state = { ...state, moves: [...state.moves, chess.move(move).san] };
    } catch {
      return render();
    }
    pending = true;
    render();
    try {
      const { game } = await api(`/games/${state.id}/move`, { method: 'POST', body: move });
      state = game;
    } catch (err) {
      state = previous;
      toast(err.message, 'error');
    } finally {
      pending = false;
      render();
    }
  }

  async function serverAction(path, body) {
    pending = true;
    render();
    try {
      const { game } = await api(`/games/${state.id}/${path}`, { method: 'POST', body: body || {} });
      state = game;
      return true;
    } catch (err) {
      toast(err.message, 'error');
      return false;
    } finally {
      pending = false;
      render();
    }
  }

  function stopEngine() {
    engineRequest++;
    thinking = false;
  }

  async function takeback() {
    closeReview();
    // Against the computer, take back the player's last move too, so it is their turn again.
    let count = 1;
    if (state.mode === 'computer') {
      const turn = buildChess(state).turn();
      count = turn === engineColor() || state.moves.length < 2 ? 1 : 2;
    }
    if (!state.moves.length) return;
    stopEngine();
    viewPly = null;
    if (kind === 'local') {
      freezeLocalClock();
      state.moves = state.moves.slice(0, -count);
      Object.assign(state, { status: 'active', result: '*', termination: null });
      startLocalClock();
      persistLocal();
      return render();
    }
    await serverAction('undo', { count });
  }

  async function resign() {
    if (!confirm('Resign this game?')) return;
    stopEngine();
    if (kind === 'local') {
      const lost = state.meta.playerColor === 'black' ? 'black' : 'white';
      freezeLocalClock();
      Object.assign(state, { status: 'finished', result: lost === 'white' ? '0-1' : '1-0', termination: `${lost} resigned` });
      persistLocal();
      return render();
    }
    await serverAction('resign');
  }

  async function declareResult(result) {
    const label = result === '1/2-1/2' ? 'a draw' : `${result === '1-0' ? state.white.name : state.black.name} winning`;
    if (!confirm(`End the game with ${label}?`)) return;
    if (kind === 'local') {
      freezeLocalClock();
      Object.assign(state, { status: 'finished', result, termination: 'result declared' });
      persistLocal();
      return render();
    }
    await serverAction('result', { result });
  }

  async function startBroadcast(clubId) {
    // Restarting a stopped broadcast in the same club resumes the same game, so spectators keep watching.
    const previous = state.broadcast;
    if (previous && String(previous.clubId) === String(clubId)) {
      try {
        const { game } = await api(`/games/${previous.gameId}/resume`, {
          method: 'POST',
          body: { moves: state.moves, whiteMs: remainingMs('w'), blackMs: remainingMs('b') },
        });
        deleteLocalGame(user.id, state.id);
        toast('Broadcast resumed');
        navigate(`#/game/${game.id}`);
        return;
      } catch {
        // The old broadcast can't be resumed (e.g. it was removed); start a new one instead.
      }
    }
    try {
      const { game } = await api(`/clubs/${clubId}/games`, {
        method: 'POST',
        body: {
          mode: state.mode,
          startFen: state.startFen,
          moves: state.moves,
          whiteName: state.white.name,
          blackName: state.black.name,
          playerColor: state.meta.playerColor,
          level: state.meta.level,
          elo: state.meta.elo,
          bot: state.meta.bot,
          event: state.meta.event,
          evalBar: !!state.meta.evalBar,
          timeControl: state.timeControl || null,
          whiteMs: remainingMs('w'),
          blackMs: remainingMs('b'),
          localId: state.id,
        },
      });
      deleteLocalGame(user.id, state.id);
      toast('Broadcasting to the club');
      navigate(`#/game/${game.id}`);
    } catch (err) {
      toast(err.message, 'error');
    }
  }

  async function stopBroadcast() {
    if (!confirm('Stop broadcasting? The game continues privately on this device.')) return;
    if (!(await serverAction('cancel'))) return;
    const snapshot = state;
    const local = {
      id: newLocalId(),
      mode: snapshot.mode,
      status: 'active',
      result: '*',
      termination: null,
      startFen: snapshot.startFen,
      moves: snapshot.moves,
      white: { name: snapshot.white.name },
      black: { name: snapshot.black.name },
      meta: snapshot.meta,
      createdAt: snapshot.createdAt,
      broadcast: { gameId: snapshot.id, clubId: snapshot.clubId },
      timeControl: snapshot.timeControl,
      clock: snapshot.clock ? { white: snapshot.clock.white, black: snapshot.clock.black, running: null, since: Date.now() } : null,
    };
    if (local.clock && local.moves.length >= 2) local.clock.running = buildChess(local).turn();
    saveLocalGame(user.id, local);
    navigate(`#/local/${local.id}`);
  }

  // ---------- computer opponent ----------

  function maybeEngineMove() {
    if (!state || state.mode !== 'computer' || !isOwner() || state.status !== 'active' || thinking || pending) return;
    const chess = buildChess(state);
    if (chess.turn() !== engineColor() || chess.isGameOver()) return;
    thinking = true;
    const requestId = ++engineRequest;
    const movesAtRequest = state.moves.length;
    const started = Date.now();
    const elo = gameElo(state.meta);
    bot ||= new Engine();
    // On the clock, the computer budgets its thinking time like a player would: about 1/40 of its
    // remaining time plus most of the increment, never more than it would normally take.
    let timeMs = Engine.thinkTime(elo);
    if (state.clock) {
      const left = remainingMs(engineColor());
      timeMs = Math.max(100, Math.min(timeMs, left / 40 + state.timeControl.increment * 800));
    }
    bot.bestMove({ startFen: state.startFen, moves: state.moves, elo, timeMs }).then((move) => {
      // Small minimum delay so instant replies don't feel jarring.
      setTimeout(() => {
        if (requestId !== engineRequest || destroyed) return;
        thinking = false;
        if (!move) return render();
        if (state.moves.length !== movesAtRequest) return render();
        makeMove(move);
      }, Math.max(0, 350 - (Date.now() - started)));
    }).catch((err) => {
      if (requestId !== engineRequest || destroyed) return;
      thinking = false;
      toast(`Computer error: ${err.message}`, 'error');
      render();
    });
    render();
  }

  // ---------- rendering ----------

  function playerBar(bar, color, chess) {
    const side = color === 'w' ? state.white : state.black;
    let name = side.name;
    if (!name && state.status === 'waiting') name = 'Waiting for opponent…';
    const isYou = (state.mode === 'online' && side.id === user.id) ||
      (state.mode === 'computer' && isOwner() && color !== engineColor());
    // Material: opponent pieces missing compared with the game's starting position.
    const counts = pieceCounts(chess);
    const startCounts = pieceCounts(new Chess(state.startFen));
    const opp = color === 'w' ? 'b' : 'w';
    const captured = [];
    let material = 0;
    for (const t of ['q', 'r', 'b', 'n', 'p']) {
      for (let i = 0; i < startCounts[opp][t] - counts[opp][t]; i++) captured.push(makePiece({ type: t, color: opp }));
      material += (counts[color][t] - counts[opp][t]) * VALUES[t];
    }
    const toMove = state.status === 'active' && chess.turn() === color;
    clockEls[color] = state.clock ? el('span', { class: 'clock' }) : null;
    clear(bar,
      el('span', { class: `turn-dot ${toMove ? 'on' : ''} ${color === 'w' ? 'white' : 'black'}` }),
      el('span', { class: 'player-name' }, name || '—', isYou ? el('span', { class: 'you' }, ' (you)') : null),
      el('span', { class: 'captured' }, captured),
      material > 0 ? el('span', { class: 'material' }, `+${material}`) : null,
      clockEls[color],
    );
  }

  function statusText(chess) {
    if (state.status === 'waiting') return 'Waiting for an opponent to accept the challenge';
    if (state.status === 'paused') return 'Broadcast paused — it will continue here if the broadcaster resumes it';
    if (review?.retry) return 'Retry mistakes';
    if (review) return `Game review — ${resultText(state) || ''}`;
    const res = resultText(state);
    if (res) return res;
    if (viewPly !== null) return `Reviewing move ${viewPly} of ${state.moves.length}`;
    const turnName = chess.turn() === 'w' ? 'White' : 'Black';
    if (thinking) return 'Computer is thinking…';
    if (canMoveColor(chess.turn())) {
      const check = chess.inCheck() ? ' — you are in check!' : '';
      return state.mode === 'online' || state.mode === 'computer' ? `Your move${check}` : `${turnName} to move${chess.inCheck() ? ' (check)' : ''}`;
    }
    return `${turnName} to move${chess.inCheck() ? ' (check)' : ''}`;
  }

  function renderMoveList() {
    const start = new Chess(state.startFen);
    let num = start.moveNumber();
    let whiteTurn = start.turn() === 'w';
    const rows = [];
    let row = null;
    state.moves.forEach((san, i) => {
      if (whiteTurn || !row) {
        row = el('div', { class: 'move-row' }, el('span', { class: 'move-num' }, `${num}.`));
        rows.push(row);
        if (!whiteTurn) row.appendChild(el('span', { class: 'move' }, '…'));
      }
      const ply = i + 1;
      const current = viewPly === null ? ply === state.moves.length : ply === viewPly;
      const label = review && !review.retry ? review.data.moves[i]?.label : null;
      row.appendChild(el('button', {
        type: 'button',
        class: `move ${current ? 'current' : ''}`,
        onclick: () => setViewPly(ply === state.moves.length ? null : ply),
      }, label && label !== 'good' && label !== 'excellent' ? labelIcon(label, { small: true }) : null, san));
      if (!whiteTurn) num++;
      whiteTurn = !whiteTurn;
    });
    clear(moveList, rows.length ? rows : el('div', { class: 'muted' }, 'No moves yet'));
    // Keep the current move visible by scrolling the move list itself; scrollIntoView would also scroll the page.
    const currentEl = moveList.querySelector('.current');
    if (currentEl) {
      const top = currentEl.offsetTop;
      const bottom = top + currentEl.offsetHeight;
      if (top < moveList.scrollTop) moveList.scrollTop = top;
      else if (bottom > moveList.scrollTop + moveList.clientHeight) moveList.scrollTop = bottom - moveList.clientHeight;
    }
  }

  function setViewPly(ply) {
    if (ply !== null) ply = Math.max(0, Math.min(state.moves.length, ply));
    viewPly = ply === state.moves.length ? null : ply;
    render();
  }

  function button(label, onclick, opts = {}) {
    return el('button', { type: 'button', class: opts.class || 'btn', onclick, disabled: opts.disabled || pending, title: opts.title }, label);
  }

  function renderControls() {
    const items = [button('⇅ Flip', () => {
      board.flip();
      render();
    }, { class: 'btn ghost' })];
    const active = state.status === 'active';
    if (state.mode === 'online' && kind === 'server') {
      const mine = myOnlineColor();
      if (state.status === 'waiting') {
        if (state.createdBy === user.id) items.push(button('Cancel challenge', () => serverAction('cancel'), { class: 'btn danger' }));
        else if (!state.invitedId || state.invitedId === user.id) {
          items.push(button('Accept challenge', () => serverAction('accept'), { class: 'btn primary' }));
          if (state.invitedId === user.id) items.push(button('Decline', () => serverAction('cancel'), { class: 'btn' }));
        }
      }
      if (active && mine) {
        if (state.moves.length < 2) items.push(button('Abort', () => serverAction('cancel'), { class: 'btn' }));
        if (!state.drawOfferBy) items.push(button('½ Offer draw', () => serverAction('draw', { action: 'offer' })));
        else if (state.drawOfferBy === user.id) items.push(button('Draw offered…', null, { disabled: true }));
        items.push(button('🏳 Resign', () => {
          if (confirm('Resign this game?')) serverAction('resign');
        }, { class: 'btn danger' }));
      }
    }
    if (BROADCAST_MODES.has(state.mode) && isOwner()) {
      if (active || (kind === 'local' && state.status === 'finished')) {
        items.push(button('↶ Takeback', takeback, { disabled: !state.moves.length }));
      }
      if (active && state.mode === 'computer') items.push(button('🏳 Resign', resign, { class: 'btn danger' }));
      if (active && state.mode !== 'computer') {
        items.push(el('div', { class: 'result-buttons' },
          el('span', { class: 'muted' }, 'Result:'),
          button('1-0', () => declareResult('1-0')),
          button('½-½', () => declareResult('1/2-1/2')),
          button('0-1', () => declareResult('0-1'))));
      }
    }
    if (canReview()) {
      if (review) items.push(button('Close review', () => { closeReview(); viewPly = null; render(); }, { class: 'btn' }));
      else items.push(button(analysing ? 'Analysing…' : state.hasAnalysis || state.analysis ? '⭐ Show review' : '⭐ Game review', openReview, { class: 'btn primary', disabled: !!analysing }));
    }
    items.push(button('Copy PGN', async () => {
      try {
        await navigator.clipboard.writeText(toPgn(state));
        toast('PGN copied to clipboard');
      } catch {
        downloadPgn();
      }
    }, { class: 'btn ghost' }));
    items.push(button('Download PGN', downloadPgn, { class: 'btn ghost' }));
    if (kind === 'local') {
      items.push(button('Delete game', () => {
        if (!confirm('Delete this private game?')) return;
        deleteLocalGame(user.id, state.id);
        navigate('#/');
      }, { class: 'btn ghost danger-text' }));
    }
    clear(controls, items);
  }

  function downloadPgn() {
    const blob = new Blob([toPgn(state)], { type: 'application/x-chess-pgn' });
    const a = el('a', { href: URL.createObjectURL(blob), download: `game-${state.id}.pgn` });
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 1000);
  }

  function renderBroadcastPanel() {
    if (!BROADCAST_MODES.has(state.mode) || !isOwner()) return clear(broadcast);
    if (kind === 'server') {
      if (state.status !== 'active') return clear(broadcast);
      return clear(broadcast,
        el('div', { class: 'broadcast-live' }, el('span', { class: 'live-dot' }), `Broadcasting live to ${state.clubName}`),
        button('Stop broadcast', stopBroadcast, { class: 'btn' }));
    }
    if (state.status !== 'active') return clear(broadcast);
    if (!myClubs.length) {
      return clear(broadcast, el('p', { class: 'muted small' }, 'Private game on this device. Join a club to broadcast games.'));
    }
    const select = el('select', { 'aria-label': 'Club to broadcast to' },
      myClubs.map((c) => el('option', { value: c.id, selected: String(c.id) === String(state.broadcast?.clubId) }, c.name)));
    clear(broadcast,
      el('p', { class: 'muted small' }, '🔒 Private game — only on this device.'),
      el('div', { class: 'row' }, select, button('📡 Broadcast', () => startBroadcast(select.value), { class: 'btn primary' })));
  }

  // ---------- game review ----------

  const canReview = () => state.status === 'finished' && state.moves.length > 0;

  async function openReview() {
    if (analysing) return;
    let analysis = kind === 'local' ? state.analysis : null;
    try {
      if (kind === 'server' && state.hasAnalysis) analysis = (await api(`/games/${state.id}/analysis`)).analysis;
    } catch {
      analysis = null;
    }
    if (!analysis || analysis.positions?.length !== state.moves.length + 1) {
      analysis = await runAnalysis();
      if (!analysis) return;
      if (kind === 'local') {
        state.analysis = analysis;
        persistLocal();
      } else {
        try {
          analysis = (await api(`/games/${state.id}/analysis`, { method: 'POST', body: { analysis } })).analysis;
          state.hasAnalysis = true;
        } catch (err) {
          toast(`Review not saved: ${err.message}`, 'error');
        }
      }
    }
    const book = await loadOpeningBook();
    if (destroyed) return;
    review = {
      positions: analysis.positions,
      data: reviewGame({ Chess, startFen: state.startFen, moves: state.moves, positions: analysis.positions, book }),
      retry: null,
    };
    viewPly = 0;
    render();
    // On a phone the review button sits below the board; bring the board back into view.
    if (smallScreen()) window.scrollTo({ top: 0, behavior: 'smooth' });
  }

  /** Analyse every position with Stockfish (two best lines each), showing progress. Null if cancelled. */
  async function runAnalysis() {
    analysing = { done: 0, total: state.moves.length + 1, cancelled: false };
    render();
    reviewEngine ||= new Engine();
    const positions = [];
    try {
      for (let i = 0; i <= state.moves.length; i++) {
        positions.push(await reviewEngine.analysePosition({ startFen: state.startFen, moves: state.moves.slice(0, i), timeMs: ANALYSIS_MS }));
        if (destroyed || analysing.cancelled) return null;
        analysing.done = i + 1;
        renderReviewPanel();
      }
    } catch (err) {
      toast(`Analysis failed: ${err.message}`, 'error');
      return null;
    } finally {
      analysing = null;
      if (!destroyed) render();
    }
    return { engine: reviewEngine.usingFallback ? 'built-in' : 'Stockfish 19 lite', timeMs: ANALYSIS_MS, positions };
  }

  function closeReview() {
    if (analysing) analysing.cancelled = true;
    review = null;
  }

  function reviewedMove(ply) {
    return ply > 0 ? review.data.moves[ply - 1] : null;
  }

  /** Board arrows/badges for the move just played at `ply`: its label, and an arrow for the best move. */
  function reviewAnnotations(ply) {
    const m = reviewedMove(ply);
    if (!m) return {};
    const info = LABELS[m.label];
    const arrows = [];
    if (m.bestUci && !['best', 'book', 'brilliant', 'great'].includes(m.label)) {
      arrows.push({ from: m.bestUci.slice(0, 2), to: m.bestUci.slice(2, 4), color: '#4a9e5c' });
    }
    return { arrows, badges: [{ square: m.to, symbol: info.symbol, color: info.color, title: info.name }] };
  }

  function jumpKeyMoment(direction) {
    const current = viewPly ?? state.moves.length;
    const list = review.data.keyMoments;
    const target = direction > 0 ? list.find((p) => p > current) : [...list].reverse().find((p) => p < current);
    if (target !== undefined) setViewPly(target);
  }

  // ---------- retry mistakes ----------

  /** Whose mistakes to retry: the viewer's own side if they played, otherwise both sides. */
  function retryColors() {
    const mine = myOnlineColor();
    if (mine) return [mine];
    if (state.mode === 'computer') return [state.meta.playerColor === 'black' ? 'b' : 'w'];
    return ['w', 'b'];
  }

  function startRetry() {
    const colors = retryColors();
    const list = review.data.moves.filter((m) => RETRY_LABELS.has(m.label) && colors.includes(m.color) && m.bestUci).map((m) => m.ply);
    if (!list.length) {
      toast('No mistakes to retry — nicely played!');
      return;
    }
    review.retry = { list, index: 0, found: 0 };
    loadRetry();
  }

  function loadRetry() {
    const r = review.retry;
    const ply = r.list[r.index];
    const m = reviewedMove(ply);
    Object.assign(r, {
      ply, move: m, color: m.color, base: buildChess(state, ply - 1), attempt: null,
      solved: false, busy: false, feedback: null, showSolution: false, counted: false,
    });
    board.orientation = m.color === 'w' ? 'white' : 'black';
    render();
  }

  async function retryMove(move) {
    const r = review.retry;
    const chess = new Chess(r.base.fen());
    let played;
    try {
      played = chess.move(move);
    } catch {
      return render();
    }
    r.attempt = chess;
    const uci = played.from + played.to + (played.promotion || '');
    if (uci === r.move.uci) {
      r.feedback = { kind: 'wrong', text: `${played.san} is the move you played in the game. Try something else.` };
      render();
      return resetAttempt();
    }
    if (uci === r.move.bestUci) return solveRetry(`${played.san} is the best move!`);
    // Not the engine's top choice: accept it if it keeps nearly all the winning chances.
    r.busy = true;
    r.feedback = { kind: 'checking', text: 'Checking…' };
    render();
    reviewEngine ||= new Engine();
    const fenMoves = [...state.moves.slice(0, r.ply - 1), played.san];
    const after = await reviewEngine.analysePosition({ startFen: state.startFen, moves: fenMoves, timeMs: 500 });
    if (!review?.retry || review.retry !== r) return;
    r.busy = false;
    const mine = (w) => (r.color === 'w' ? w : 100 - w);
    const loss = mine(whiteWinPercent(review.positions[r.ply - 1])) - mine(whiteWinPercent(after));
    if (loss < 5) return solveRetry(`${played.san} works! The engine's top move was ${r.move.bestSan}.`);
    r.feedback = { kind: 'wrong', text: `${played.san} isn't it. Try again.` };
    render();
    resetAttempt();
  }

  function resetAttempt() {
    const r = review.retry;
    setTimeout(() => {
      if (review?.retry !== r || r.solved) return;
      r.attempt = null;
      render();
    }, 1100);
  }

  function solveRetry(text) {
    const r = review.retry;
    if (!r.counted && !r.showSolution) r.found++;
    r.counted = true;
    r.solved = true;
    r.feedback = { kind: 'correct', text };
    render();
  }

  function showSolution() {
    const r = review.retry;
    const chess = new Chess(r.base.fen());
    chess.move({ from: r.move.bestUci.slice(0, 2), to: r.move.bestUci.slice(2, 4), promotion: r.move.bestUci[4] });
    Object.assign(r, { attempt: chess, showSolution: true, solved: true, counted: true, feedback: { kind: 'solution', text: `The best move was ${r.move.bestSan}.` } });
    render();
  }

  function nextRetry() {
    const r = review.retry;
    if (r.index + 1 < r.list.length) {
      r.index++;
      loadRetry();
    } else {
      r.done = true;
      render();
    }
  }

  function exitRetry() {
    review.retry = null;
    orientationSet = false;
    render();
  }

  function renderReviewPanel() {
    if (analysing) {
      const pct = Math.round((analysing.done / analysing.total) * 100);
      return clear(reviewPanel, el('div', { class: 'review-progress' },
        el('div', {}, `Analysing with Stockfish… ${analysing.done}/${analysing.total} positions`),
        el('div', { class: 'progress' }, el('div', { class: 'progress-bar', style: `width:${pct}%` })),
        button('Cancel', () => {
          analysing.cancelled = true;
        }, { class: 'btn small ghost' })));
    }
    renderReviewDock();
    if (!review) return clear(reviewPanel);
    const r = review.retry;
    if (r) {
      if (r.done) {
        return clear(reviewPanel, el('div', { class: 'retry-box' },
          el('strong', {}, `Done! You found ${r.found} of ${r.list.length}.`),
          el('div', { class: 'row' }, button('Back to review', exitRetry, { class: 'btn primary' }))));
      }
      const side = r.color === 'w' ? 'White' : 'Black';
      return clear(reviewPanel, el('div', { class: 'retry-box' },
        el('div', { class: 'muted small' }, `Retry ${r.index + 1} of ${r.list.length}`),
        el('div', {}, labelIcon(r.move.label, { small: true }), ` In the game, ${side} played `, el('strong', {}, r.move.san), `. Find a better move for ${side}.`),
        r.feedback ? el('div', { class: `retry-feedback ${r.feedback.kind}` }, r.feedback.text) : null,
        el('div', { class: 'row' },
          !r.solved ? button('Show solution', showSolution, { class: 'btn' }) : null,
          button(r.index + 1 < r.list.length ? (r.solved ? 'Next ▶' : 'Skip ▶') : 'Finish', nextRetry, { class: r.solved ? 'btn primary' : 'btn' }),
          button('Exit', exitRetry, { class: 'btn ghost' }))));
    }
    const current = viewPly ?? state.moves.length;
    const m = reviewedMove(current);
    // Remember whether the summary table was folded, across re-renders.
    const wasOpen = reviewPanel.querySelector('details.review-summary')?.open;
    clear(reviewPanel,
      renderSummary(review.data, state, { open: wasOpen ?? !smallScreen() }),
      renderGraph(review.data, current, (ply) => setViewPly(ply)),
      el('div', { class: 'review-explain' },
        m ? [labelIcon(m.label), ' ', explainMove(m, review.positions)] : 'Starting position. Step through the moves, or jump to the key moments.'),
      el('div', { class: 'row review-actions' },
        button('◀ Key moment', () => jumpKeyMoment(-1), { class: 'btn small' }),
        button('Key moment ▶', () => jumpKeyMoment(1), { class: 'btn small' }),
        button('🎯 Retry mistakes', startRetry, { class: 'btn small primary' })));
  }

  function renderReviewDock() {
    const show = !!review && !review.retry && !analysing;
    reviewDock.hidden = !show;
    document.body.classList.toggle('has-review-dock', show);
    if (!show) return clear(reviewDock);
    const current = viewPly ?? state.moves.length;
    const m = reviewedMove(current);
    clear(reviewDock,
      el('div', { class: 'dock-explain' }, m ? [labelIcon(m.label, { small: true }), explainMove(m, review.positions)] : 'Starting position'),
      el('div', { class: 'dock-nav' },
        button('◀◀', () => jumpKeyMoment(-1), { class: 'btn ghost', title: 'Previous key moment' }),
        button('◀', () => setViewPly(current - 1), { class: 'btn', title: 'Previous move' }),
        button('▶', () => setViewPly(current + 1), { class: 'btn primary', title: 'Next move' }),
        button('▶▶', () => jumpKeyMoment(1), { class: 'btn ghost', title: 'Next key moment' })));
  }

  /** Evaluate the position on the board (live or under review) when the game has the eval bar enabled. */
  function updateEvalBar(ply) {
    if (review && !review.retry) {
      // During review the analysis already has every position's evaluation.
      evalBar.el.hidden = false;
      evalBar.setOrientation(board.orientation);
      const p = review.positions[ply];
      evalBar.el.dataset.key = `review:${ply}`;
      evalBar.set({ cp: p.cp, mate: p.mate });
      return;
    }
    evalBar.el.hidden = !state.meta?.evalBar;
    if (!state.meta?.evalBar) return;
    evalBar.setOrientation(board.orientation);
    evaluator ||= new Evaluator({ timeMs: 900 });
    const moves = state.moves.slice(0, ply);
    const key = `${state.startFen}|${moves.join(' ')}`;
    evalBar.el.dataset.key = key;
    evalBar.set(null);
    evaluator.evaluate('board', state.startFen, moves).then((result) => {
      // Ignore results for a position that is no longer on the board.
      if (result && !destroyed && evalBar.el.dataset.key === key) evalBar.set(result);
    });
  }

  function render() {
    if (!state || destroyed) return;
    // A clock reading straight from the server counts down from the moment it arrived.
    if (kind === 'server' && state.clock && state.clock.since === undefined) state.clock.since = Date.now();
    if (state.clock && !clockTimer) clockTimer = setInterval(tickClocks, 100);
    const live = viewPly === null;
    const ply = live ? state.moves.length : viewPly;
    let chess;
    try {
      chess = buildChess(state, ply);
    } catch {
      clear(status, 'This game has an invalid move list.');
      return;
    }
    if (!orientationSet) {
      const mine = myOnlineColor();
      const orient = mine ? mine : state.mode === 'computer' && state.meta.playerColor === 'black' ? 'b' : 'w';
      board.orientation = orient === 'w' ? 'white' : 'black';
      orientationSet = true;
    }
    if (review?.retry && !review.retry.done) {
      // Retry mode: the position before the mistake, plus the player's attempt (or the solution).
      const r = review.retry;
      const shown = r.attempt || r.base;
      const h = shown.history({ verbose: true }).at(-1);
      const solution = r.showSolution ? [{ from: r.move.bestUci.slice(0, 2), to: r.move.bestUci.slice(2, 4), color: '#4a9e5c' }] : [];
      board.setAnnotations({ arrows: r.attempt ? [] : solution });
      board.setPosition(shown, r.attempt && h ? { from: h.from, to: h.to } : null);
    } else {
      board.setAnnotations(review ? reviewAnnotations(ply) : {});
      const history = chess.history({ verbose: true });
      const last = history[history.length - 1];
      board.setPosition(chess, last ? { from: last.from, to: last.to } : null);
    }
    updateEvalBar(ply);

    const bottomColor = board.orientation === 'white' ? 'w' : 'b';
    playerBar(bottomBar, bottomColor, chess);
    playerBar(topBar, bottomColor === 'w' ? 'b' : 'w', chess);

    const badges = [el('span', { class: `badge mode-${state.mode}` }, MODE_LABEL[state.mode])];
    if (state.timeControl) badges.push(el('span', { class: 'badge' }, `⏱ ${tcDescription(state.timeControl)}`));
    if (state.mode === 'computer') {
      const elo = gameElo(state.meta);
      badges.push(el('span', { class: 'badge', title: isApproximate(elo) ? 'Approximate rating' : 'Stockfish UCI_Elo' }, `🤖 ${isApproximate(elo) ? '~' : ''}${elo}`));
    }
    if (state.meta?.evalBar) badges.push(el('span', { class: 'badge' }, 'Eval bar'));
    if (kind === 'local') badges.push(el('span', { class: 'badge private' }, '🔒 Private'));
    else if (state.visibility === 'private') badges.push(el('span', { class: 'badge private' }, '🔒 Private'));
    if (kind === 'server' && state.status === 'active') badges.push(el('span', { class: 'badge live' }, '● Live'));
    clear(meta,
      el('div', { class: 'badges' }, badges),
      state.clubId ? el('a', { href: `#/club/${state.clubId}`, class: 'club-link' }, `← ${state.clubName}`) : null);

    status.className = `status ${state.status === 'finished' ? 'over' : ''}`;
    clear(status, statusText(chess));

    clear(notice);
    if (kind === 'server' && state.mode === 'online' && state.status === 'active' && state.drawOfferBy && state.drawOfferBy !== user.id && myOnlineColor()) {
      clear(notice, el('div', { class: 'draw-offer' }, 'Your opponent offers a draw.',
        button('Accept', () => serverAction('draw', { action: 'accept' }), { class: 'btn primary' }),
        button('Decline', () => serverAction('draw', { action: 'decline' }))));
    } else if (kind === 'server' && !isOwner() && !myOnlineColor() && state.status === 'active') {
      clear(notice, el('div', { class: 'muted small' }, '👁 You are spectating this game live.'));
    }

    renderMoveList();
    clear(nav,
      button('⏮', () => setViewPly(0), { class: 'btn ghost', title: 'Start' }),
      button('◀', () => setViewPly((viewPly ?? state.moves.length) - 1), { class: 'btn ghost', title: 'Previous move' }),
      button('▶', () => setViewPly((viewPly ?? state.moves.length) + 1), { class: 'btn ghost', title: 'Next move' }),
      button('⏭', () => setViewPly(null), { class: 'btn ghost', title: 'Latest move' }));
    renderControls();
    renderBroadcastPanel();
    renderReviewPanel();

    const myTurn = live && state.status === 'active' && state.mode === 'online' && canMoveColor(chess.turn());
    document.title = myTurn ? '● Your move — Chess Club' : 'Chess Club';
    tickClocks();
    if (live) maybeEngineMove();
  }

  function onKey(e) {
    if (!state || e.target.closest('input, textarea, select')) return;
    if (e.key === 'ArrowLeft') setViewPly((viewPly ?? state.moves.length) - 1);
    else if (e.key === 'ArrowRight') setViewPly((viewPly ?? state.moves.length) + 1);
    else return;
    e.preventDefault();
  }
  window.addEventListener('keydown', onKey);

  // ---------- loading ----------

  function onServerGame(game) {
    if (!game || game.id !== Number(id) || pending) return;
    const prevLength = state?.moves.length;
    state = game;
    if (viewPly !== null && viewPly > state.moves.length) viewPly = null;
    if (prevLength !== undefined && state.moves.length < prevLength) stopEngine();
    render();
  }

  function watch() {
    socket.emit('watch:game', Number(id), (res) => {
      if (res?.error) {
        clear(root, el('div', { class: 'card empty' }, res.error));
        return;
      }
      onServerGame(res.game);
    });
  }

  api('/clubs').then((d) => {
    myClubs = d.mine;
    render();
  }).catch(() => {});

  if (kind === 'local') {
    state = getLocalGame(user.id, id);
    if (!state) clear(root, el('div', { class: 'card empty' }, 'That private game was not found on this device. ', el('a', { href: '#/' }, 'Go home')));
    else render();
  } else {
    api(`/games/${id}`).then(({ game }) => onServerGame(game)).catch((err) => {
      clear(root, el('div', { class: 'card empty' }, err.message, ' ', el('a', { href: '#/' }, 'Go home')));
    });
    socket.on('game', onServerGame);
    socket.on('connect', watch);
    if (socket.connected) watch();
  }

  return () => {
    destroyed = true;
    evaluator?.destroy();
    bot?.terminate();
    reviewEngine?.terminate();
    document.body.classList.remove('has-review-dock');
    if (analysing) analysing.cancelled = true;
    clearInterval(clockTimer);
    stopEngine();
    window.removeEventListener('keydown', onKey);
    document.title = 'Chess Club';
    if (socket) {
      socket.emit('unwatch:game', Number(id));
      socket.off('game', onServerGame);
      socket.off('connect', watch);
    }
  };
}
