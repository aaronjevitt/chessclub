// Puzzles from your own mistakes: the positions where you made a mistake, blunder or miss in a reviewed
// game. Find the engine's move (or one nearly as good); misses come back until you solve them first try.
import { Chess } from '/vendor/chess.js';
import { Board } from './board.js';
import { api } from './api.js';
import { el, clear } from './dom.js';
import { Engine } from './stockfish.js';
import { whiteWinPercent, LABELS } from './review.js';
import { labelIcon } from './review-view.js';
import { sounds, soundForMove } from './sounds.js';

const uciMove = (uci) => ({ from: uci.slice(0, 2), to: uci.slice(2, 4), promotion: uci[4] || undefined });

export async function puzzleView(main) {
  const { puzzles, stats } = await api('/puzzles');
  if (!puzzles.length) {
    clear(main, el('section', { class: 'card narrow-card' },
      el('h1', {}, 'Puzzles'),
      el('p', {}, 'Puzzles are made from your own mistakes: every mistake, blunder or miss in a reviewed game becomes a position to solve.'),
      el('p', { class: 'muted' }, 'Finish a game, open it and press “Game review”. Its mistakes show up here.')));
    return null;
  }

  let engine = null;
  let index = 0;
  let current = null;
  const results = { solved: 0, failed: 0 };

  const boardWrap = el('div', { class: 'board-wrap' });
  const panel = el('aside', { class: 'side-panel card puzzle-panel' });
  const progress = el('div', { class: 'muted small' });
  clear(main, el('div', { class: 'game-layout puzzle-layout' },
    el('div', { class: 'board-col' }, el('div', { class: 'board-row' }, boardWrap)),
    panel));

  const board = new Board(boardWrap, {
    canMove: (color) => !!current && !current.done && !current.busy && color === current.p.color,
    onMove: (from, to, promotion) => attempt({ from, to, promotion }),
  });

  function load() {
    const p = puzzles[index];
    current = { p, before: { status: p.status, solved: p.solved, failed: p.failed }, chess: new Chess(p.fen), done: false, busy: false, missed: false, feedback: null, hint: false };
    board.setOrientation(p.color === 'w' ? 'white' : 'black');
    board.skipNextAnimation = true;
    board.setAnnotations({});
    board.setPosition(current.chess, p.lastMove);
    render();
  }

  /** Record the outcome once: solved only on a clean first try. */
  function conclude(solved) {
    const c = current;
    if (c.recorded) return;
    c.recorded = true;
    results[solved ? 'solved' : 'failed']++;
    stats[c.p.status]--;
    c.p.status = solved ? 'solved' : 'failed';
    stats[c.p.status]++;
    c.p[solved ? 'solved' : 'failed']++;
    api('/puzzles/attempt', { method: 'POST', body: { gameId: c.p.gameId, ply: c.p.ply, solved } }).catch(() => {});
  }

  async function attempt(move) {
    const c = current;
    const chess = new Chess(c.p.fen);
    let played;
    try {
      played = chess.move(move);
    } catch {
      return;
    }
    board.skipNextAnimation = true;
    board.setPosition(chess, { from: played.from, to: played.to });
    soundForMove(played.san)();
    const uci = played.from + played.to + (played.promotion || '');
    if (uci === c.p.playedUci) return wrong(`${played.san} is what you played in the game. Try something else.`);
    if (uci === c.p.bestUci) return solve(`${played.san} is the best move!`);
    c.busy = true;
    c.feedback = { kind: 'checking', text: 'Checking…' };
    render();
    engine ||= new Engine();
    const after = await engine.analysePosition({ startFen: c.p.fen, moves: [played.san], timeMs: 600 }).catch(() => null);
    if (current !== c) return;
    c.busy = false;
    const mine = (w) => (c.p.color === 'w' ? w : 100 - w);
    const loss = after ? mine(whiteWinPercent(c.p.before)) - mine(whiteWinPercent(after)) : Infinity;
    if (loss < 5) return solve(`${played.san} works! The engine's top move was ${c.p.bestSan}.`);
    wrong(`${played.san} isn't it. Try again.`);
  }

  function wrong(text) {
    const c = current;
    c.missed = true;
    c.feedback = { kind: 'wrong', text };
    render();
    setTimeout(() => {
      if (current !== c || c.done) return;
      board.setPosition(c.chess, c.p.lastMove);
    }, 1100);
  }

  function solve(text) {
    const c = current;
    c.done = true;
    c.feedback = { kind: 'correct', text };
    conclude(!c.missed && !c.hint);
    if (!c.missed && !c.hint) sounds.notify();
    render();
  }

  function showSolution() {
    const c = current;
    const chess = new Chess(c.p.fen);
    const m = chess.move(uciMove(c.p.bestUci));
    c.done = true;
    c.feedback = { kind: 'solution', text: `The best move was ${c.p.bestSan}.` };
    conclude(false);
    board.setAnnotations({ arrows: [{ from: m.from, to: m.to, color: '#81b64c' }] });
    board.setPosition(chess, { from: m.from, to: m.to });
    render();
  }

  function showHint() {
    const c = current;
    c.hint = true;
    board.setAnnotations({ highlights: [{ square: c.p.bestUci.slice(0, 2), color: 'rgba(59,130,246,.55)' }] });
    board.render();
    render();
  }

  function next() {
    if (!current.done && (current.missed || current.hint)) conclude(false);
    index = (index + 1) % puzzles.length;
    load();
  }

  function historyNote({ status, solved, failed }) {
    if (status === 'new') return null;
    return el('p', { class: 'muted small' }, status === 'solved' ? `Solved before (${solved}×).` : `Missed before (${failed}×) — it's back for another go.`);
  }

  function render() {
    const { p, feedback, done } = current;
    const side = p.color === 'w' ? 'White' : 'Black';
    const label = LABELS[p.label];
    progress.textContent = `Puzzle ${index + 1} of ${puzzles.length} · this session: ${results.solved} solved, ${results.failed} missed`;
    clear(panel,
      el('h1', {}, 'Puzzles'),
      el('div', { class: 'puzzle-stats muted small' },
        `${stats.total} from your games · ${stats.solved} solved · ${stats.failed} to retry · ${stats.new} new`),
      progress,
      el('div', { class: 'puzzle-prompt' },
        el('div', { class: 'row' }, labelIcon(p.label), el('strong', {}, `${side} to move`)),
        el('p', {}, 'Against ', el('strong', {}, p.opponent || 'the computer'), ` you played `, el('strong', {}, p.played),
          ` here — a ${label.name.toLowerCase()}. Find a better move.`),
        historyNote(current.before)),
      feedback ? el('div', { class: `retry-feedback ${feedback.kind}` }, feedback.text) : null,
      el('div', { class: 'row puzzle-actions' },
        !done ? el('button', { type: 'button', class: 'btn', onclick: showHint, disabled: current.hint }, 'Hint') : null,
        !done ? el('button', { type: 'button', class: 'btn', onclick: showSolution }, 'Show solution') : null,
        el('button', { type: 'button', class: done ? 'btn primary' : 'btn', onclick: next }, done ? 'Next puzzle' : 'Skip')),
      el('a', { href: `#/game/${p.gameId}`, class: 'small' }, 'Open the game'));
  }

  load();
  return () => {
    if (current && !current.done && (current.missed || current.hint)) conclude(false);
    engine?.terminate();
  };
}
