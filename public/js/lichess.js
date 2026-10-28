// Play on Lichess: link a Lichess account, find or challenge opponents there, and play those games
// on our board. The server talks to Lichess; this module shows the state it relays over Socket.IO.
//
// Lichess games count only towards Lichess ratings, never club ratings, and Lichess's fair-play rules
// forbid engine help during a game, so these games have no evaluation bar or hints.
import { Chess } from '/vendor/chess.js';
import { Board, makePiece } from './board.js';
import { api, getSocket } from './api.js';
import { el, clear, toast } from './dom.js';
import { field, formData, submitting } from './ui.js';
import { formatClock, tcLabel, speedName } from './time-control.js';
import { sounds, soundForMove } from './sounds.js';
import { icon } from './icons.js';

// Board API limits: seeks need rapid or slower; challenges and the Lichess computer allow blitz.
export const SEEK_PRESETS = [{ initial: 600, increment: 0 }, { initial: 600, increment: 5 }, { initial: 900, increment: 10 }, { initial: 1800, increment: 0 }, { initial: 1800, increment: 20 }];
export const CHALLENGE_PRESETS = [{ initial: 180, increment: 2 }, { initial: 300, increment: 0 }, { initial: 300, increment: 3 }, ...SEEK_PRESETS];
const SPEED_LABEL = { bullet: 'Bullet', blitz: 'Blitz', rapid: 'Rapid', classical: 'Classical', correspondence: 'Correspondence' };

let waiting = false; // set while this tab waits for a seek or challenge, so the game opens when it starts

/** Global listeners: open a Lichess game as soon as one we waited for starts, and show notices. */
export function installLichessListeners(navigate) {
  const socket = getSocket();
  if (socket.__lichessListeners) return;
  socket.__lichessListeners = true;
  socket.on('lichess:gameStart', ({ id }) => {
    if (!waiting) return;
    waiting = false;
    sounds.notify();
    navigate(`#/lichess/${id}`);
  });
  socket.on('lichess:notice', ({ message }) => toast(message));
}

export const lichessState = () => api('/lichess');

function ratingList(ratings) {
  if (!ratings?.length) return el('span', { class: 'muted small' }, 'No rated Lichess games yet');
  return el('div', { class: 'lichess-ratings' }, ratings.map((r) => el('span', { class: 'lichess-rating' },
    el('span', { class: 'muted small' }, SPEED_LABEL[r.speed] || r.speed), ' ', el('strong', {}, `${r.rating}${r.provisional ? '?' : ''}`))));
}

/** Profile card: your own (connect / disconnect) or another member's linked account. */
export function lichessProfileCard({ isMe, info, status }) {
  if (!isMe) {
    if (!info) return null;
    return el('section', { class: 'card' },
      el('h2', {}, 'Lichess'),
      el('p', {}, el('a', { href: info.url, target: '_blank', rel: 'noopener' }, info.username)),
      ratingList(info.ratings),
      el('p', { class: 'muted small' }, 'Lichess ratings are separate from club ratings.'));
  }
  // Drop the ?lichess=… note from the address so revisiting the page doesn't repeat the message.
  if (status) history.replaceState(null, '', location.hash.split('?')[0]);
  if (status === 'connected') toast('Lichess account connected', 'success');
  else if (status === 'cancelled') toast('Lichess connection cancelled');
  else if (status === 'failed' || status === 'expired') toast("Couldn't connect to Lichess — try again", 'error');
  const card = el('section', { class: 'card' }, el('h2', {}, 'Lichess'));
  const connect = el('button', {
    type: 'button', class: 'btn primary',
    onclick: async () => {
      connect.disabled = true;
      try {
        const { url } = await api('/lichess/connect', { method: 'POST' });
        location.href = url;
      } catch (err) {
        connect.disabled = false;
        toast(err.message, 'error');
      }
    },
  }, 'Connect Lichess account');
  if (!info) {
    card.append(
      el('p', { class: 'muted small' }, 'Link your Lichess account to find opponents there, challenge Lichess players or play the Lichess computer — right here, on this board. Your games are imported afterwards for review and puzzles.'),
      connect);
    return card;
  }
  card.append(
    el('p', {}, 'Connected as ', el('a', { href: info.url, target: '_blank', rel: 'noopener' }, el('strong', {}, info.username))),
    ratingList(info.ratings),
    el('p', { class: 'muted small' }, 'Lichess games change only your Lichess rating, not your club rating.'),
    el('button', {
      type: 'button', class: 'btn small ghost',
      onclick: async () => {
        if (!confirm('Disconnect your Lichess account from Chess Club?')) return;
        await api('/lichess/disconnect', { method: 'POST' }).catch(() => {});
        location.reload();
      },
    }, 'Disconnect'));
  return card;
}

