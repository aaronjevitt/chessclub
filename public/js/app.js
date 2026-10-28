import './no-double-tap-zoom.js';
import { api, getSocket, resetSocket } from './api.js';
import { el, clear, toast, timeAgo } from './dom.js';
import { field, formData, submitting, copyText } from './ui.js';
import { resetView } from './account-view.js';
import { clubSettingsCard, memberMenu } from './club-admin-view.js';
import { gameCard } from './game-card.js';
import { soundEnabled, setSoundEnabled, sounds } from './sounds.js';
import { profileView } from './profile-view.js';
import { puzzleView } from './puzzle-view.js';
import { importCard } from './import-view.js';
import { installLichessListeners, lichessHomeSection, lichessPlayPanel, mountLichessGame } from './lichess.js';
import { clubTournamentsCard, tournamentView } from './tournament-view.js';
import { renderMiniBoard } from './board.js';
import { mountGameView, MODE_LABEL, resultText } from './game-view.js';
import { listLocalGames, saveLocalGame, newLocalId } from './local-games.js';
import { BOTS, MIN_ELO, MAX_ELO, botName, clampElo, isApproximate } from './bots.js';
import { mountTvView } from './tv-view.js';
import { timeControlPicker, tcDescription, tcLabel } from './time-control.js';
import { evalBarLabel } from './eval-settings.js';
import { icon } from './icons.js';
import { registerServiceWorker } from './push.js';

registerServiceWorker();

const START_FEN = 'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1';
const main = document.getElementById('main');
const nav = document.getElementById('nav');
let user = null;
let cleanup = null;
let routeToken = 0;

function navigate(hash) {
  if (location.hash === hash) route();
  else location.hash = hash;
}

// Phones get an app-style tab bar along the bottom instead of the links in the header.
const tabbar = el('nav', { class: 'tabbar', 'aria-label': 'Main' });
document.body.appendChild(tabbar);

function markActiveTab() {
  const section = location.hash.slice(2).split(/[/?]/)[0] || 'home';
  for (const a of tabbar.querySelectorAll('a')) {
    const tab = a.dataset.tab;
    a.classList.toggle('active', tab === section || (tab === 'home' && ['club', 'game', 'local', 'tournament'].includes(section))
      || (tab === 'player' && section === 'account'));
  }
}

function renderNav() {
  if (!user) {
    clear(nav, el('a', { href: '#/login' }, 'Log in'), el('a', { href: '#/register', class: 'btn primary small' }, 'Sign up'));
    clear(tabbar);
    document.body.classList.remove('has-tabbar');
    return;
  }
  const tab = (href, name, iconName, label) => el('a', { href, dataset: { tab: name } }, icon(iconName, { size: 22 }), el('span', {}, label));
  clear(tabbar,
    tab('#/', 'home', 'home', 'Home'),
    tab('#/new', 'new', 'play', 'Play'),
    tab('#/puzzles', 'puzzles', 'target', 'Puzzles'),
    tab(`#/player/${user.id}`, 'player', 'user', 'Profile'));
  document.body.classList.add('has-tabbar');
  markActiveTab();
  installLichessListeners(navigate);
  clear(nav,
    el('a', { href: '#/', class: 'nav-link' }, 'Home'),
    el('a', { href: '#/new', class: 'nav-link' }, 'New game'),
    el('a', { href: '#/puzzles', class: 'nav-link' }, 'Puzzles'),
    el('button', {
      type: 'button',
      class: 'btn ghost small sound-toggle',
      title: 'Sounds on/off',
      'aria-label': 'Toggle sounds',
      onclick: (e) => {
        setSoundEnabled(!soundEnabled());
        e.currentTarget.replaceChildren(icon(soundEnabled() ? 'volume' : 'mute'));
        if (soundEnabled()) sounds.move();
      },
    }, icon(soundEnabled() ? 'volume' : 'mute')),
    el('a', { href: `#/player/${user.id}`, class: 'nav-user', title: 'Your profile' }, icon('user'), el('span', { class: 'nav-name' }, user.username)),
    el('button', {
      type: 'button',
      class: 'btn ghost small nav-logout',
      onclick: async () => {
        await api('/logout', { method: 'POST' }).catch(() => {});
        user = null;
        resetSocket();
        renderNav();
        navigate('#/login');
      },
    }, 'Log out'));
}

