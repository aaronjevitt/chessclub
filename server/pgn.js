// PGN import: split a PGN file into games and read each one's moves and headers.
import { Chess } from 'chess.js';

const START_FEN = 'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1';
const RESULTS = new Set(['1-0', '0-1', '1/2-1/2']);
export const MAX_IMPORT_GAMES = 50;

/** Split a PGN containing several games (each starting with its tag pairs). */
export function splitPgn(text) {
  const lines = String(text).replace(/\r\n?/g, '\n').replace(/^﻿/, '').split('\n');
  const games = [];
  let current = [];
  let inMoves = false;
  for (const line of lines) {
    const isTag = /^\s*\[\w+\s+".*"\]\s*$/.test(line);
    if (isTag && inMoves) {
      games.push(current.join('\n'));
      current = [];
      inMoves = false;
    }
    if (!isTag && line.trim()) inMoves = true;
    current.push(line);
  }
  if (current.join('').trim()) games.push(current.join('\n'));
  return games.map((g) => g.trim()).filter(Boolean);
}

/**
 * Parse one game. Returns {startFen, moves, headers, result, termination}; throws with a readable
 * message if the PGN can't be read.
 */
export function parsePgnGame(pgn) {
  const chess = new Chess();
  try {
    chess.loadPgn(pgn);
  } catch (err) {
    throw new Error(`Could not read this PGN: ${String(err.message || err).split('\n')[0]}`);
  }
  const headers = chess.getHeaders();
  const moves = chess.history();
  const startFen = headers.SetUp === '1' && headers.FEN ? headers.FEN : START_FEN;
  let result = RESULTS.has(headers.Result) ? headers.Result : '*';
  let termination = headers.Termination || null;
  if (chess.isCheckmate()) {
    result = chess.turn() === 'w' ? '0-1' : '1-0';
    termination = 'checkmate';
  } else if (result === '*' && chess.isDraw()) {
    result = '1/2-1/2';
    termination = chess.isStalemate() ? 'stalemate' : 'draw';
  }
  if (!moves.length) throw new Error('This PGN has no moves');
  return { startFen, fen: chess.fen(), moves, headers, result, termination };
}

const clean = (v) => (v && !/^\?+$/.test(v) && !/^[?.]+$/.test(v) ? v : null);

/** Tidy header values: '?' placeholders become null. */
export function pgnInfo(headers) {
  return {
    white: clean(headers.White),
    black: clean(headers.Black),
    event: clean(headers.Event),
    site: clean(headers.Site),
    date: clean(headers.Date)?.replace(/\.\?\?/g, '') || null,
    whiteElo: clean(headers.WhiteElo),
    blackElo: clean(headers.BlackElo),
    timeControl: clean(headers.TimeControl),
  };
}