function presetSelect(presets, name, selected) {
  return el('select', { name, 'aria-label': 'Time control' }, presets.map((tc) => el('option', {
    value: `${tc.initial}+${tc.increment}`, selected: `${tc.initial}+${tc.increment}` === selected,
  }, `${tcLabel(tc)}  ${speedName(tc)}`)));
}

/** The "Play on Lichess" fields on the New game page. */
export async function lichessPlayPanel({ navigate, profileHref }) {
  const panel = el('div', { class: 'stack mode-fields lichess-panel', dataset: { mode: 'lichess' } }, el('div', { class: 'muted small' }, 'Loading…'));
  let st;
  try {
    st = await lichessState();
  } catch {
    st = { connected: false };
  }
  if (!st.connected) {
    clear(panel,
      el('p', {}, 'Play opponents from Lichess on this board. Connect your Lichess account first.'),
      el('a', { href: profileHref, class: 'btn primary' }, 'Connect on your profile'));
    return panel;
  }
  const opponent = el('select', { name: 'opponent' },
    el('option', { value: 'seek' }, 'Anyone on Lichess (rapid or slower)'),
    el('option', { value: 'user' }, 'A Lichess player…'),
    el('option', { value: 'ai' }, 'The Lichess computer'));
  const usernameField = field('Lichess username', el('input', { name: 'username', maxlength: 30, autocapitalize: 'off', autocomplete: 'off', spellcheck: 'false' }));
  const levelField = field('Computer level', el('select', { name: 'level' },
    [1, 2, 3, 4, 5, 6, 7, 8].map((n) => el('option', { value: n, selected: n === 3 }, `Level ${n}`))));
  const tcSlot = el('div');
  const colorField = field('Your color', el('select', { name: 'lichessColor' },
    el('option', { value: 'random' }, 'Random'), el('option', { value: 'white' }, 'White'), el('option', { value: 'black' }, 'Black')));
  const ratedField = el('label', { class: 'check' }, el('input', { type: 'checkbox', name: 'lichessRated' }), ' Rated on Lichess');
  const sync = () => {
    const kind = opponent.value;
    usernameField.hidden = kind !== 'user';
    levelField.hidden = kind !== 'ai';
    colorField.hidden = kind === 'seek';
    ratedField.hidden = kind === 'ai';
    const current = tcSlot.querySelector('select')?.value;
    clear(tcSlot, field('Time control', presetSelect(kind === 'seek' ? SEEK_PRESETS : CHALLENGE_PRESETS, 'lichessTc', current || '600+0')));
  };
  opponent.addEventListener('change', sync);
  const start = el('button', { type: 'button', class: 'btn primary' }, 'Start on Lichess');
  start.addEventListener('click', async () => {
    const form = panel.closest('form');
    const d = formData(form);
    const [limit, increment] = d.lichessTc.split('+').map(Number);
    start.disabled = true;
    try {
      if (d.opponent === 'ai') {
        waiting = false;
        const { gameId } = await api('/lichess/ai', { method: 'POST', body: { level: Number(d.level), limit, increment, color: d.lichessColor } });
        navigate(`#/lichess/${gameId}`);
        return;
      }
      waiting = true;
      if (d.opponent === 'user') await api('/lichess/challenge', { method: 'POST', body: { username: d.username.trim(), limit, increment, color: d.lichessColor, rated: d.lichessRated === 'on' } });
      else await api('/lichess/seek', { method: 'POST', body: { limit, increment, rated: d.lichessRated === 'on' } });
      navigate('#/');
    } catch (err) {
      waiting = false;
      toast(err.message, 'error');
    } finally {
      start.disabled = false;
    }
  });
  clear(panel,
    el('p', { class: 'muted small' }, 'Playing as ', el('strong', {}, st.username), ' on Lichess. Lichess rates these games; your club rating is not affected. No evaluation bar or hints — Lichess forbids engine help during games.'),
    field('Opponent', opponent), usernameField, levelField, tcSlot, colorField, ratedField, start);
  sync();
  return panel;
}

