// Game review UI pieces: summary card, evaluation graph, label icons and move explanations.
import { el } from './dom.js';
import { LABELS } from './review.js';

let bookPromise = null;

/** The opening book (public/data/openings.json), loaded once on first use. */
export function loadOpeningBook() {
  bookPromise ||= fetch('/data/openings.json').then((r) => (r.ok ? r.json() : {})).catch(() => ({}));
  return bookPromise;
}

export function labelIcon(label, { small = false } = {}) {
  const info = LABELS[label];
  return el('span', { class: `label-icon ${small ? 'small' : ''}`, style: `background:${info.color}`, title: info.name }, info.symbol);
}

function formatScore({ cp, mate }) {
  if (mate !== null && mate !== undefined) return mate === 0 ? '' : `M${Math.abs(mate)}`;
  return `${cp > 0 ? '+' : ''}${(cp / 100).toFixed(1)}`;
}

const PHRASES = {
  book: 'is a book move',
  brilliant: 'is brilliant!',
  great: 'is a great move — the only good one here',
  best: 'is the best move',
  excellent: 'is excellent',
  good: 'is good',
  inaccuracy: 'is an inaccuracy',
  mistake: 'is a mistake',
  miss: 'is a miss — there was a chance to punish the last move',
  blunder: 'is a blunder',
};

/** One-line description of a reviewed move, e.g. "Qh5 is a mistake. Best was Nf3 (+1.2)." */
export function explainMove(move, positions) {
  let text = `${move.san} ${PHRASES[move.label]}.`;
  if (move.bestSan && !['book', 'best', 'brilliant', 'great'].includes(move.label)) {
    const p = positions[move.ply - 1];
    const score = formatScore({ cp: p.cp, mate: p.mate });
    text += ` Best was ${move.bestSan}${score ? ` (${score})` : ''}.`;
  }
  return text;
}

/** Accuracy and label counts for both players. */
export function renderSummary(review, state) {
  const shown = ['brilliant', 'great', 'best', 'excellent', 'good', 'book', 'inaccuracy', 'mistake', 'miss', 'blunder'];
  const acc = (v) => (v === null ? '—' : v.toFixed(1));
  return el('div', { class: 'review-summary' },
    review.opening ? el('div', { class: 'review-opening' }, el('span', { class: 'muted small' }, review.opening.eco), ` ${review.opening.name}`) : null,
    el('div', { class: 'review-table' },
      el('div', {}), el('div', { class: 'review-player' }, state.white.name || 'White'), el('div', { class: 'review-player' }, state.black.name || 'Black'),
      el('div', { class: 'muted small' }, 'Accuracy'),
      el('div', { class: 'review-accuracy white' }, acc(review.accuracy.w)),
      el('div', { class: 'review-accuracy black' }, acc(review.accuracy.b)),
      shown.flatMap((key) => [
        el('div', { class: 'review-label-name' }, labelIcon(key, { small: true }), LABELS[key].name),
        el('div', { class: 'review-count', style: review.counts.w[key] ? `color:${LABELS[key].color}` : '' }, String(review.counts.w[key])),
        el('div', { class: 'review-count', style: review.counts.b[key] ? `color:${LABELS[key].color}` : '' }, String(review.counts.b[key])),
      ])));
}

/** Evaluation graph (White's winning chances); click to jump to a move. */
export function renderGraph(review, currentPly, onSelect) {
  const NS = 'http://www.w3.org/2000/svg';
  const wins = review.whiteWins;
  const n = Math.max(1, wins.length - 1);
  const W = 400;
  const H = 90;
  const x = (i) => (i / n) * W;
  const y = (w) => H - (w / 100) * H;
  const svg = document.createElementNS(NS, 'svg');
  svg.setAttribute('viewBox', `0 0 ${W} ${H}`);
  svg.setAttribute('preserveAspectRatio', 'none');
  svg.setAttribute('class', 'review-graph');
  const add = (tag, attrs) => {
    const node = document.createElementNS(NS, tag);
    for (const [k, v] of Object.entries(attrs)) node.setAttribute(k, v);
    svg.appendChild(node);
    return node;
  };
  add('rect', { x: 0, y: 0, width: W, height: H, class: 'graph-black' });
  const points = wins.map((w, i) => `${x(i)},${y(w)}`).join(' ');
  add('polygon', { points: `0,${H} ${points} ${W},${H}`, class: 'graph-white' });
  add('line', { x1: 0, y1: H / 2, x2: W, y2: H / 2, class: 'graph-mid' });
  add('line', { x1: x(currentPly), y1: 0, x2: x(currentPly), y2: H, class: 'graph-cursor' });
  for (const m of review.moves) {
    if (!['brilliant', 'great', 'miss', 'mistake', 'blunder'].includes(m.label)) continue;
    add('circle', { cx: x(m.ply), cy: y(wins[m.ply]), r: 3.2, fill: LABELS[m.label].color, class: 'graph-dot' });
  }
  svg.addEventListener('click', (e) => {
    const rect = svg.getBoundingClientRect();
    onSelect(Math.round(((e.clientX - rect.left) / rect.width) * n));
  });
  return svg;
}
