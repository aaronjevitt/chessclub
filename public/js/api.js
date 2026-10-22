export async function api(path, { method = 'GET', body } = {}) {
  const res = await fetch(`/api${path}`, {
    method,
    headers: body ? { 'Content-Type': 'application/json' } : undefined,
    body: body ? JSON.stringify(body) : undefined,
    credentials: 'same-origin',
  });
  let data = {};
  try {
    data = await res.json();
  } catch {
    // Non-JSON responses fall through to the status check.
  }
  if (!res.ok) {
    const err = new Error(data.error || `Request failed (${res.status})`);
    err.status = res.status;
    throw err;
  }
  return data;
}

let socket = null;

/** Lazily-connected Socket.IO client; reconnect after login/logout via resetSocket(). */
export function getSocket() {
  if (!socket) socket = window.io({ withCredentials: true });
  return socket;
}

export function resetSocket() {
  if (socket) socket.disconnect();
  socket = null;
}
