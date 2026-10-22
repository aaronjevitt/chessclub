// Account pages: choosing a new password from a reset link, and changing your own password.
import { api } from './api.js';
import { el, clear, toast } from './dom.js';
import { field, formData, submitting } from './ui.js';
import { pushSupported, needsHomeScreen, pushEnabled, enablePush, disablePush, sendTestPush } from './push.js';

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

/** Turn "your move" notifications on or off for this device. */
export function notificationsCard() {
  const body = el('div', {});
  const card = el('section', { class: 'card' }, el('h2', {}, 'Notifications'), body);
  const render = async () => {
    if (needsHomeScreen()) {
      clear(body, el('p', { class: 'muted' },
        'On iPhone and iPad, notifications work once Chess Club is on your Home Screen: tap the Share button, ',
        'choose “Add to Home Screen”, open it from there and come back to this page.'));
      return;
    }
    if (!pushSupported()) {
      clear(body, el('p', { class: 'muted' }, 'This browser does not support notifications.'));
      return;
    }
    const on = await pushEnabled().catch(() => false);
    const toggle = el('button', { class: on ? 'btn' : 'btn primary', type: 'button' }, on ? 'Turn off on this device' : 'Turn on for this device');
    toggle.addEventListener('click', async () => {
      toggle.disabled = true;
      toggle.textContent = on ? 'Turning off…' : 'Turning on…';
      try {
        if (on) await disablePush();
        else await enablePush();
        toast(on ? 'Notifications off for this device' : 'Notifications on', 'success');
      } catch (err) {
        toast(err.message, 'error');
      }
      render();
    });
    const test = on ? el('button', {
      class: 'btn', type: 'button',
      onclick: async () => {
        const { sent } = await sendTestPush();
        if (!sent) toast('Nothing was sent — try turning notifications off and on again', 'error');
      },
    }, 'Send a test') : null;
    clear(body,
      el('p', { class: 'muted small' },
        'Get a notification when it’s your move, someone challenges you, accepts your challenge or offers a draw, ',
        'and when a tournament round pairs you — only while you don’t have the game open.'),
      el('div', { class: 'row' }, toggle, test));
  };
  render();
  return card;
}