/** Home page section: waiting status, incoming Lichess challenges and Lichess games in progress. */
export function lichessHomeSection({ navigate }) {
  const section = el('section', { class: 'lichess-home', hidden: true });
  const socket = getSocket();
  async function load() {
    let st;
    try {
      st = await lichessState();
    } catch {
      return;
    }
    if (!st.connected || (!st.seeking && !st.outgoing && !st.challenges.length && !st.games.length)) {
      section.hidden = true;
      return;
    }
    section.hidden = false;
    if (st.seeking || st.outgoing) waiting = true;
    const act = (fn) => async () => {
      try {
        await fn();
        load();
      } catch (err) {
        toast(err.message, 'error');
      }
    };
    clear(section,
      el('h2', {}, 'Lichess'),
      el('div', { class: 'list' },
        st.seeking ? el('div', { class: 'list-item' },
          el('div', {}, el('strong', {}, 'Looking for an opponent on Lichess…'),
            el('div', { class: 'muted small' }, `${tcLabel({ initial: st.seeking.time * 60, increment: st.seeking.increment })} · ${st.seeking.rated ? 'rated' : 'casual'}`)),
          el('button', { type: 'button', class: 'btn small', onclick: act(() => { waiting = false; return api('/lichess/seek/cancel', { method: 'POST' }); }) }, 'Cancel')) : null,
        st.outgoing ? el('div', { class: 'list-item' },
          el('div', {}, el('strong', {}, `Waiting for ${st.outgoing.username} to accept…`), el('div', { class: 'muted small' }, 'Challenge sent on Lichess')),
          el('button', { type: 'button', class: 'btn small', onclick: act(() => { waiting = false; return api('/lichess/challenge/cancel', { method: 'POST' }); }) }, 'Cancel')) : null,
        st.challenges.map((c) => el('div', { class: 'list-item' },
          el('div', {}, el('strong', {}, `${c.from}${c.rating ? ` (${c.rating})` : ''} challenges you`),
            el('div', { class: 'muted small' }, [c.timeControl, SPEED_LABEL[c.speed] || c.speed, c.rated ? 'rated' : 'casual'].filter(Boolean).join(' · '))),
          el('div', { class: 'row' },
            el('button', { type: 'button', class: 'btn primary small', onclick: act(() => { waiting = true; return api(`/lichess/challenges/${c.id}/accept`, { method: 'POST' }); }) }, 'Accept'),
            el('button', { type: 'button', class: 'btn small', onclick: act(() => api(`/lichess/challenges/${c.id}/decline`, { method: 'POST' })) }, 'Decline')))),
        st.games.map((g) => {
          const opp = g.myColor === 'white' ? g.black : g.white;
          const myTurn = g.moves.length % 2 === (g.myColor === 'white' ? 0 : 1);
          return el('a', { href: `#/lichess/${g.id}`, class: 'list-item' },
            el('div', {}, el('strong', {}, `vs ${opp.name}${opp.rating ? ` (${opp.rating})` : ''}`),
              el('div', { class: 'muted small' }, [SPEED_LABEL[g.speed] || g.speed, g.rated ? 'rated' : 'casual', `move ${Math.ceil((g.moves.length || 1) / 2)}`].join(' · '))),
            myTurn ? el('span', { class: 'badge live' }, 'Your move') : el('span', { class: 'muted small' }, 'Their move'));
        })));
  }
  socket.on('lichess:changed', load);
  load();
  return { el: section, cleanup: () => socket.off('lichess:changed', load) };
}