/** "Show evaluation bar" checkbox plus an optional move limit after which the bar fades away. */
function evalBarField(note) {
  return el('div', { class: 'eval-option' },
    el('label', { class: 'check' }, el('input', { type: 'checkbox', name: 'evalBar' }), ' Show evaluation bar'),
    el('span', { class: 'eval-note muted small' }, note),
    el('label', { class: 'eval-limit muted small', title: 'Optional. The bar fades out over the last few moves.' }, 'Hide after',
      el('input', { type: 'number', name: 'evalBarMoves', min: 1, max: 200, placeholder: '—', 'aria-label': 'Hide the evaluation bar after this many moves (optional)' }),
      'moves (optional)'));
}

/** Eval bar settings from a submitted form: {evalBar, evalBarMoves?}, or {} when off. */
function evalBarSettings(d) {
  if (d.evalBar !== 'on') return {};
  const n = Math.round(Number(d.evalBarMoves));
  return n >= 1 && n <= 200 ? { evalBar: true, evalBarMoves: n } : { evalBar: true };
}

// ---------- auth ----------

function authView(mode) {
  const isLogin = mode === 'login';
  const form = el('form', { class: 'card auth-card' },
    el('h1', {}, isLogin ? 'Welcome back' : 'Create your account'),
    el('p', { class: 'muted' }, isLogin ? 'Log in to play with your club.' : 'Join a club, challenge members, or play the computer.'),
    field('Username', el('input', { name: 'username', required: true, autocomplete: 'username', minlength: 3, maxlength: 20, pattern: '[A-Za-z0-9_\\-]+' })),
    field('Password', el('input', { name: 'password', type: 'password', required: true, minlength: 6, autocomplete: isLogin ? 'current-password' : 'new-password' })),
    el('button', { type: 'submit', class: 'btn primary block' }, isLogin ? 'Log in' : 'Sign up'),
    el('p', { class: 'muted small center' }, isLogin ? 'New here? ' : 'Already have an account? ',
      el('a', { href: isLogin ? '#/register' : '#/login' }, isLogin ? 'Create an account' : 'Log in')));
  form.addEventListener('submit', (e) => {
    e.preventDefault();
    submitting(form, async () => {
      const data = await api(isLogin ? '/login' : '/register', { method: 'POST', body: formData(form) });
      user = data.user;
      resetSocket();
      renderNav();
      navigate(sessionStorage.getItem('afterLogin') || '#/');
      sessionStorage.removeItem('afterLogin');
    });
  });
  clear(main, el('div', { class: 'auth-wrap' }, form));
}

// ---------- shared bits ----------


// ---------- home ----------

