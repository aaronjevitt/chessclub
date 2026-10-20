// Module worker: runs the computer opponent and the evaluation bar off the main thread.
import { Chess } from '/vendor/chess.js';
import { findBestMove, evaluatePosition } from './engine.js';

self.onmessage = (event) => {
  const { id, type = 'move', startFen, moves, level, timeMs } = event.data;
  try {
    const chess = new Chess(startFen);
    for (const san of moves) chess.move(san);
    const result = type === 'eval' ? evaluatePosition(chess, { timeMs }) : findBestMove(chess, { level });
    self.postMessage({ id, ...result });
  } catch (err) {
    self.postMessage({ id, error: String(err?.message || err) });
  }
};
