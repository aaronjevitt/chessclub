// Build public/data/openings.json from the lichess chess-openings TSV files (CC0):
//   https://github.com/lichess-org/chess-openings  (a.tsv … e.tsv)
// Usage: node scripts/build-openings.mjs <directory containing a.tsv … e.tsv>
//
// Output maps a position key (piece placement, side to move, castling) to "ECO|Name" for named
// positions, or "" for positions that occur along a known opening line (still "book").
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Chess } from 'chess.js';

const dir = process.argv[2];
if (!dir) {
  console.error('usage: node scripts/build-openings.mjs <dir with a.tsv … e.tsv>');
  process.exit(1);
}

const positionKey = (fen) => fen.split(' ').slice(0, 3).join(' ');
const book = {};
let lines = 0;
for (const file of ['a', 'b', 'c', 'd', 'e']) {
  const rows = fs.readFileSync(path.join(dir, `${file}.tsv`), 'utf8').trim().split('\n').slice(1);
  for (const row of rows) {
    const [eco, name, pgn] = row.split('\t');
    const chess = new Chess();
    const sans = pgn.replace(/\d+\.(\.\.)?/g, ' ').trim().split(/\s+/);
    for (const san of sans) {
      chess.move(san);
      const key = positionKey(chess.fen());
      if (!(key in book)) book[key] = '';
    }
    // The named position. Transpositions can reach it by several lines; the first name listed wins.
    const key = positionKey(chess.fen());
    if (!book[key]) book[key] = `${eco}|${name}`;
    lines++;
  }
}

const out = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'public', 'data', 'openings.json');
fs.writeFileSync(out, JSON.stringify(book));
console.log(`${lines} lines → ${Object.keys(book).length} positions → ${out} (${(fs.statSync(out).size / 1024).toFixed(0)} KB)`);