async function homeView() {
  const wrap = el('div', { class: 'home' });
  clear(main, wrap);
  const [{ mine, discover }, { games }] = await Promise.all([api('/clubs'), api('/my/games')]);
  const localGames = listLocalGames(user.id);
  const myTurn = games.filter((g) => g.status === 'active' && g.mode === 'online' &&
    ((g.turn === 'w' && g.white.id === user.id) || (g.turn === 'b' && g.black.id === user.id)));
  const challengesForMe = games.filter((g) => g.status === 'waiting' && g.invitedId === user.id);
  const lichess = lichessHomeSection({ navigate });

  const createForm = el('form', { class: 'stack' },
    field('Club name', el('input', { name: 'name', required: true, minlength: 2, maxlength: 60 })),
    field('Description', el('textarea', { name: 'description', rows: 2, maxlength: 500 })),
    el('label', { class: 'check' }, el('input', { type: 'checkbox', name: 'isPublic', checked: true }), ' Public (anyone can find and join)'),
    el('button', { type: 'submit', class: 'btn primary' }, 'Create club'));
  createForm.addEventListener('submit', (e) => {
    e.preventDefault();
    submitting(createForm, async () => {
      const d = formData(createForm);
      const { club } = await api('/clubs', { method: 'POST', body: { name: d.name, description: d.description, isPublic: d.isPublic === 'on' } });
      navigate(`#/club/${club.id}`);
    });
  });

  const codeForm = el('form', { class: 'row' },
    el('input', { name: 'code', placeholder: 'Invite code', required: true, maxlength: 20, 'aria-label': 'Invite code' }),
    el('button', { type: 'submit', class: 'btn' }, 'Join'));
  codeForm.addEventListener('submit', (e) => {
    e.preventDefault();
    submitting(codeForm, async () => {
      const { club } = await api('/clubs/join-by-code', { method: 'POST', body: formData(codeForm) });
      navigate(`#/club/${club.id}`);
    });
  });

  clear(wrap,
    el('section', { class: 'hero card' },
      el('div', {},
        el('h1', {}, `Hi, ${user.username}`),
        el('p', { class: 'muted' }, myTurn.length ? `It's your move in ${myTurn.length} game${myTurn.length > 1 ? 's' : ''}.` : 'Ready for a game?')),
      el('div', { class: 'quick-play' },
        el('a', { href: '#/new?mode=computer', class: 'quick' }, el('strong', {}, 'Play the computer'), el('span', { class: 'muted small' }, 'Stockfish, any strength')),
        el('a', { href: '#/new?mode=otb', class: 'quick' }, el('strong', {}, 'Record a real game'), el('span', { class: 'muted small' }, 'Enter moves as you play')),
        el('a', { href: '#/puzzles', class: 'quick' }, el('strong', {}, 'Puzzles'), el('span', { class: 'muted small' }, 'From your own mistakes')))),

    lichess.el,

    challengesForMe.length ? el('section', {},
      el('h2', {}, 'Challenges for you'),
      el('div', { class: 'list' }, challengesForMe.map((g) => challengeRow(g, homeView)))) : null,

    el('section', {},
      el('h2', {}, 'Your games'),
      games.length + localGames.filter((g) => g.status === 'active').length === 0
        ? el('p', { class: 'muted' }, 'No games in progress. Start one above, or challenge someone in a club.')
        : el('div', { class: 'game-grid' },
          games.filter((g) => g.status === 'active').map((g) => gameCard(g)),
          localGames.filter((g) => g.status === 'active').map((g) => gameCard(g, { local: true })))),

    localGames.some((g) => g.status !== 'active') ? el('section', {},
      el('details', {},
        el('summary', {}, `Finished private games (${localGames.filter((g) => g.status !== 'active').length})`),
        el('div', { class: 'game-grid' }, localGames.filter((g) => g.status !== 'active').map((g) => gameCard(g, { local: true }))))) : null,

    el('div', { class: 'two-col' },
      el('section', {},
        el('h2', {}, 'Your clubs'),
        mine.length ? el('div', { class: 'list' }, mine.map((c) => el('a', { href: `#/club/${c.id}`, class: 'list-item club-item' },
          el('div', {}, el('strong', {}, c.name), c.role === 'owner' ? el('span', { class: 'badge' }, 'Owner') : null,
            el('div', { class: 'muted small' }, c.description || '')),
          el('div', { class: 'muted small right' }, `${c.memberCount} member${c.memberCount === 1 ? '' : 's'}`,
            c.activeGames ? el('div', { class: 'live-text' }, `${c.activeGames} live`) : null))))
          : el('p', { class: 'muted' }, "You haven't joined any clubs yet."),
        el('h3', {}, 'Have an invite code?'), codeForm,
        discover.length ? el('div', {},
          el('h3', {}, 'Discover clubs'),
          el('div', { class: 'list' }, discover.map((c) => el('div', { class: 'list-item club-item' },
            el('div', {}, el('strong', {}, c.name), el('div', { class: 'muted small' }, c.description || ''),
              el('div', { class: 'muted small' }, `${c.memberCount} member${c.memberCount === 1 ? '' : 's'}`)),
            el('button', {
              type: 'button',
              class: 'btn small',
              onclick: async () => {
                try {
                  await api(`/clubs/${c.id}/join`, { method: 'POST' });
                  navigate(`#/club/${c.id}`);
                } catch (err) {
                  toast(err.message, 'error');
                }
              },
            }, 'Join'))))) : null),
      // Once you're in a club, starting another is the rare case: keep the form folded away.
      mine.length
        ? el('details', { class: 'card start-club' }, el('summary', {}, 'Start a new club'), createForm)
        : el('section', { class: 'card' }, el('h2', {}, 'Start a club'), createForm)));
  return lichess.cleanup;
}

