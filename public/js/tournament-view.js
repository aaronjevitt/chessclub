// Tournaments: list/create on the club page, the tournament page, and the projector panel.
import { api, getSocket } from './api.js';
import { el, clear, toast } from './dom.js';
import { icon } from './icons.js';
import { field, formData, submitting } from './ui.js';
import { timeControlPicker, tcDescription } from './time-control.js';

const FORMAT = { swiss: 'Swiss', roundrobin: 'Round robin' };
const PLAY = { otb: 'Over the board', online: 'Online' };
const STATUS = { registration: 'Open for entries', running: 'In progress', finished: 'Finished' };
const RESULT_TEXT = { '1-0': '1 – 0', '0-1': '0 – 1', '1/2-1/2': '½ – ½' };

function describe(t) {
  const parts = [FORMAT[t.format], PLAY[t.play]];
  if (t.play === 'online' && t.timeControl) parts.push(tcDescription(t.timeControl));
  if (t.rounds) parts.push(`${t.rounds} rounds`);
  return parts.join(' · ');
}

// ---------- club page card ----------

export function clubTournamentsCard(club, { navigate }) {
  const list = el('div', { class: 'list' });
  const tc = timeControlPicker({ defaultValue: '600+5' });
  const form = el('form', { class: 'stack create-tournament' },
    field('Name', el('input', { name: 'name', required: true, minlength: 2, maxlength: 80, placeholder: 'e.g. November Blitz' })),
    el('div', { class: 'row' },
      field('Format', el('select', { name: 'format' }, el('option', { value: 'swiss' }, 'Swiss'), el('option', { value: 'roundrobin' }, 'Round robin (everyone plays everyone)'))),
      field('Rounds', el('input', { name: 'rounds', type: 'number', min: 1, max: 15, value: 4 }), 'Swiss only')),
    field('Played', el('select', { name: 'play' },
      el('option', { value: 'otb' }, 'Over the board — players report results'),
      el('option', { value: 'online' }, 'Online — games are created automatically'))),
    el('div', { class: 'tc-online' }, field('Time control', tc.el)),
    el('label', { class: 'check' }, el('input', { type: 'checkbox', name: 'rated', checked: true }), ' Rated (counts towards club ratings)'),
    el('button', { type: 'submit', class: 'btn primary' }, 'Create tournament'));
  const sync = () => {
    form.querySelector('.tc-online').hidden = form.elements.play.value !== 'online';
    form.elements.rounds.disabled = form.elements.format.value !== 'swiss';
  };
  form.addEventListener('change', sync);
  sync();
  form.addEventListener('submit', (e) => {
    e.preventDefault();
    submitting(form, async () => {
      const d = formData(form);
      const body = { name: d.name, format: d.format, rounds: Number(d.rounds), play: d.play, rated: d.rated === 'on' };
      if (d.play === 'online') body.timeControl = tc.read() || { initial: 600, increment: 5 };
      const { tournament } = await api(`/clubs/${club.id}/tournaments`, { method: 'POST', body });
      navigate(`#/tournament/${tournament.id}`);
    });
  });

  async function load() {
    let tournaments;
    try {
      ({ tournaments } = await api(`/clubs/${club.id}/tournaments`));
    } catch {
      return;
    }
    clear(list, tournaments.length
      ? tournaments.map((t) => el('a', { href: `#/tournament/${t.id}`, class: 'list-item tournament-item' },
        el('div', {}, el('strong', {}, t.name), el('div', { class: 'muted small' }, describe(t))),
        el('div', { class: 'right small' },
          el('span', { class: `badge t-${t.status}` }, t.status === 'running' ? `Round ${t.currentRound}/${t.rounds}` : STATUS[t.status]),
          el('div', { class: 'muted' }, `${t.players} player${t.players === 1 ? '' : 's'}`))))
      : el('p', { class: 'muted small' }, 'No tournaments yet.'));
  }

  const card = el('section', { class: 'club-tournaments' },
    el('h2', {}, 'Tournaments'), list,
    el('details', { class: 'create-details card' }, el('summary', {}, 'New tournament'), form));
  return { el: card, load };
}

// ---------- tournament page ----------

