// Stockfish (WebAssembly, single-threaded "lite" build) running in a Web Worker, driven over UCI.
// Falls back to the small built-in engine (engine-worker.js) if Stockfish can't be loaded.
import { Chess } from '/vendor/chess.js';
import { LEVELS } from './engine.js';
import { STOCKFISH_MIN_ELO } from './bots.js';

const ENGINE_URL = '/vendor/stockfish/stockfish-19-lite-single.js';
const START_TIMEOUT_MS = 20000;

function parseScore(line) {
  const m = line.match(/ score (cp|mate) (-?\d+)/);
  if (!m) return null;
  return m[1] === 'cp' ? { cp: Number(m[2]), mate: null } : { cp: null, mate: Number(m[2]) };
}

class StockfishWorker {
  constructor() {
    this.listeners = new Set();
    this.queue = Promise.resolve();
    this.ready = new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('Stockfish did not start')), START_TIMEOUT_MS);
      try {
        this.worker = new Worker(ENGINE_URL);
      } catch (err) {
        clearTimeout(timer);
        reject(err);
        return;
      }
      this.worker.onmessage = (e) => {
        for (const listener of [...this.listeners]) listener(String(e.data));
      };
      this.worker.onerror = (e) => {
        clearTimeout(timer);
        reject(new Error(e.message || 'Stockfish failed to load'));
      };
      const onLine = (line) => {
        if (line !== 'uciok') return;
        this.listeners.delete(onLine);
        clearTimeout(timer);
        resolve();
      };
      this.listeners.add(onLine);
      this.send('uci');
    });
  }

  send(command) {
    this.worker?.postMessage(command);
  }

  /**
   * Run one search (searches are queued). Resolves with {bestmove, score, lines}: score is the main
   * line's, lines[k] = {score, move} for each MultiPV line; scores are relative to the side to move.
   */
  search(setup, go) {
    const run = () => new Promise((resolve) => {
      const lines = [];
      const onLine = (line) => {
        if (line.startsWith('info') && line.includes(' score ') && !line.includes(' upperbound') && !line.includes(' lowerbound')) {
          const score = parseScore(line);
          const k = Number(line.match(/ multipv (\d+)/)?.[1] || 1) - 1;
          const move = line.match(/ pv (\S+)/)?.[1] || lines[k]?.move;
          if (score) lines[k] = { score, move };
        } else if (line.startsWith('bestmove')) {
          this.listeners.delete(onLine);
          resolve({ bestmove: line.split(' ')[1], score: lines[0]?.score || null, lines });
        }
      };
      this.listeners.add(onLine);
      for (const command of setup) this.send(command);
      this.send(go);
    });
    const result = this.queue.then(() => this.ready).then(run);
    this.queue = result.catch(() => {});
    return result;
  }

  terminate() {
    this.worker?.terminate();
    this.worker = null;
  }
}

/** Fallback: the built-in engine in its own worker (same message format as engine-worker.js). */
class BuiltinWorker {
  constructor() {
    this.worker = new Worker(new URL('./engine-worker.js', import.meta.url), { type: 'module' });
    this.nextId = 0;
  }

  request(message) {
    const id = ++this.nextId;
    return new Promise((resolve, reject) => {
      this.worker.onmessage = ({ data }) => {
        if (data.id !== id) return;
        if (data.error) reject(new Error(data.error));
        else resolve(data);
      };
      this.worker.postMessage({ id, ...message });
    });
  }

  terminate() {
    this.worker.terminate();
  }
}

function replay(startFen, moves) {
  const chess = new Chess(startFen);
  for (const san of moves) chess.move(san);
  return chess;
}

function positionCommand(startFen, chess) {
  const uci = chess.history({ verbose: true }).map((m) => m.from + m.to + (m.promotion || ''));
  return `position fen ${startFen}${uci.length ? ` moves ${uci.join(' ')}` : ''}`;
}

function parseUciMove(uci) {
  return { from: uci.slice(0, 2), to: uci.slice(2, 4), promotion: uci[4] || undefined };
}

function legacyLevel(elo) {
  if (elo < 800) return 1;
  if (elo < 1200) return 2;
  if (elo < 1600) return 3;
  if (elo < 2000) return 4;
  return 5;
}

/**
 * An engine for one purpose (a bot, or an evaluation bar). Uses Stockfish, or the built-in engine
 * if Stockfish fails to start.
 */
export class Engine {
  constructor() {
    this.stockfish = new StockfishWorker();
    this.fallback = null;
    this.usingFallback = false;
    this.stockfish.ready.catch(() => {
      this.usingFallback = true;
      this.stockfish.terminate();
      this.fallback = new BuiltinWorker();
    });
  }

  async _backend() {
    try {
      await this.stockfish.ready;
      return 'stockfish';
    } catch {
      return 'builtin';
    }
  }