function challengeRow(g, refresh, { showClub = true } = {}) {
  const forMe = g.invitedId === user.id;
  const mine = g.createdBy === user.id;
  const colorText = g.creatorColor === 'random' ? 'random colors' : `${g.creatorName} plays ${g.creatorColor}`;
  const act = (path) => async () => {
    try {
      const { game } = await api(`/games/${g.id}/${path}`, { method: 'POST' });
      if (path === 'accept') navigate(`#/game/${game.id}`);
      else refresh();
    } catch (err) {
      toast(err.message, 'error');
    }
  };
  return el('div', { class: 'list-item' },
    el('div', {},
      el('strong', {}, mine ? (g.invitedName ? `You challenged ${g.invitedName}` : 'Your open challenge') : `${g.creatorName} challenges ${forMe ? 'you' : 'anyone'}`),
      g.visibility === 'private' ? el('span', { class: 'badge private' }, 'Private') : null,
      el('div', { class: 'muted small' }, [g.meta?.rated === false ? 'Casual' : 'Rated', tcDescription(g.timeControl), colorText,
        g.meta?.evalBar ? evalBarLabel(g.meta) : null, showClub ? g.clubName : null, timeAgo(g.createdAt)].filter(Boolean).join(' · '))),
    el('div', { class: 'row' },
      mine ? el('button', { type: 'button', class: 'btn small', onclick: act('cancel') }, 'Cancel') : null,
      !mine ? el('button', { type: 'button', class: 'btn primary small', onclick: act('accept') }, 'Accept') : null,
      forMe ? el('button', { type: 'button', class: 'btn small', onclick: act('cancel') }, 'Decline') : null));
}

// ---------- club ----------


