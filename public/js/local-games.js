// Private games that live only in this browser (never sent to the server unless the player broadcasts them).

function key(userId) {
  return `chessclub:local-games:${userId}`;
}

export function listLocalGames(userId) {
  try {
    const games = JSON.parse(localStorage.getItem(key(userId)) || '[]');
    return Array.isArray(games) ? games.sort((a, b) => b.updatedAt - a.updatedAt) : [];
  } catch {
    return [];
  }
}

function saveAll(userId, games) {
  try {
    localStorage.setItem(key(userId), JSON.stringify(games));
  } catch {
    // Storage full or blocked: the game still works for this page view.
  }
}

export function getLocalGame(userId, id) {
  return listLocalGames(userId).find((g) => g.id === id) || null;
}

export function saveLocalGame(userId, game) {
  const games = listLocalGames(userId).filter((g) => g.id !== game.id);
  games.push({ ...game, updatedAt: Date.now() });
  saveAll(userId, games);
}

export function deleteLocalGame(userId, id) {
  saveAll(userId, listLocalGames(userId).filter((g) => g.id !== id));
}

export function newLocalId() {
  return `L${Date.now().toString(36)}${Math.random().toString(36).slice(2, 7)}`;
}