export async function tournamentView(main, id, { user, navigate }) {
  const socket = getSocket();
  let data = await api(`/tournaments/${id}`);
  let shownRound = null;
  const root = el('div', { class: 'tournament' });
  clear(main, root);

  const act = (fn) => async () => {
    try {
      data = await fn();
      render();
    } catch (err) {
      toast(err.message, 'error');
    }
  };
  const post = (path, body) => api(`/tournaments/${id}${path}`, { method: 'POST', body });

  function resultButtons(p, allowed) {
    if (!allowed) return null;
    return el('div', { class: 'result-pick' }, ['1-0', '1/2-1/2', '0-1'].map((r) => el('button', {
      type: 'button',
      class: `btn small ${p.result === r ? 'primary' : ''}`,
      onclick: act(() => post(`/pairings/${p.id}/result`, { result: r })),
    }, RESULT_TEXT[r])));
  }

  function pairingRow(p) {
    const t = data.tournament;
    const mine = p.white.id === user.id || p.black?.id === user.id;
    if (!p.black) {
      return el('tr', { class: mine ? 'mine' : '' }, el('td', { class: 'muted' }, p.board),
        el('td', {}, p.white.name), el('td', { class: 'center' }, 'bye'), el('td', { class: 'muted' }, '+1'), el('td'));
    }
    // Players report their own result from the box at the top; the organiser can set any result here.
    const canReport = t.play === 'otb' && data.canManage;
    return el('tr', { class: mine ? 'mine' : '' },
      el('td', { class: 'muted' }, p.board),
      el('td', {}, el('a', { href: `#/player/${p.white.id}` }, p.white.name)),
      el('td', { class: 'center result-cell' }, p.result ? RESULT_TEXT[p.result] : el('span', { class: 'muted' }, '–')),
      el('td', {}, el('a', { href: `#/player/${p.black.id}` }, p.black.name)),
      el('td', { class: 'right' },
        p.gameId ? el('a', { href: `#/game/${p.gameId}`, class: 'btn small' }, p.result ? 'View' : mine ? 'Play' : 'Watch') : null,
        canReport ? resultButtons(p, true) : null));
  }

  function myGameCard() {
    const t = data.tournament;
    if (t.status !== 'running') return null;
    const p = data.pairings.find((x) => x.round === t.currentRound && (x.white.id === user.id || x.black?.id === user.id));
    if (!p) return null;
    if (!p.black) return el('div', { class: 'my-game card' }, `Round ${t.currentRound}: you have a bye (+1 point).`);
    const white = p.white.id === user.id;
    const opponent = white ? p.black : p.white;
    return el('div', { class: 'my-game card' },
      el('div', {}, `Round ${t.currentRound}, board ${p.board}: you play `, el('strong', {}, white ? 'White' : 'Black'), ' against ', el('strong', {}, opponent.name), '.'),
      p.result ? el('div', { class: 'muted' }, `Result: ${RESULT_TEXT[p.result]}`)
        : t.play === 'online' ? el('a', { href: `#/game/${p.gameId}`, class: 'btn primary' }, 'Play your game')
          : data.canManage ? el('div', { class: 'muted small' }, 'Enter the result in the table below.')
            : el('div', {}, el('div', { class: 'muted small' }, 'When you finish, report the result:'), resultButtons(p, true)));
  }

  function render() {
    const t = data.tournament;
    const rounds = [...new Set(data.pairings.map((p) => p.round))];
    if (shownRound === null || !rounds.includes(shownRound)) shownRound = t.currentRound || rounds.at(-1) || null;
    const others = data.players.filter((p) => !p.withdrawn);
    clear(root,
      el('section', { class: 'card tournament-header' },
        el('div', {},
          el('a', { href: `#/club/${t.clubId}`, class: 'club-link small' }, icon('back', { size: 15 }), t.clubName || 'Club'),
          el('h1', {}, t.name),
          el('div', { class: 'muted small' }, `${describe(t)} · ${t.rated ? 'Rated' : 'Unrated'} · organised by ${t.organiser}`)),
        el('div', { class: 'row' },
          el('span', { class: `badge t-${t.status}` }, t.status === 'running' ? `Round ${t.currentRound} of ${t.rounds}` : STATUS[t.status]),
          t.status === 'registration' && !data.joined ? el('button', { type: 'button', class: 'btn primary', onclick: act(() => post('/join')) }, 'Join') : null,
          t.status === 'registration' && data.joined ? el('button', { type: 'button', class: 'btn', onclick: act(() => post('/leave')) }, 'Leave') : null,
          t.status === 'running' && data.joined ? el('button', {
            type: 'button',
            class: 'btn ghost',
            onclick: () => confirm('Withdraw from the tournament? Your results so far still count.') && act(() => post('/leave'))(),
          }, 'Withdraw') : null)),
      myGameCard(),
      data.canManage ? organiserPanel() : null,
      t.status === 'registration'
        ? el('section', { class: 'card' }, el('h2', {}, `Players (${others.length})`),
          others.length ? el('ol', { class: 'player-list' }, others.map((p) => el('li', {},
            el('a', { href: `#/player/${p.id}` }, p.username), el('span', { class: 'muted small' }, ` ${p.rating}`),
            data.canManage ? el('button', { type: 'button', class: 'btn small ghost', title: `Remove ${p.username}`, 'aria-label': `Remove ${p.username}`, onclick: act(() => api(`/tournaments/${id}/players/${p.id}`, { method: 'DELETE' })) }, icon('close', { size: 15 })) : null)))
            : el('p', { class: 'muted' }, 'No players yet.'))
        : el('div', { class: 'tournament-body' },
          el('section', { class: 'card' },
            el('div', { class: 'round-tabs' }, rounds.map((r) => el('button', {
              type: 'button', class: `btn small ${r === shownRound ? 'primary' : 'ghost'}`, onclick: () => { shownRound = r; render(); },
            }, `Round ${r}`))),
            el('div', { class: 'table-scroll' }, el('table', { class: 'pairings' },
              el('thead', {}, el('tr', {}, el('th', {}, '#'), el('th', {}, 'White'), el('th', { class: 'center' }, 'Result'), el('th', {}, 'Black'), el('th'))),
              el('tbody', {}, data.pairings.filter((p) => p.round === shownRound).map(pairingRow))))),
          el('section', { class: 'card' }, el('h2', {}, 'Standings'), el('div', { class: 'table-scroll' }, standingsTable(data.standings, user.id)))));
  }

  function organiserPanel() {
    const t = data.tournament;
    if (t.status === 'finished') return null;
    const notJoined = (data.members || []).filter((m) => !data.players.some((p) => p.id === m.id && !p.withdrawn));
    const select = el('select', { 'aria-label': 'Member to add' }, notJoined.map((m) => el('option', { value: m.id }, m.username)));
    return el('section', { class: 'card organiser' },
      el('strong', {}, 'Organiser'),
      t.status === 'registration' ? [
        notJoined.length ? el('div', { class: 'row' }, select,
          el('button', { type: 'button', class: 'btn small', onclick: () => act(() => post('/players', { userId: Number(select.value) }))() }, 'Add player')) : null,
        el('div', { class: 'row' },
          el('button', { type: 'button', class: 'btn primary', onclick: () => confirm('Start the tournament? Entries close and round 1 is paired.') && act(() => post('/start'))() }, 'Start tournament'),
          el('button', {
            type: 'button',
            class: 'btn ghost danger-text',
            onclick: async () => {
              if (!confirm('Delete this tournament?')) return;
              try {
                await api(`/tournaments/${id}`, { method: 'DELETE' });
                navigate(`#/club/${t.clubId}`);
              } catch (err) {
                toast(err.message, 'error');
              }
            },
          }, 'Delete')),
      ] : el('div', { class: 'row' },
        el('span', { class: 'muted small' }, t.play === 'otb' ? 'You can enter or correct any result below.' : 'Results come from the games; you can still correct them below.'),
        el('button', { type: 'button', class: 'btn ghost', onclick: () => confirm('End the tournament now?') && act(() => post('/finish'))() }, 'End tournament')));
  }

  try {
    data.members = (await api(`/clubs/${data.tournament.clubId}`)).members;
  } catch {
    data.members = [];
  }
  render();

  const reload = async ({ tournamentId }) => {
    if (tournamentId !== Number(id)) return;
    try {
      const members = data.members;
      data = await api(`/tournaments/${id}`);
      data.members = members;
      render();
    } catch {
      // ignore transient errors; the next change will retry
    }
  };
  const watch = () => socket.emit('watch:club', data.tournament.clubId);
  socket.on('tournament:changed', reload);
  socket.on('connect', watch);
  if (socket.connected) watch();
  return () => {
    socket.off('tournament:changed', reload);
    socket.off('connect', watch);
  };
}