async function clubView(clubId) {
  const socket = getSocket();
  const root = el('div');
  clear(main, root);
  let detail;
  try {
    detail = await api(`/clubs/${clubId}`);
  } catch (err) {
    clear(root, el('div', { class: 'card empty' }, err.message, ' ', el('a', { href: '#/' }, 'Go home')));
    return;
  }
  const { club, membership } = detail;

  if (!membership) {
    clear(root, el('div', { class: 'card empty' },
      el('h1', {}, club.name), el('p', { class: 'muted' }, club.description),
      el('button', {
        type: 'button',
        class: 'btn primary',
        onclick: async () => {
          try {
            await api(`/clubs/${club.id}/join`, { method: 'POST' });
            route();
          } catch (err) {
            toast(err.message, 'error');
          }
        },
      }, 'Join this club')));
    return;
  }

  const liveSection = el('div');
  const tournaments = clubTournamentsCard(club, { navigate });
  const challengeSection = el('div');
  const finishedSection = el('div');
  const membersSection = el('div');
  let members = detail.members;

  const challengeTc = timeControlPicker();
  const challengeForm = el('form', { class: 'stack' },
    field('Opponent', el('select', { name: 'opponentId' },
      el('option', { value: '' }, 'Anyone in the club'),
      members.filter((m) => m.id !== user.id).map((m) => el('option', { value: m.id }, m.username)))),
    field('Your color', el('select', { name: 'color' },
      el('option', { value: 'random' }, 'Random'), el('option', { value: 'white' }, 'White'), el('option', { value: 'black' }, 'Black'))),
    field('Visibility', el('select', { name: 'visibility' },
      el('option', { value: 'club' }, 'Club — members can watch live'),
      el('option', { value: 'private' }, 'Private — only the two players'))),
    field('Time control', challengeTc.el),
    el('label', { class: 'check' }, el('input', { type: 'checkbox', name: 'rated', checked: true }), ' Rated ',
      el('span', { class: 'muted small' }, '(counts towards club ratings)')),
    evalBarField('Both players and spectators see it.'),
    el('button', { type: 'submit', class: 'btn primary' }, 'Send challenge'));
  const challengeCard = el('details', { class: 'card challenge-card' },
    el('summary', { class: 'btn primary block' }, 'New challenge'), challengeForm);
  /** Open the challenge form, optionally with an opponent picked (the members list's Challenge buttons). */
  function openChallenge(opponentId = '') {
    challengeForm.elements.opponentId.value = String(opponentId);
    challengeCard.open = true;
    challengeCard.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
  }
  challengeForm.addEventListener('submit', (e) => {
    e.preventDefault();
    submitting(challengeForm, async () => {
      const d = formData(challengeForm);
      const { game } = await api(`/clubs/${club.id}/games`, {
        method: 'POST',
        body: {
          mode: 'online',
          color: d.color,
          visibility: d.visibility,
          opponentId: d.opponentId ? Number(d.opponentId) : null,
          ...evalBarSettings(d),
          rated: d.rated === 'on',
          timeControl: challengeTc.read(),
        },
      });
      toast(game.invitedName ? `Challenge sent to ${game.invitedName}` : 'Open challenge posted');
      challengeCard.open = false;
      loadGames();
    });
  });

  async function loadGames() {
    let data;
    try {
      data = await api(`/clubs/${club.id}/games`);
    } catch (err) {
      toast(err.message, 'error');
      return;
    }
    clear(liveSection,
      el('h2', {}, 'Live games ', el('span', { class: 'count' }, String(data.active.length))),
      data.active.length
        // Oldest first, so cards keep their place as moves come in.
        ? el('div', { class: 'game-grid live-grid' }, [...data.active].sort((a, b) => (a.createdAt || 0) - (b.createdAt || 0)).map((g) => gameCard(g, { showClub: false })))
        : el('p', { class: 'muted' }, 'No games in progress. Challenge someone, or broadcast a game against the computer or over the board.'));
    clear(challengeSection,
      el('h2', {}, 'Open challenges'),
      data.waiting.length
        ? el('div', { class: 'list' }, data.waiting.map((g) => challengeRow(g, loadGames, { showClub: false })))
        : el('p', { class: 'muted' }, 'No open challenges.'));
    clear(finishedSection,
      data.finished.length ? el('details', {},
        el('summary', {}, `Recently finished (${data.finished.length})`),
        el('div', { class: 'game-grid' }, data.finished.map((g) => gameCard(g, { showClub: false })))) : null);
  }

  // Members and club ratings are one list: rated members by rating, then everyone else by name.
  async function loadMembers() {
    let board = [];
    try {
      [members, { leaderboard: board }] = await Promise.all([
        api(`/clubs/${club.id}`).then((d) => d.members),
        api(`/clubs/${club.id}/leaderboard`),
      ]);
    } catch {
      return;
    }
    const rated = new Map(board.map((r, i) => [r.id, { ...r, rank: i + 1 }]));
    const sorted = [...members].sort((a, b) => (rated.get(a.id)?.rank ?? Infinity) - (rated.get(b.id)?.rank ?? Infinity)
      || a.username.localeCompare(b.username));
    const isOwner = membership.role === 'owner';
    clear(membersSection,
      el('div', { class: 'section-head' },
        el('h2', {}, 'Members ', el('span', { class: 'count' }, String(members.length))),
        el('span', { class: 'muted small', title: 'Ratings start at 1200; ? = provisional (fewer than 10 rated games)' }, 'by club rating')),
      el('div', { class: 'list members' }, sorted.map((m) => {
        const r = rated.get(m.id);
        const panel = el('div', { class: 'member-panel' });
        return el('div', { class: `member-entry ${m.id === user.id ? 'me' : ''}` }, el('div', { class: 'list-item' },
          el('span', { class: 'member-rank muted' }, r ? String(r.rank) : ''),
          el('div', { class: 'member-who' },
            el('a', { href: `#/player/${m.id}`, class: 'member-name' }, m.username),
            m.role === 'owner' ? el('span', { class: 'badge' }, 'Owner') : null,
            el('div', { class: 'muted small' }, r ? `${r.wins}–${r.draws}–${r.losses}` : 'No rated games')),
          el('span', { class: 'member-rating', title: r?.provisional ? `Provisional (${r.games} of 10 games)` : '' }, r ? `${r.rating}${r.provisional ? '?' : ''}` : ''),
          m.id !== user.id ? memberMenu(club, m, { isOwner, onChallenge: () => openChallenge(m.id), onRemoved: loadMembers, panel }) : el('span')), panel);
      })));
  }

  clear(root, el('div', { class: 'club' },
    el('section', { class: 'card club-header' },
      el('div', {},
        el('h1', {}, club.name),
        club.description ? el('p', { class: 'muted' }, club.description) : null,
        el('div', { class: 'muted small' },
          club.isPublic ? 'Public club' : 'Private club', ' · Invite code ', el('code', { class: 'invite' }, club.inviteCode),
          el('button', { type: 'button', class: 'btn small ghost', onclick: () => copyText(club.inviteCode) }, 'Copy'))),
      el('div', { class: 'row' },
        el('a', { href: `#/tv/${club.id}`, class: 'btn' }, 'Projector view'),
        el('a', { href: `#/new?club=${club.id}`, class: 'btn' }, 'Broadcast a game'),
        membership.role !== 'owner' ? el('button', {
          type: 'button',
          class: 'btn ghost',
          onclick: async () => {
            if (!confirm(`Leave ${club.name}?`)) return;
            try {
              await api(`/clubs/${club.id}/leave`, { method: 'POST' });
              navigate('#/');
            } catch (err) {
              toast(err.message, 'error');
            }
          },
        }, 'Leave club') : null)),
    el('div', { class: 'club-body' },
      el('div', { class: 'club-main' }, liveSection, challengeSection, tournaments.el, finishedSection),
      el('aside', { class: 'club-side' },
        challengeCard,
        el('section', { class: 'card' }, membersSection),
        membership.role === 'owner' ? clubSettingsCard(club, () => route()) : null))));

  await Promise.all([loadGames(), loadMembers(), tournaments.load()]);

  let timer = null;
  const onChanged = ({ clubId: changed }) => {
    if (changed !== club.id) return;
    clearTimeout(timer);
    timer = setTimeout(() => {
      loadGames();
      loadMembers();
      tournaments.load();
    }, 150);
  };
  const watch = () => socket.emit('watch:club', club.id);
  socket.on('club:changed', onChanged);
  socket.on('connect', watch);
  if (socket.connected) watch();
  // Keep "x ago" labels fresh.
  const refresh = setInterval(loadGames, 60000);

  return () => {
    clearTimeout(timer);
    clearInterval(refresh);
    socket.emit('unwatch:club', club.id);
    socket.off('club:changed', onChanged);
    socket.off('connect', watch);
  };
}

