# ♞ Chess Club

A web-based chess club. Members create an account, start or join clubs, and play:

- **Online games against club members** — open challenges or direct challenges, with live updates over WebSockets, draw offers, resignation and abort. Games can be **club-visible** (anyone in the club can spectate) or **private** (only the two players).
- **Against the computer** — the engine runs entirely in your browser (in a Web Worker); 5 strength levels.
- **By yourself** — move both sides, for practice or analysis, from the standard position or any FEN.
- **Real over-the-board games** — enter the moves of a physical game as it is played and declare the result.

**Time controls** — online and computer games can be played on the clock: bullet, blitz, rapid and classical presets (1+0, 1+1, 2+1, 3+2, 5+3, 10+5, 15+10, 30+20, …) or any custom time and increment. Clocks are **server-authoritative**: the server charges each move's time, applies the increment and ends the game on time by itself, even if the player who flagged has closed their browser (a timeout is a draw if the opponent can't possibly mate). As on lichess, each side's first move is untimed. Private games against the computer keep the same clock in the browser, and the computer budgets its thinking time to the clock.

Computer, self-play and over-the-board games are **private by default** and live only in your browser. At any point you can **broadcast** one to a club — the server then validates every move and relays it live to spectators — and you can stop broadcasting at any time to continue privately.

The **club view** shows every live game in the club as a board that updates in real time, open challenges, recently finished games and the member list. **Projector view** (`#/tv/<club id>`) shows all live club games full-screen, sized to fill the display — leave it running on a projector or TV at club night. Every game can be reviewed move by move (← / → keys) and exported as PGN. When setting up a game or challenge you can turn on an **evaluation bar**: the in-browser engine assesses the position on the board (following move review too), and everyone watching the game — including the projector view — sees it.

## Running

Requires Node.js 22.13 or newer (uses the built-in `node:sqlite`).

```bash
npm install
npm start          # http://localhost:3000
npm test           # API, realtime and engine tests
```

Environment variables:

| Variable        | Default               | Purpose                                        |
| --------------- | --------------------- | ---------------------------------------------- |
| `PORT`          | `3000`                | HTTP port                                      |
| `DB_FILE`       | `data/chessclub.db`   | SQLite database file                           |
| `COOKIE_SECURE` | unset                 | Set to `1` behind HTTPS to mark cookies secure |

## How it fits together

```
server/
  app.js         Express REST API + Socket.IO (auth, clubs, games, realtime rooms)
  auth.js        scrypt password hashing, cookie sessions
  chesslogic.js  move validation / game-over detection (chess.js)
  db.js          SQLite schema
public/
  index.html     single-page app shell (hash routing)
  js/app.js      views: login, home, club, new game
  js/game-view.js  board + side panel for live and private games
  js/board.js    interactive board (click or drag, promotion picker)
  js/engine.js   alpha-beta engine (iterative deepening, quiescence, TT)
  js/engine-worker.js  runs the engine off the main thread
  js/local-games.js    private games in localStorage
```

- All mutations go through the REST API; the server is authoritative and re-validates every move. Socket.IO is used only to push state (`game`, `club:changed`, `mygames:changed`) to rooms the user is allowed to watch.
- In a broadcast computer game the broadcaster's browser computes the engine's moves and submits them; only the broadcaster may move in broadcast games.
- The engine drives chess.js through its internal 0x88 API for speed, so chess.js is pinned to an exact version; `test/engine.test.js` fails if those internals change.

## Credits

Chess piece artwork: "Cburnett" set by Colin M. L. Burnett, used under the BSD license.

## Not yet included

Ratings, password reset, and rate limiting on login are not implemented.

## Deploying to Proxmox (LXC)

On the Proxmox host, as root — nothing to clone, the code is pulled inside the container:

```bash
bash -c "$(curl -fsSL https://raw.githubusercontent.com/aaronjevitt/chessclub/main/deploy/proxmox-lxc.sh)"

# static IP instead of DHCP:
IP=192.168.1.50/24 GATEWAY=192.168.1.1 bash -c "$(curl -fsSL https://raw.githubusercontent.com/aaronjevitt/chessclub/main/deploy/proxmox-lxc.sh)"
```

To update later (pulls the latest code; the database is kept):

```bash
pct exec <CTID> -- chessclub-update
```

You can also run `./deploy/proxmox-lxc.sh` from a checkout to deploy that checkout's code instead (update with `./deploy/proxmox-lxc.sh update <CTID>`).

The script creates an unprivileged container, installs Node.js 22, and runs the app as a `chessclub` systemd service on port 3000. Data lives in `/var/lib/chessclub` and settings in `/etc/chessclub/chessclub.env` inside the container. All options (storage, cores, memory, bridge, VLAN, port, …) are listed at the top of the script.

Behind an HTTPS reverse proxy, set `COOKIE_SECURE=1` and make sure the proxy forwards WebSocket upgrades (`/socket.io/`).
