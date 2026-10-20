import { Chess } from '/vendor/chess.js';
import { Board, makePiece } from './board.js';
import { api, getSocket } from './api.js';
import { el, clear, toast } from './dom.js';
import { saveLocalGame, getLocalGame, deleteLocalGame, newLocalId } from './local-games.js';
import { LEVELS } from './engine.js';

export const MODE_LABEL = { online: 'Online', computer: 'vs Computer', self: 'Self-play', otb: 'Over the board' };
const BROADCAST_MODES = new Set(['computer', 'self', 'otb']);
const VALUES = { p: 1, n: 3, b: 3, r: 5, q: 9 };

export function computerName(level) {
  return `Computer (${LEVELS[level]?.name || 'Level ' + level})`;
}

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
  let worker = null;
  let engineRequest = 0;
  let orientationSet = false;
  let myClubs = [];
  let destroyed = false;
  const socket = kind === 'server' ? getSocket() : null;

  const topBar = el('div', { class: 'player-bar' });
  const bottomBar = el('div', { class: 'player-bar' });
  const boardWrap = el('div', { class: 'board-wrap' });
  const meta = el('div', { class: 'game-meta' });
  const status = el('div', { class: 'status' });
  const notice = el('div', { class: 'notice-area' });
  const moveList = el('div', { class: 'move-list' });
  const nav = el('div', { class: 'nav-buttons' });
  const controls = el('div', { class: 'controls' });
  const broadcast = el('div', { class: 'broadcast-panel' });

  clear(root, el('div', { class: 'game-layout' },
    el('div', { class: 'board-col' }, topBar, boardWrap, bottomBar),
    el('aside', { class: 'side-panel card' }, meta, status, notice, moveList, nav, controls, broadcast),
  ));

  const board = new Board(boardWrap, {
    canMove: (color) => viewPly === null && !pending && !thinking && canMoveColor(color),
    onMove: (from, to, promotion) => makeMove({ from, to, promotion }),
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
      state.moves = [...state.moves, san];
      const over = gameOverInfo(chess);
      if (over) Object.assign(state, { status: 'finished', ...over });
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
    worker?.terminate();
    worker = null;
  }

  async function takeback() {
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
      state.moves = state.moves.slice(0, -count);
      Object.assign(state, { status: 'active', result: '*', termination: null });
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
        const { game } = await api(`/games/${previous.gameId}/resume`, { method: 'POST', body: { moves: state.moves } });
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
          event: state.meta.event,
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
    const snapshot = state;
    if (!(await serverAction('cancel'))) return;
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
    };
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
    if (!worker) worker = new Worker(new URL('./engine-worker.js', import.meta.url), { type: 'module' });
    worker.onmessage = ({ data }) => {
      if (data.id !== requestId || destroyed) return;
      // Small minimum delay so instant replies don't feel jarring.
      setTimeout(() => {
        if (requestId !== engineRequest || destroyed) return;
        thinking = false;
        if (data.error || !data.move) {
          toast(`Computer error: ${data.error || 'no move'}`, 'error');
          return render();
        }
        if (state.moves.length !== movesAtRequest) return render();
        makeMove({ from: data.move.from, to: data.move.to, promotion: data.move.promotion });
      }, Math.max(0, 350 - (Date.now() - started)));
    };
    worker.onerror = (e) => {
      thinking = false;
      toast(`Computer failed to start: ${e.message || 'worker error'}`, 'error');
      render();
    };
    worker.postMessage({ id: requestId, startFen: state.startFen, moves: state.moves, level: state.meta.level || 3 });
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
    clear(bar,
      el('span', { class: `turn-dot ${toMove ? 'on' : ''} ${color === 'w' ? 'white' : 'black'}` }),
      el('span', { class: 'player-name' }, name || '—', isYou ? el('span', { class: 'you' }, ' (you)') : null),
      el('span', { class: 'captured' }, captured),
      material > 0 ? el('span', { class: 'material' }, `+${material}`) : null,
    );
  }

  function statusText(chess) {
    if (state.status === 'waiting') return 'Waiting for an opponent to accept the challenge';
    if (state.status === 'paused') return 'Broadcast paused — it will continue here if the broadcaster resumes it';
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
      row.appendChild(el('button', {
        type: 'button',
        class: `move ${current ? 'current' : ''}`,
        onclick: () => setViewPly(ply === state.moves.length ? null : ply),
      }, san));
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
    const items = [button('⇅ Flip', () => board.flip(), { class: 'btn ghost' })];
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

  function render() {
    if (!state || destroyed) return;
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
    const history = chess.history({ verbose: true });
    const last = history[history.length - 1];
    board.setPosition(chess, last ? { from: last.from, to: last.to } : null);

    const bottomColor = board.orientation === 'white' ? 'w' : 'b';
    playerBar(bottomBar, bottomColor, chess);
    playerBar(topBar, bottomColor === 'w' ? 'b' : 'w', chess);

    const badges = [el('span', { class: `badge mode-${state.mode}` }, MODE_LABEL[state.mode])];
    if (state.mode === 'computer') badges.push(el('span', { class: 'badge' }, `Level ${state.meta.level}`));
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

    const myTurn = live && state.status === 'active' && state.mode === 'online' && canMoveColor(chess.turn());
    document.title = myTurn ? '● Your move — Chess Club' : 'Chess Club';
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