// ---------- new game ----------

async function newGameView(params) {
  const wrap = el('div', { class: 'narrow' });
  clear(main, wrap);
  const { mine } = await api('/clubs');
  const mode = ['computer', 'self', 'otb', 'lichess'].includes(params.get('mode')) ? params.get('mode') : 'computer';
  const preClub = params.get('club');

  const modeOption = (value, title, desc) => el('label', { class: 'mode-option' },
    el('input', { type: 'radio', name: 'mode', value, checked: value === mode }),
    el('div', {}, el('strong', {}, title), el('div', { class: 'muted small' }, desc)));

  const computerTc = timeControlPicker();
  const computerFields = el('div', { class: 'stack mode-fields', dataset: { mode: 'computer' } },
    field('Your color', el('select', { name: 'playerColor' },
      el('option', { value: 'white' }, 'White'), el('option', { value: 'black' }, 'Black'), el('option', { value: 'random' }, 'Random'))),
    field('Opponent', el('select', { name: 'bot' },
      BOTS.map((b, i) => el('option', { value: i, selected: b.elo === 1500 }, `${b.name} — ${b.elo}${isApproximate(b.elo) ? ' (approx.)' : ''} · ${b.blurb}`)),
      el('option', { value: 'custom' }, 'Custom Elo…'))),
    el('div', { class: 'field custom-elo', hidden: true },
      el('span', { class: 'field-label' }, 'Computer Elo'),
      el('div', { class: 'row' },
        el('input', { type: 'range', name: 'eloRange', min: MIN_ELO, max: MAX_ELO, step: 10, value: 1500, 'aria-label': 'Computer Elo' }),
        el('input', { type: 'number', name: 'elo', min: MIN_ELO, max: MAX_ELO, step: 10, value: 1500, class: 'elo-number', 'aria-label': 'Computer Elo value' })),
      el('span', { class: 'hint' }, `${MIN_ELO}–${MAX_ELO}. Stockfish's own strength limiter covers 1320 and up; lower ratings are approximate.`)),
    field('Time control', computerTc.el));
  const otbFields = el('div', { class: 'stack mode-fields', dataset: { mode: 'otb' } },
    field('White player', el('input', { name: 'whiteName', maxlength: 40, placeholder: 'White' })),
    field('Black player', el('input', { name: 'blackName', maxlength: 40, placeholder: 'Black' })),
    field('Event', el('input', { name: 'event', maxlength: 80, placeholder: 'e.g. Tuesday club night, board 1' })),
    el('p', { class: 'muted small' }, 'Enter the moves of a real over-the-board game as it is played.'));

  const lichessPanel = await lichessPlayPanel({ navigate, profileHref: `#/player/${user.id}` });
  const form = el('form', { class: 'card new-game stack' },
    el('h1', {}, 'New game'),
    el('div', { class: 'mode-options' },
      modeOption('computer', 'Play the computer', 'Stockfish, running in your browser'),
      modeOption('self', 'Play yourself', 'Move both sides — practice or analysis'),
      modeOption('otb', 'Record a real game', 'Enter the moves of an over-the-board game as it is played'),
      modeOption('lichess', 'Play on Lichess', 'Find or challenge Lichess players, or play the Lichess computer')),
    computerFields, otbFields, lichessPanel,
    el('div', { class: 'not-lichess' }, evalBarField('Stockfish’s assessment beside the board; spectators see it too.')),
    el('details', { class: 'not-lichess' },
      el('summary', {}, 'Custom starting position'),
      field('FEN', el('input', { name: 'fen', placeholder: START_FEN, spellcheck: 'false' }), 'Leave empty for the standard starting position.')),
    el('div', { class: 'not-lichess' }, field('Visibility', el('select', { name: 'broadcast' },
      el('option', { value: '' }, 'Private — keep on this device only'),
      mine.map((c) => el('option', { value: c.id, selected: String(c.id) === preClub }, `Broadcast live to ${c.name}`))),
    'You can start or stop broadcasting at any time during the game.')),
    el('button', { type: 'submit', class: 'btn primary not-lichess' }, 'Start game'));

  const sync = () => {
    const current = form.querySelector('input[name=mode]:checked').value;
    form.querySelectorAll('.mode-fields').forEach((f) => { f.hidden = f.dataset.mode !== current; });
    form.querySelectorAll('.not-lichess').forEach((f) => { f.hidden = current === 'lichess'; });
    form.querySelector('.custom-elo').hidden = current !== 'computer' || form.elements.bot.value !== 'custom';
  };
  // Keep the Elo slider and number box in step.
  form.elements.eloRange.addEventListener('input', () => { form.elements.elo.value = form.elements.eloRange.value; });
  form.elements.elo.addEventListener('input', () => { form.elements.eloRange.value = form.elements.elo.value; });
  form.addEventListener('change', sync);
  sync();

  form.addEventListener('submit', (e) => {
    e.preventDefault();
    submitting(form, async () => {
      const d = formData(form);
      const startFen = (d.fen || '').trim() || START_FEN;
      try {
        const { Chess } = await import('/vendor/chess.js');
        new Chess(startFen);
      } catch {
        throw new Error('That FEN is not a valid position');
      }
      const timeControl = d.mode === 'computer' ? computerTc.read() : null;
      const playerColor = d.playerColor === 'random' ? (Math.random() < 0.5 ? 'white' : 'black') : d.playerColor;
      const chosenBot = d.bot === 'custom' ? null : BOTS[Number(d.bot)];
      const elo = chosenBot ? chosenBot.elo : clampElo(d.elo);
      const computer = botName(elo, chosenBot?.name);
      let whiteName;
      let blackName;
      const gameMeta = evalBarSettings(d);
      if (d.mode === 'computer') {
        whiteName = playerColor === 'white' ? user.username : computer;
        blackName = playerColor === 'black' ? user.username : computer;
        Object.assign(gameMeta, { playerColor, elo, ...(chosenBot ? { bot: chosenBot.name } : {}) });
      } else if (d.mode === 'otb') {
        whiteName = d.whiteName.trim() || 'White';
        blackName = d.blackName.trim() || 'Black';
        if (d.event.trim()) gameMeta.event = d.event.trim();
      } else {
        whiteName = blackName = user.username;
      }

      if (d.broadcast) {
        const { game } = await api(`/clubs/${d.broadcast}/games`, {
          method: 'POST',
          body: { mode: d.mode, startFen, whiteName, blackName, timeControl, ...gameMeta },
        });
        navigate(`#/game/${game.id}`);
        return;
      }
      const local = {
        id: newLocalId(),
        mode: d.mode,
        status: 'active',
        result: '*',
        termination: null,
        startFen,
        moves: [],
        white: { name: whiteName },
        black: { name: blackName },
        meta: gameMeta,
        createdAt: Date.now(),
        timeControl,
        clock: timeControl
          ? { white: timeControl.initial * 1000, black: timeControl.initial * 1000, running: null, since: Date.now() }
          : null,
      };
      saveLocalGame(user.id, local);
      navigate(`#/local/${local.id}`);
    });
  });

  clear(wrap, form, mine.length ? importCard(mine, { preClub, navigate }) : null);
}

