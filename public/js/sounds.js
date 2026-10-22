// Game sounds, synthesised with the Web Audio API (no audio files). Off/on is remembered per device.
const KEY = 'chessclub:sound';
let ctx = null;

export function soundEnabled() {
  try {
    return localStorage.getItem(KEY) !== 'off';
  } catch {
    return true;
  }
}

export function setSoundEnabled(on) {
  try {
    localStorage.setItem(KEY, on ? 'on' : 'off');
  } catch {
    // storage blocked: the setting lasts for this page only
  }
}

function audio() {
  if (!soundEnabled()) return null;
  ctx ||= new (window.AudioContext || window.webkitAudioContext)();
  if (ctx.state === 'suspended') ctx.resume().catch(() => {});
  return ctx;
}

// Browsers only allow audio after a user gesture; unlock on the first tap or key press.
for (const type of ['pointerdown', 'keydown']) {
  window.addEventListener(type, () => {
    if (soundEnabled() && (!ctx || ctx.state === 'suspended')) audio();
  }, { once: true, capture: true });
}

/** A short filtered noise burst — the "clack" of a piece being set down. */
function knock(c, { at = 0, freq = 1800, gain = 0.5, length = 0.06 } = {}) {
  const start = c.currentTime + at;
  const buffer = c.createBuffer(1, Math.ceil(c.sampleRate * length), c.sampleRate);
  const data = buffer.getChannelData(0);
  for (let i = 0; i < data.length; i++) data[i] = (Math.random() * 2 - 1) * (1 - i / data.length) ** 3;
  const src = c.createBufferSource();
  src.buffer = buffer;
  const filter = c.createBiquadFilter();
  filter.type = 'bandpass';
  filter.frequency.value = freq;
  filter.Q.value = 1.2;
  const amp = c.createGain();
  amp.gain.value = gain;
  src.connect(filter).connect(amp).connect(c.destination);
  src.start(start);
}

function tone(c, { at = 0, freq = 660, length = 0.15, gain = 0.12, type = 'sine' } = {}) {
  const start = c.currentTime + at;
  const osc = c.createOscillator();
  osc.type = type;
  osc.frequency.value = freq;
  const amp = c.createGain();
  amp.gain.setValueAtTime(0, start);
  amp.gain.linearRampToValueAtTime(gain, start + 0.01);
  amp.gain.exponentialRampToValueAtTime(0.0001, start + length);
  osc.connect(amp).connect(c.destination);
  osc.start(start);
  osc.stop(start + length + 0.02);
}

export const sounds = {
  move() {
    const c = audio();
    if (c) knock(c);
  },
  capture() {
    const c = audio();
    if (!c) return;
    knock(c, { freq: 1200, gain: 0.7, length: 0.08 });
    knock(c, { at: 0.05, freq: 900, gain: 0.4 });
  },
  check() {
    const c = audio();
    if (!c) return;
    knock(c);
    tone(c, { at: 0.03, freq: 880, length: 0.18, gain: 0.08, type: 'triangle' });
  },
  gameEnd() {
    const c = audio();
    if (!c) return;
    [523, 659, 784].forEach((freq, i) => tone(c, { at: i * 0.09, freq, length: 0.5, gain: 0.09 }));
  },
  lowTime() {
    const c = audio();
    if (!c) return;
    tone(c, { freq: 990, length: 0.12, gain: 0.1, type: 'square' });
    tone(c, { at: 0.18, freq: 990, length: 0.12, gain: 0.1, type: 'square' });
  },
  notify() {
    const c = audio();
    if (!c) return;
    tone(c, { freq: 740, length: 0.2, gain: 0.1 });
    tone(c, { at: 0.15, freq: 988, length: 0.3, gain: 0.1 });
  },
};

/** The right sound for a move given its SAN. */
export function soundForMove(san) {
  if (san.includes('#') || san.includes('+')) return sounds.check;
  if (san.includes('x')) return sounds.capture;
  return sounds.move;
}
