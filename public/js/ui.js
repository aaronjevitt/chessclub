// Form helpers shared by the views.
import { el, toast } from './dom.js';

export function field(label, input, hint) {
  return el('label', { class: 'field' }, el('span', { class: 'field-label' }, label), input, hint ? el('span', { class: 'hint' }, hint) : null);
}

export function formData(form) {
  return Object.fromEntries(new FormData(form).entries());
}

/** Run a form submission with its submit button disabled, showing any error as a toast. */
export async function submitting(form, fn) {
  const btn = form.querySelector('button[type=submit]');
  if (btn) btn.disabled = true;
  try {
    await fn();
  } catch (err) {
    toast(err.message, 'error');
  } finally {
    if (btn) btn.disabled = false;
  }
}

/** Copy text, falling back to selecting it in a prompt. */
export async function copyText(text) {
  try {
    await navigator.clipboard.writeText(text);
    toast('Copied to clipboard');
  } catch {
    window.prompt('Copy this:', text);
  }
}