// ---------- router ----------

async function route() {
  const token = ++routeToken;
  if (cleanup) {
    try {
      cleanup();
    } catch {
      // ignore cleanup errors from the previous view
    }
    cleanup = null;
  }
  const [path, query = ''] = location.hash.slice(1).split('?');
  const params = new URLSearchParams(query);
  const parts = (path || '/').split('/').filter(Boolean);

  if (parts[0] === 'reset' && parts[1]) {
    await resetView(main, parts[1], (u) => {
      user = u;
      resetSocket();
      renderNav();
      navigate('#/');
    });
    return;
  }
  if (!user && !['login', 'register'].includes(parts[0])) {
    if (location.hash && location.hash !== '#/') sessionStorage.setItem('afterLogin', location.hash);
    navigate('#/login');
    return;
  }
  if (user && ['login', 'register'].includes(parts[0])) {
    navigate('#/');
    return;
  }

  clear(main, el('div', { class: 'loading' }, 'Loading…'));
  try {
    let viewCleanup = null;
    if (parts[0] === 'login' || parts[0] === 'register') authView(parts[0]);
    else if (parts[0] === 'club' && parts[1]) viewCleanup = await clubView(Number(parts[1]));
    else if (parts[0] === 'tv' && parts[1]) viewCleanup = await mountTvView(main, Number(parts[1]));
    else if (parts[0] === 'game' && parts[1]) viewCleanup = mountGameView(main, { user, kind: 'server', id: Number(parts[1]), navigate });
    else if (parts[0] === 'local' && parts[1]) viewCleanup = mountGameView(main, { user, kind: 'local', id: parts[1], navigate });
    else if (parts[0] === 'new') await newGameView(params);
    else if (parts[0] === 'puzzles') viewCleanup = await puzzleView(main);
    else if (parts[0] === 'account') navigate(`#/player/${user.id}`);
    else if (parts[0] === 'player' && parts[1]) await profileView(main, Number(parts[1]), params);
    else if (parts[0] === 'lichess' && parts[1]) viewCleanup = mountLichessGame(main, parts[1], { navigate });
    else if (parts[0] === 'tournament' && parts[1]) viewCleanup = await tournamentView(main, Number(parts[1]), { user, navigate });
    else viewCleanup = await homeView();
    // If the user navigated away while this view was loading, tear it down right away.
    if (token !== routeToken) viewCleanup?.();
    else cleanup = viewCleanup;
  } catch (err) {
    if (token !== routeToken) return;
    if (err.status === 401) {
      user = null;
      renderNav();
      navigate('#/login');
      return;
    }
    clear(main, el('div', { class: 'card empty' }, err.message || 'Something went wrong'));
  }
}

async function start() {
  try {
    user = (await api('/me')).user;
  } catch {
    user = null;
  }
  renderNav();
  window.addEventListener('hashchange', route);
  window.addEventListener('hashchange', markActiveTab);
  route();
}

start();
