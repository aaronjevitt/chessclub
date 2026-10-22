// Account pages: choosing a new password from a reset link, and changing your own password.
import { api } from './api.js';
import { el, clear, toast } from './dom.js';
import { field, formData, submitting } from './ui.js';

/** #/reset/<token>: works whether or not you're logged in; logs you in with the new password. */
export async function resetView(main, token, onLoggedIn) {
  let username;
  try {
    ({ username } = await api(`/reset/${encodeURIComponent(token)}`));
  } catch (err) {
    clear(main, el('div', { class: 'auth-wrap' }, el('div', { class: 'card auth-card' },
      el('h1', {}, 'Reset link not valid'), el('p', { class: 'muted' }, err.message), el('a', { href: '#/login' }, 'Go to log in'))));
    return;
  }
  const form = el('form', { class: 'card auth-card' },
    el('h1', {}, 'Choose a new password'),
    el('p', { class: 'muted' }, 'For ', el('strong', {}, username), '. This signs the account out on every other device.'),
    field('New password', el('input', { name: 'password', type: 'password', required: true, minlength: 6, autocomplete: 'new-password' })),
    field('Repeat it', el('input', { name: 'repeat', type: 'password', required: true, minlength: 6, autocomplete: 'new-password' })),
    el('button', { type: 'submit', class: 'btn primary block' }, 'Set password and log in'));
  form.addEventListener('submit', (e) => {
    e.preventDefault();
    submitting(form, async () => {
      const d = formData(form);
      if (d.password !== d.repeat) throw new Error("The passwords don't match");
      const { user } = await api(`/reset/${encodeURIComponent(token)}`, { method: 'POST', body: { password: d.password } });
      toast('Password changed');
      onLoggedIn(user);
    });
  });
  clear(main, el('div', { class: 'auth-wrap' }, form));
}

/** Change-password form (shown on your own profile page). */
export function changePasswordForm() {
  const form = el('form', { class: 'stack' },
    field('Current password', el('input', { name: 'current', type: 'password', required: true, autocomplete: 'current-password' })),
    field('New password', el('input', { name: 'password', type: 'password', required: true, minlength: 6, autocomplete: 'new-password' })),
    field('Repeat new password', el('input', { name: 'repeat', type: 'password', required: true, minlength: 6, autocomplete: 'new-password' })),
    el('button', { type: 'submit', class: 'btn primary' }, 'Change password'),
    el('p', { class: 'muted small' }, 'Other devices are signed out; this one stays signed in.'));
  form.addEventListener('submit', (e) => {
    e.preventDefault();
    submitting(form, async () => {
      const d = formData(form);
      if (d.password !== d.repeat) throw new Error("The new passwords don't match");
      await api('/me/password', { method: 'POST', body: { current: d.current, password: d.password } });
      form.reset();
      toast('Password changed');
    });
  });
  return form;
}