  /**
   * Choose a move playing at roughly `elo`, thinking for up to `timeMs`.
   * Below Stockfish's own limiter (1320) it searches shallowly at minimum skill and sometimes plays a
   * random move, so beginner bots make beginner mistakes.
   */
  async bestMove({ startFen, moves, elo, timeMs, random = Math.random }) {
    const chess = replay(startFen, moves);
    if ((await this._backend()) === 'builtin') {
      const data = await this.fallback.request({ type: 'move', startFen, moves, level: legacyLevel(elo), timeMs });
      return data.move;
    }
    const weak = elo < STOCKFISH_MIN_ELO;
    if (weak) {
      const t = (elo - 400) / (STOCKFISH_MIN_ELO - 400);
      const blunderRate = 0.3 - 0.27 * t;
      if (random() < blunderRate) {
        const legal = chess.moves({ verbose: true });
        const m = legal[Math.floor(random() * legal.length)];
        return { from: m.from, to: m.to, promotion: m.promotion };
      }
    }
    const setup = weak
      ? ['setoption name MultiPV value 1', 'setoption name UCI_LimitStrength value false', 'setoption name Skill Level value 0']
      : ['setoption name MultiPV value 1', 'setoption name Skill Level value 20', 'setoption name UCI_LimitStrength value true', `setoption name UCI_Elo value ${elo}`];
    setup.push(positionCommand(startFen, chess));
    const depth = 1 + Math.round(((elo - 400) / (STOCKFISH_MIN_ELO - 400)) * 4);
    const go = weak ? `go depth ${depth} movetime ${Math.round(timeMs)}` : `go movetime ${Math.round(timeMs)}`;
    const { bestmove } = await this.stockfish.search(setup, go);
    if (!bestmove || bestmove === '(none)') return null;
    return parseUciMove(bestmove);
  }

  /** Full-strength evaluation from White's point of view: {cp, mate}. */
  async evaluate({ startFen, moves, timeMs = 800 }) {
    const chess = replay(startFen, moves);
    const sign = chess.turn() === 'w' ? 1 : -1;
    if (chess.isCheckmate()) return { cp: -sign * 100000, mate: 0 };
    if (chess.isDraw()) return { cp: 0, mate: null };
    if ((await this._backend()) === 'builtin') {
      const data = await this.fallback.request({ type: 'eval', startFen, moves, timeMs });
      return { cp: data.cp, mate: data.mate };
    }
    const setup = ['setoption name MultiPV value 1', 'setoption name UCI_LimitStrength value false', 'setoption name Skill Level value 20', positionCommand(startFen, chess)];
    const { score } = await this.stockfish.search(setup, `go movetime ${Math.round(timeMs)}`);
    if (!score) return null;
    if (score.mate !== null) return { cp: sign * Math.sign(score.mate) * 100000, mate: sign * score.mate };
    return { cp: sign * score.cp, mate: null };
  }

  /**
   * Full-strength analysis of the position after `moves`, from White's point of view, with the two best
   * lines: {best, cp, mate, alt, cp2, mate2} (the shape game review stores per position).
   */
  async analysePosition({ startFen, moves, timeMs = 400 }) {
    const chess = replay(startFen, moves);
    const sign = chess.turn() === 'w' ? 1 : -1;
    const empty = { best: null, cp: 0, mate: null, alt: null, cp2: null, mate2: null };
    if (chess.isCheckmate()) return { ...empty, cp: -sign * 100000, mate: 0 };
    if (chess.isDraw()) return empty;
    const white = (score) => (score.mate !== null
      ? { cp: null, mate: sign * score.mate }
      : { cp: sign * score.cp, mate: null });
    if ((await this._backend()) === 'builtin') {
      const data = await this.fallback.request({ type: 'move', startFen, moves, level: 5, timeMs });
      const mate = Math.abs(data.score) > 99000;
      return {
        ...empty,
        best: data.move.from + data.move.to + (data.move.promotion || ''),
        ...(mate ? { cp: null, mate: sign * Math.sign(data.score) * Math.ceil((100000 - Math.abs(data.score)) / 2) } : { cp: sign * data.score }),
      };
    }
    const setup = ['setoption name MultiPV value 2', 'setoption name UCI_LimitStrength value false', 'setoption name Skill Level value 20', positionCommand(startFen, chess)];
    const { bestmove, lines } = await this.stockfish.search(setup, `go movetime ${Math.round(timeMs)}`);
    if (!lines[0]) return empty;
    const main = white(lines[0].score);
    const alt = lines[1] ? white(lines[1].score) : null;
    return {
      best: bestmove && bestmove !== '(none)' ? bestmove : lines[0].move,
      cp: main.cp, mate: main.mate,
      alt: lines[1]?.move || null, cp2: alt ? alt.cp : null, mate2: alt ? alt.mate : null,
    };
  }

  /** Default thinking time for a bot of this strength when not on the clock. */
  static thinkTime(elo) {
    if (elo < STOCKFISH_MIN_ELO) return 400;
    if (elo < 2400) return 1000;
    return Math.min(2500, LEVELS[5].timeMs);
  }

  terminate() {
    this.stockfish.terminate();
    this.fallback?.terminate();
  }
}
