// Time controls: presets, labels and the picker used on the setup forms. Times are in seconds.
import { el } from './dom.js';

export const PRESETS = [
  { initial: 60, increment: 0 },
  { initial: 60, increment: 1 },
  { initial: 120, increment: 1 },
  { initial: 180, increment: 0 },
  { initial: 180, increment: 2 },
  { initial: 300, increment: 0 },
  { initial: 300, increment: 3 },
  { initial: 600, increment: 0 },
  { initial: 600, increment: 5 },
  { initial: 900, increment: 10 },
  { initial: 1800, increment: 0 },
  { initial: 1800, increment: 20 },
];

/** Lichess-style speed category from the estimated game duration (40 moves). */
export function speedName(tc) {
  if (!tc) return 'Untimed';
  const estimate = tc.initial + 40 * tc.increment;
  if (estimate < 30) return 'UltraBullet';
  if (estimate < 180) return 'Bullet';
  if (estimate < 480) return 'Blitz';
  if (estimate < 1500) return 'Rapid';
  return 'Classical';
}

/** "3+2", "½+0", "1.5+1" … */
export function tcLabel(tc) {
  if (!tc) return 'Untimed';
  const fractions = { 15: '¼', 30: '½', 45: '¾' };
  const minutes = fractions[tc.initial] ?? (tc.initial % 60 === 0 ? tc.initial / 60 : +(tc.initial / 60).toFixed(1));
  return `${minutes}+${tc.increment}`;
}

export function tcDescription(tc) {
  return tc ? `${tcLabel(tc)} ${speedName(tc)}` : 'Untimed';
}

/** Clock text: h:mm:ss for long times, m:ss normally, and tenths in the last 10 seconds. */
export function formatClock(ms) {
  const clamped = Math.max(0, ms);
  if (clamped < 10000) return `0:0${(Math.floor(clamped / 100) / 10).toFixed(1)}`;
  const total = Math.ceil(clamped / 1000);
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = String(total % 60).padStart(2, '0');
  return h ? `${h}:${String(m).padStart(2, '0')}:${s}` : `${m}:${s}`;
}

/** A <select> of presets plus "Custom", with minute/increment inputs. read() → {initial, increment} | null. */
export function timeControlPicker({ defaultValue = '' } = {}) {
  const groups = {};
  for (const tc of PRESETS) (groups[speedName(tc)] ||= []).push(tc);
  const select = el('select', { 'aria-label': 'Time control' },
    el('option', { value: '' }, 'Untimed'),
    Object.entries(groups).map(([name, list]) => el('optgroup', { label: name },
      list.map((tc) => el('option', { value: `${tc.initial}+${tc.increment}`, selected: `${tc.initial}+${tc.increment}` === defaultValue }, `${tcLabel(tc)}  ${name}`)))),
    el('option', { value: 'custom' }, 'Custom…'));
  const minutes = el('input', { type: 'number', min: '0.25', max: '180', step: '0.25', value: '5', 'aria-label': 'Minutes per side' });
  const increment = el('input', { type: 'number', min: '0', max: '180', step: '1', value: '3', 'aria-label': 'Increment in seconds' });
  const custom = el('div', { class: 'row custom-tc', hidden: true },
    minutes, el('span', { class: 'muted small' }, 'min +'), increment, el('span', { class: 'muted small' }, 'sec / move'));
  select.addEventListener('change', () => { custom.hidden = select.value !== 'custom'; });
  return {
    el: el('div', { class: 'stack tc-picker' }, select, custom),
    read() {
      if (!select.value) return null;
      if (select.value === 'custom') {
        const initial = Math.round(Number(minutes.value) * 60);
        const inc = Math.round(Number(increment.value));
        if (!(initial >= 15 && initial <= 10800)) throw new Error('Time per side must be between 0.25 and 180 minutes');
        if (!(inc >= 0 && inc <= 180)) throw new Error('Increment must be between 0 and 180 seconds');
        return { initial, increment: inc };
      }
      const [initial, inc] = select.value.split('+').map(Number);
      return { initial, increment: inc };
    },
  };
}
