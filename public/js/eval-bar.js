// Evaluation bar: a vertical White/Black bar fed by the in-browser engine.
import { el, clear } from './dom.js';

/** Runs evaluations one at a time in a dedicated worker, caching results by position. */
export class Evaluator {
  constructor({ timeMs = 800 } = {}) {
    this.timeMs = timeMs;
    this.cache = new Map();
    this.queue = [];
    this.busy = false;
    this.nextId = 0;
    this.worker = null;
  }

  /** Resolves with { cp, mate } for the position after `moves`; `key` lets a newer request replace a queued older one. */
  evaluate(key, startFen, moves) {
    const cacheKey = `${startFen}|${moves.join(' ')}`;
    if (this.cache.has(cacheKey)) return Promise.resolve(this.cache.get(cacheKey));
    return new Promise((resolve) => {
      // Only the latest request per key matters (e.g. a board that has moved on since).
      this.queue = this.queue.filter((job) => {
        if (job.key !== key) return true;
        job.resolve(null);
        return false;
      });
      this.queue.push({ key, cacheKey, startFen, moves, resolve });
      this._pump();
    });
  }

  _pump() {
    if (this.busy || !this.queue.length) return;
    const job = this.queue.shift();
    this.busy = true;
    if (!this.worker) this.worker = new Worker(new URL('./engine-worker.js', import.meta.url), { type: 'module' });
    const id = ++this.nextId;
    this.worker.onmessage = ({ data }) => {
      if (data.id !== id) return;
      this.busy = false;
      const result = data.error ? null : { cp: data.cp, mate: data.mate };
      if (result) this.cache.set(job.cacheKey, result);
      job.resolve(result);
      this._pump();
    };
    this.worker.postMessage({ id, type: 'eval', startFen: job.startFen, moves: job.moves, timeMs: this.timeMs });
  }

  destroy() {
    this.worker?.terminate();
    this.worker = null;
    for (const job of this.queue) job.resolve(null);
    this.queue = [];
  }
}

/** White's share of the bar (0-100) for an evaluation. */
function whitePercent(result) {
  if (result.mate !== null && result.mate !== undefined) {
    if (result.mate === 0) return result.cp > 0 ? 100 : 0;
    return result.mate > 0 ? 100 : 0;
  }
  const cp = Math.max(-2000, Math.min(2000, result.cp));
  return 50 + 50 * (2 / (1 + Math.exp(-0.004 * cp)) - 1);
}

function label(result) {
  if (result.mate !== null && result.mate !== undefined) {
    if (result.mate === 0) return result.cp > 0 ? '1-0' : '0-1';
    return `M${Math.abs(result.mate)}`;
  }
  const pawns = result.cp / 100;
  return `${pawns > 0 ? '+' : ''}${pawns.toFixed(1)}`;
}

export function createEvalBar() {
  const white = el('div', { class: 'eval-white' });
  const text = el('span', { class: 'eval-label' });
  const bar = el('div', { class: 'eval-bar', title: 'Engine evaluation' }, white, text);
  let orientation = 'white';
  return {
    el: bar,
    setOrientation(o) {
      orientation = o;
      bar.classList.toggle('flipped', o === 'black');
    },
    /** result null = evaluating */
    set(result) {
      bar.classList.toggle('pending', !result);
      if (!result) return;
      const pct = whitePercent(result);
      white.style.height = `${pct}%`;
      const whiteAhead = pct >= 50;
      clear(text, label(result));
      // Put the number at the end of the bar belonging to the side that is ahead.
      const atBottom = whiteAhead === (orientation === 'white');
      text.classList.toggle('bottom', atBottom);
      text.classList.toggle('top', !atBottom);
      text.classList.toggle('on-white', whiteAhead);
    },
  };
}
