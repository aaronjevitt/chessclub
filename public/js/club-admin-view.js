// Club owner tools on the club page: settings card, new invite code, per-member actions.
import { api } from './api.js';
import { el, clear, toast } from './dom.js';
import { field, formData, submitting, copyText } from './ui.js';

/** Card for the owner: rename, describe, public/private, new invite code. */
export function clubSettingsCard(club, onChanged) {
  const codeEl = el('code', { class: 'invite' }, club.inviteCode);
  const form = el('form', { class: 'stack' },
    field('Club name', el('input', { name: 'name', value: club.name, required: true, minlength: 2, maxlength: 60 })),
    field('Description', el('textarea', { name: 'description', rows: 2, maxlength: 500 }, club.description || '')),
    el('label', { class: 'check' }, el('input', { type: 'checkbox', name: 'isPublic', checked: club.isPublic }), ' Public (anyone can find and join)'),
    el('button', { type: 'submit', class: 'btn primary' }, 'Save'));
  form.addEventListener('submit', (e) => {
    e.preventDefault();
    submitting(form, async () => {
      const d = formData(form);
      await api(`/clubs/${club.id}`, { method: 'PATCH', body: { name: d.name, description: d.description, isPublic: d.isPublic === 'on' } });
      toast('Club updated');
      onChanged();
    });
  });
  return el('details', { class: 'card club-settings' },
    el('summary', {}, '⚙ Club settings'),
    form,
    el('div', { class: 'row invite-row' },
      el('span', { class: 'muted small' }, 'Invite code'), codeEl,
      el('button', { type: 'button', class: 'btn small ghost', onclick: () => copyText(codeEl.textContent) }, 'Copy'),
      el('button', {
        type: 'button',
        class: 'btn small',
        onclick: async () => {
          if (!confirm('Make a new invite code? The current one will stop working.')) return;
          try {
            const { inviteCode } = await api(`/clubs/${club.id}/invite-code`, { method: 'POST' });
            codeEl.textContent = inviteCode;
            toast('New invite code created');
            onChanged();
          } catch (err) {
            toast(err.message, 'error');
          }
        },
      }, 'New code')));
}

/** Owner-only buttons on a member row: one-time password reset link, remove from club. */
export function memberAdminActions(club, member, { onRemoved, panel }) {
  const resetLink = async () => {
    try {
      const { path, expiresAt } = await api(`/clubs/${club.id}/members/${member.id}/reset-link`, { method: 'POST' });
      const url = `${location.origin}${path}`;
      clear(panel, el('div', { class: 'reset-link' },
        el('div', { class: 'small' }, `Password reset link for `, el('strong', {}, member.username),
          ` — send it to them privately. Works once, until ${new Date(expiresAt).toLocaleString()}.`),
        el('div', { class: 'row' },
          el('input', { value: url, readonly: true, onfocus: (e) => e.target.select(), 'aria-label': 'Reset link' }),
          el('button', { type: 'button', class: 'btn small primary', onclick: () => copyText(url) }, 'Copy'),
          el('button', { type: 'button', class: 'btn small ghost', onclick: () => clear(panel) }, '✕'))));
    } catch (err) {
      toast(err.message, 'error');
    }
  };
  const remove = async () => {
    if (!confirm(`Remove ${member.username} from ${club.name}? Their open challenges here are cancelled.`)) return;
    try {
      await api(`/clubs/${club.id}/members/${member.id}`, { method: 'DELETE' });
      toast(`${member.username} removed`);
      onRemoved();
    } catch (err) {
      toast(err.message, 'error');
    }
  };
  const menu = el('details', { class: 'member-menu' },
    el('summary', { class: 'btn small ghost', title: 'Manage member', 'aria-label': `Manage ${member.username}` }, '⋯'),
    el('div', { class: 'menu-items' },
      el('button', { type: 'button', class: 'btn small ghost', title: 'Create a one-time password reset link', onclick: () => { menu.open = false; resetLink(); } }, 'Reset password'),
      el('button', { type: 'button', class: 'btn small ghost danger-text', onclick: () => { menu.open = false; remove(); } }, 'Remove from club')));
  return menu;
}
