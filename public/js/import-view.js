// Import games from PGN (another site's export, or a scoresheet typed up) to review them here.
import { api } from './api.js';
import { el, toast } from './dom.js';
import { field, formData, submitting } from './ui.js';

export function importCard(clubs, { preClub, navigate }) {
  const file = el('input', { type: 'file', accept: '.pgn,text/plain,application/x-chess-pgn' });
  const text = el('textarea', { name: 'pgn', rows: 7, spellcheck: 'false', placeholder: '[White "You"]\n[Black "Opponent"]\n\n1. e4 e5 2. Nf3 Nc6 …' });
  file.addEventListener('change', async () => {
    const f = file.files[0];
    if (!f) return;
    if (f.size > 2_000_000) return toast('That file is too large', 'error');
    text.value = await f.text();
  });
  const form = el('form', { class: 'stack' },
    el('p', { class: 'muted small' }, 'Paste a PGN from chess.com, lichess or a scoresheet to review it here; its mistakes also become puzzles. Up to 50 games at once.'),
    field('PGN', text),
    field('…or choose a file', file),
    field('You played', el('select', { name: 'playerColor' },
      el('option', { value: 'auto' }, 'Detect from the player names'),
      el('option', { value: 'white' }, 'White'),
      el('option', { value: 'black' }, 'Black'),
      el('option', { value: 'none' }, "Neither — someone else's game"))),
    field('Club', el('select', { name: 'club' }, clubs.map((c) => el('option', { value: c.id, selected: String(c.id) === preClub }, c.name)))),
    el('label', { class: 'check' }, el('input', { type: 'checkbox', name: 'share' }), ' Share with the club (otherwise only you can see it)'),
    el('button', { type: 'submit', class: 'btn primary' }, 'Import'));
  form.addEventListener('submit', (e) => {
    e.preventDefault();
    submitting(form, async () => {
      const d = formData(form);
      const { games } = await api(`/clubs/${d.club}/import`, {
        method: 'POST',
        body: { pgn: text.value, playerColor: d.playerColor, visibility: d.share ? 'club' : 'private' },
      });
      if (games.length === 1) return navigate(`#/game/${games[0].id}`);
      toast(`Imported ${games.length} games`, 'success');
      navigate(`#/player/${games[0].createdBy}`);
    });
  });
  return el('details', { class: 'card import-pgn' }, el('summary', {}, 'Import games from PGN'), form);
}