export function standingsTable(rows, me = null, { limit = Infinity } = {}) {
  return el('table', { class: 'standings' },
    el('thead', {}, el('tr', {}, el('th', {}, '#'), el('th', {}, 'Player'), el('th', { class: 'right' }, 'Pts'),
      el('th', { class: 'right', title: "Buchholz: sum of opponents' points" }, 'Buch.'), el('th', { class: 'right' }, 'W–D–L'))),
    el('tbody', {}, rows.slice(0, limit).map((r) => el('tr', { class: `${r.id === me ? 'mine' : ''} ${r.withdrawn ? 'withdrawn' : ''}` },
      el('td', { class: 'muted' }, r.rank),
      el('td', {}, el('a', { href: `#/player/${r.id}` }, r.username), r.withdrawn ? el('span', { class: 'muted small' }, ' (withdrawn)') : null),
      el('td', { class: 'right strong' }, String(r.points)),
      el('td', { class: 'right muted' }, String(r.buchholz)),
      el('td', { class: 'right muted' }, `${r.wins}–${r.draws}–${r.losses}`)))));
}

// ---------- projector panel ----------

/** Current round and top standings of a running tournament, for the projector's side panel. */
export function tournamentPanel(data) {
  const t = data.tournament;
  const current = data.pairings.filter((p) => p.round === t.currentRound);
  return el('div', { class: 'tv-tournament' },
    el('div', { class: 'tv-t-title' }, t.name),
    el('div', { class: 'muted' }, `Round ${t.currentRound} of ${t.rounds} · ${describe(t)}`),
    el('table', { class: 'tv-t-pairings' }, el('tbody', {}, current.map((p) => el('tr', {},
      el('td', { class: 'muted' }, p.board),
      el('td', {}, p.white.name),
      el('td', { class: 'center' }, p.black ? (p.result ? RESULT_TEXT[p.result] : 'vs') : 'bye'),
      el('td', {}, p.black ? p.black.name : ''))))),
    el('div', { class: 'tv-t-sub' }, 'Standings'),
    standingsTable(data.standings, null, { limit: 8 }));
}
