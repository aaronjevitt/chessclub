// Module worker: runs the computer opponent off the main thread.
import { Chess } from '/vendor/chess.js';
import { findBestMove } from './engine.js';

self.onmessage = (event) => {
  const { id, startFen, moves, level } = event.data;
  try {
    const chess = new Chess(startFen);
    for (const san of moves) chess.move(san);
    const result = findBestMove(chess, { level });
    self.postMessage({ id, ...result });
  } catch (err) {
    self.postMessage({ id, error: String(err?.message || err) });
  }
};