// ---------- playing a Lichess game ----------

const VALUES = { p: 1, n: 3, b: 3, r: 5, q: 9, k: 0 };

export function mountLichessGame(root, id, { navigate }) {
  const socket = getSocket();
  let game = null;
  let receivedAt = 0;
  let viewPly = null;
  let pending = false;
  let destroyed = false;
  let lastMoveCount = null;
  let endSounded = false;
  const clocks = { white: null, black: null };

  const topBar = el('div', { class: 'player-bar' });
  const bottomBar = el('div', { class: 'player-bar' });
  const boardWrap = el('div', { class: 'board-wrap' });
  const meta = el('div', { class: 'game-meta' });
  const status = el('div', { class: 'status' });
  const notice = el('div', { class: 'notice-area' });
  const moveList = el('div', { class: 'move-list' });
  const nav = el('div', { class: 'nav-buttons' });
  const controls = el('div', { class: 'controls' });
  clear(root, el('div', { class: 'game-layout' },
    el('div', { class: 'board-col' }, topBar, el('div', { class: 'board-row' }, boardWrap), bottomBar),
    el('aside', { class: 'side-panel card' }, meta, status, notice, moveList, nav, controls)));

  const board = new Board(boardWrap, {
    canMove: (color) => !!game && !game.finished && !pending && viewPly === null && color === (game.myColor === 'white' ? 'w' : 'b') && turn() === color,
    onMove: (from, to, promotion) => sendMove(from + to + (promotion || '')),
  });

  const turn = () => game.fen?.split(' ')[1] || (game.moves.length % 2 === 0 ? 'w' : 'b');
  const button = (label, onclick, cls = 'btn', title) => el('button', { type: 'button', class: cls, onclick, disabled: pending, title, 'aria-label': title }, label);

  async function action(name, body) {
    pending = true;
    render();
    try {
      await api(`/lichess/games/${id}/${name}`, { method: 'POST', body });
    } catch (err) {
      toast(err.message, 'error');
    } finally {
      pending = false;
      render();
    }
  }

  async function sendMove(uci) {
    // Show the move straight away; Lichess's next state confirms it (or puts the board back).
    const chess = position();
    try {
      chess.move({ from: uci.slice(0, 2), to: uci.slice(2, 4), promotion: uci[4] });
      board.skipNextAnimation = true;
      board.setPosition(chess, { from: uci.slice(0, 2), to: uci.slice(2, 4) });
    } catch {
      return;
    }
    await action('move', { uci });
  }

  function position(ply = game.moves.length) {
    const chess = new Chess(game.initialFen);
    for (const san of game.moves.slice(0, ply)) chess.move(san);
    return chess;
  }

  function remaining(color) {
    const base = color === 'white' ? game.wtime : game.btime;
    if (base == null) return null;
    const running = !game.finished && game.moves.length >= 2 && (turn() === 'w') === (color === 'white');
    return running ? base - (Date.now() - receivedAt) : base;
  }

  function playerBar(bar, color, chess) {
    const p = game[color];
    const c = color === 'white' ? 'w' : 'b';
    const opp = c === 'w' ? 'b' : 'w';
    const counts = { w: {}, b: {} };
    for (const row of chess.board()) for (const sq of row) if (sq) counts[sq.color][sq.type] = (counts[sq.color][sq.type] || 0) + 1;
    const start = { p: 8, n: 2, b: 2, r: 2, q: 1 };
    const captured = [];
    let material = 0;
    for (const t of ['q', 'r', 'b', 'n', 'p']) {
      for (let i = 0; i < Math.max(0, start[t] - (counts[opp][t] || 0)); i++) captured.push(makePiece({ type: t, color: opp }));
      material += ((counts[c][t] || 0) - (counts[opp][t] || 0)) * VALUES[t];
    }
    clocks[color] = game.clock ? el('span', { class: 'clock' }) : null;
    const diff = p.ratingDiff;
    clear(bar,
      el('span', { class: `turn-dot ${!game.finished && turn() === c ? 'on' : ''} ${color}` }),
      el('span', { class: 'player-name' }, p.title ? el('span', { class: 'lichess-title' }, `${p.title} `) : null, p.name,
        game.myColor === color ? el('span', { class: 'you' }, ' (you)') : null),
      p.rating ? el('span', { class: 'rating-tag' }, `${p.rating}${p.provisional ? '?' : ''}`,
        diff ? el('span', { class: `rating-delta ${diff > 0 ? 'up' : 'down'}` }, ` ${diff > 0 ? '+' : ''}${diff}`) : null) : null,
      el('span', { class: 'captured' }, captured),
      material > 0 ? el('span', { class: 'material' }, `+${material}`) : null,
      clocks[color]);
  }

  function tick() {
    if (!game || destroyed) return;
    for (const color of ['white', 'black']) {
      const node = clocks[color];
      if (!node) continue;
      const ms = remaining(color);
      node.textContent = ms == null ? '' : formatClock(ms);
      const running = !game.finished && game.moves.length >= 2 && (turn() === 'w') === (color === 'white');
      node.classList.toggle('running', running);
      node.classList.toggle('low', running && ms < 20000);
    }
  }

  function statusText() {
    if (game.finished) {
      if (game.status === 'aborted' || game.status === 'noStart') return 'Game aborted';
      const winner = game.winner ? game[game.winner].name : null;
      const how = { mate: 'checkmate', resign: 'resignation', outoftime: 'time', timeout: 'opponent left', stalemate: 'stalemate', draw: 'agreement' }[game.status] || game.status;
      return winner ? `${winner} wins by ${how}` : `Draw${how && how !== 'agreement' ? ` — ${how}` : ''}`;
    }
    if (viewPly !== null) return `Viewing move ${Math.ceil(viewPly / 2)}`;
    const mine = turn() === (game.myColor === 'white' ? 'w' : 'b');
    return mine ? 'Your move' : 'Waiting for your opponent';
  }

  function render() {
    if (!game || destroyed) return;
    if (game.error) {
      clear(root, el('div', { class: 'card empty' }, game.error, ' ', el('a', { href: '#/' }, 'Go home')));
      return;
    }
    if (game.loading) {
      clear(status, 'Connecting to Lichess…');
      return;
    }
    if (board.orientation !== game.myColor && game.myColor) board.setOrientation(game.myColor);
    const ply = viewPly ?? game.moves.length;
    const chess = position(ply);
    const history = chess.history({ verbose: true });
    const last = history.at(-1);
    if (!(pending && viewPly === null)) board.setPosition(chess, last ? { from: last.from, to: last.to } : null);
    const bottom = board.orientation === 'white' ? 'white' : 'black';
    playerBar(bottomBar, bottom, chess);
    playerBar(topBar, bottom === 'white' ? 'black' : 'white', chess);

    const tc = game.clock?.initial != null ? { initial: game.clock.initial / 1000, increment: game.clock.increment / 1000 } : null;
    clear(meta,
      el('div', { class: 'game-meta-top' },
        el('a', { href: game.url, target: '_blank', rel: 'noopener', class: 'club-link' }, 'Open on Lichess'),
        el('span', { class: 'badges' }, !game.finished ? el('span', { class: 'badge live' }, 'Live') : null)),
      el('div', { class: 'muted small game-facts' }, ['Lichess', game.rated ? 'Rated' : 'Casual', tc ? `${tcLabel(tc)} ${speedName(tc)}` : null].filter(Boolean).join(' · ')));
    status.className = `status ${game.finished ? 'over' : ''}`;
    clear(status, statusText());

    clear(notice);
    const myColor = game.myColor;
    if (!game.finished && game.drawOffer && game.drawOffer !== myColor) {
      clear(notice, el('div', { class: 'draw-offer' }, 'Your opponent offers a draw.',
        button('Accept', () => action('draw-accept'), 'btn primary'), button('Decline', () => action('draw-decline'))));
    } else if (!game.finished && game.opponentGone) {
      const secs = game.opponentGone.claimWinInSeconds;
      clear(notice, el('div', { class: 'draw-offer' }, secs > 0 ? `Your opponent left the game. You can claim the win in ${secs} s.` : 'Your opponent left the game.',
        secs === 0 ? button('Claim victory', () => action('claim-victory'), 'btn primary') : null));
    } else if (game.finished && game.importedId) {
      clear(notice, el('div', { class: 'muted small' }, 'Saved to your games. ', el('a', { href: `#/game/${game.importedId}` }, 'Open it for game review'), '.'));
    }

    clear(moveList, game.moves.length ? game.moves.reduce((rows, san, i) => {
      if (i % 2 === 0) rows.push(el('div', { class: 'move-row' }, el('span', { class: 'move-num' }, `${i / 2 + 1}.`)));
      const p = i + 1;
      rows.at(-1).appendChild(el('button', { type: 'button', class: `move ${(viewPly ?? game.moves.length) === p ? 'current' : ''}`, onclick: () => { viewPly = p === game.moves.length ? null : p; render(); } }, san));
      return rows;
    }, []) : el('div', { class: 'muted' }, 'No moves yet'));
    const current = moveList.querySelector('.current');
    if (current) {
      if (moveList.scrollWidth > moveList.clientWidth + 1) moveList.scrollLeft = current.offsetLeft - moveList.clientWidth / 2;
      else moveList.scrollTop = current.offsetTop - moveList.clientHeight / 2;
    }
    const step = (p) => { viewPly = p >= game.moves.length ? null : Math.max(0, p); render(); };
    clear(nav,
      button(icon('first'), () => step(0), 'btn ghost', 'Start'),
      button(icon('prev'), () => step((viewPly ?? game.moves.length) - 1), 'btn ghost', 'Previous move'),
      button(icon('next'), () => step((viewPly ?? game.moves.length) + 1), 'btn ghost', 'Next move'),
      button(icon('last'), () => step(game.moves.length), 'btn ghost', 'Latest move'));

    const items = [];
    if (!game.finished) {
      if (game.moves.length < 2) items.push(button('Abort', () => action('abort')));
      else if (game.drawOffer === myColor) items.push(button('Draw offered…', null, 'btn'));
      else items.push(button('Offer draw', () => action('draw-offer')));
      items.push(button('Resign', () => confirm('Resign this game on Lichess?') && action('resign'), 'btn danger'));
    } else {
      items.push(el('a', { href: '#/new?mode=lichess', class: 'btn primary' }, 'New Lichess game'));
    }
    clear(controls, el('div', { class: 'row game-actions' }, items),
      el('div', { class: 'row game-tools' }, button([icon('flip', { size: 16 }), ' Flip board'], () => { board.flip(); render(); }, 'btn small ghost')));
    tick();
    document.title = !game.finished && turn() === (myColor === 'white' ? 'w' : 'b') ? 'Your move — Chess Club' : 'Chess Club';
  }

  function onGame(snap) {
    if (snap.id !== id || destroyed) return;
    const before = lastMoveCount;
    game = snap;
    receivedAt = Date.now();
    if (before !== null && snap.moves?.length > before) soundForMove(snap.moves.at(-1))();
    if (snap.finished && !endSounded) {
      endSounded = true;
      if (before !== null) sounds.gameEnd();
    }
    lastMoveCount = snap.moves?.length ?? null;
    render();
  }

  const onConnect = () => socket.emit('watch:lichess', id);
  socket.on('lichess:game', onGame);
  socket.on('connect', onConnect);
  if (socket.connected) onConnect();
  api(`/lichess/games/${id}`).then(({ game: snap }) => { if (!game || game.loading) onGame(snap); }).catch((err) => {
    if (destroyed) return;
    clear(root, el('div', { class: 'card empty' }, err.message, ' ', el('a', { href: '#/' }, 'Go home')));
  });
  const timer = setInterval(tick, 200);
  return () => {
    destroyed = true;
    clearInterval(timer);
    socket.emit('unwatch:lichess', id);
    socket.off('lichess:game', onGame);
    socket.off('connect', onConnect);
    document.title = 'Chess Club';
  };
}
