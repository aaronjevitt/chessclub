/** Which colour a user had in a game ('w', 'b'), or null if they didn't play one side of it. */
export function colourOf(g, userId) {
  if (g.white_id === userId) return 'w';
  if (g.black_id === userId) return 'b';
  if (['computer', 'import'].includes(g.mode) && g.created_by === userId) {
    const c = JSON.parse(g.meta).playerColor;
    if (c === 'white' || c === 'black') return c === 'black' ? 'b' : 'w';
  }
  return null;
}
