# ♞ Chess Club

A web-based chess club. Members create an account, start or join clubs, and play:

- **Online games against club members** — open challenges or direct challenges, with live updates over WebSockets, draw offers, resignation and abort. Games can be **club-visible** (anyone in the club can spectate) or **private** (only the two players).
- **Against the computer** — **Stockfish 19** (WebAssembly) runs entirely in your browser. Pick a named bot (Pip 400 … Gia 2800, Stockfish 3190) or any custom Elo from 400 to 3190. Stockfish's own strength limiter covers 1320 and up; below that the bot searches shallowly and sometimes plays a random move, so those ratings are approximate. If a browser can't run Stockfish, a small built-in engine takes over. On your turn, **Hint** highlights which piece to move; press again to see the full move (hints used are counted on the game; not available in games against people).
- **By yourself** — move both sides, for practice or analysis, from the standard position or any FEN.
- **Real over-the-board games** — enter the moves of a physical game as it is played and declare the result.

**Time controls** — online and computer games can be played on the clock: bullet, blitz, rapid and classical presets (1+0, 1+1, 2+1, 3+2, 5+3, 10+5, 15+10, 30+20, …) or any custom time and increment. Clocks are **server-authoritative**: the server charges each move's time, applies the increment and ends the game on time by itself, even if the player who flagged has closed their browser (a timeout is a draw if the opponent can't possibly mate). As on lichess, each side's first move is untimed. Private games against the computer keep the same clock in the browser, and the computer budgets its thinking time to the clock.

Computer, self-play and over-the-board games are **private by default** and live only in your browser. At any point you can **broadcast** one to a club — the server then validates every move and relays it live to spectators — and you can stop broadcasting at any time to continue privately.

**Game review** — after a game, Stockfish analyses every position in the browser (about a third of a second each) and the review is saved so the whole club sees the same one: move labels (Book, Brilliant, Great, Best, Excellent, Good, Inaccuracy, Mistake, Miss, Blunder), accuracy for both players, the opening name, a clickable evaluation graph, best-move arrows and badges on the board, and jumps between key moments. **Explore**: make any move on the board during a review to try out a different line — Stockfish rates each move you try, the eval bar follows, and *Best move* lets Stockfish continue the line. **Retry mistakes** replays the position before each of your mistakes so you can find a better move (Stockfish checks your answer). Winning chances and accuracy follow lichess's published formulas; Brilliant, Great and Miss are approximations of chess.com's definitions, which aren't public.

The **club view** shows every live game in the club as a board that updates in real time, open challenges, recently finished games and the member list. **Projector view** (`#/tv/<club id>`) shows all live club games full-screen, sized to fill the display — leave it running on a projector or TV at club night. Every game can be reviewed move by move (← / → keys) and exported as PGN. When setting up a game or challenge you can turn on an **evaluation bar** — for the whole game, or only for the first N moves (it fades out over the last five moves before the limit, as a training aid): full-strength Stockfish assesses the position on the board (following move review too), and everyone watching the game — including the projector view — sees it.

**Ratings and leaderboard** — every club keeps its own Elo ratings (everyone starts at 1200; provisional for the first 10 games). Online games are rated unless the challenger ticks them off; aborted games and games with fewer than two moves aren't rated. The club's member list is ranked by rating, and the projector shows the leaderboard between games.

**Player profiles** (`#/player/<id>`, or tap your name / the person icon) — ratings per club with a rating graph, record against members and against the computer, average review accuracy and recent games. You can see the profiles of people who share a club with you.

**Tournaments** — any member can create one from the club page: **Swiss** (paired by score, no rematches, fair byes, balanced colours) or **round robin**, played **online** (games are created automatically each round, and the next round is paired as soon as the last game ends) or **over the board** (the organiser or the players report results). Standings use points then Buchholz; tournaments can be rated. The projector shows the standings of a running tournament.

**Puzzles** (`#/puzzles`) — every mistake, blunder or miss you made in a reviewed game becomes a puzzle: find the engine's move, or one nearly as good (Stockfish checks your answer in the browser). Puzzles you miss come back first next time.

**PGN import** — on the *New game* page, paste a PGN or choose a file (up to 50 games) from chess.com, lichess or a scoresheet. Imported games are private unless you share them, can be reviewed, and feed your puzzles; they don't affect ratings.

**Play on Lichess** — link your Lichess account on your profile (*Connect Lichess account*; standard Lichess sign-in, nothing to register), then choose *Play on Lichess* on the New game page: look for any opponent (rapid or slower), challenge a Lichess player by username (blitz or slower), or play the Lichess computer (levels 1–8) — all on this board, with clocks, draw offers and resignation. Lichess challenges to you appear on the home page. The server holds each member's Lichess token and relays the game live; Lichess's own rules apply, so these games have no evaluation bar or hints (engine help during a Lichess game breaks its fair-play rules), and apps can't play bullet there.

**Ratings with Lichess** — Lichess rates Lichess games, and they change only your Lichess rating. Club ratings come only from games played in the club, so the two pools stay separate and comparable within themselves. Your Lichess ratings (blitz, rapid, classical…) show on your profile beside your club ratings, and players' Lichess ratings and rating changes show in the game. Finished Lichess games are saved as private games in your first club, so you can review them here and their mistakes become puzzles; like PGN imports, they don't count towards club records.

**Notifications** — turn them on per device on your profile page to hear when it's your move, someone challenges you, accepts your challenge or offers a draw, or a tournament round pairs you (only while you don't have that game open). This is standard Web Push: the server generates its own keys, no third-party account is needed, and it requires HTTPS. On iPhone/iPad (iOS 16.4+), add Chess Club to the Home Screen first (Share → *Add to Home Screen*) and turn notifications on from there — the app is installable on other devices too.

**Also** — move sounds (speaker button in the header to mute), premoves in online games (move while it's your opponent's turn; tap anywhere to cancel), club admin tools for owners (rename, privacy, new invite code, remove members, issue password-reset links), and account safety: login and sign-up rate limits, and password changes that sign out your other devices.

**Forgotten password** — there is no email, so the club owner opens the member's … menu in the club member list, chooses *Reset password* and sends them the one-time link (valid for 24 hours).

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
| `COOKIE_SECURE` | unset                 | `1` forces Secure cookies (otherwise set automatically when the proxy says the request was HTTPS) |
| `TRUST_PROXY`   | `loopback, linklocal, uniquelocal` | Which proxies to believe for the client address and protocol ([Express `trust proxy`](https://expressjs.com/en/guide/behind-proxies.html)) |
| `RATE_LIMITS`   | on                    | `0` turns off login / sign-up rate limiting     |
| `BACKUPS`       | on                    | `0` turns off the daily database backup         |
| `BACKUP_DIR`    | `backups/` next to the database | Where daily backups go                 |
| `BACKUP_KEEP`   | `14`                  | How many daily backups to keep                  |
| `PUBLIC_URL`    | from the request      | The site's public address, e.g. `https://chess.example.com` (used for the Lichess sign-in return address if the proxy doesn't pass the right host) |
| `LICHESS_HOST`  | `https://lichess.org` | Lichess server to talk to (for testing) |
| `PUSH_SUBJECT`  | the site's URL        | Contact sent to push services (`mailto:you@example.com` or an `https://` URL) |

Housekeeping runs by itself: a consistent copy of the database is written once a day (`VACUUM INTO`), timed online games nobody started are aborted after 10 minutes, broadcasts paused for a day are ended, and open challenges expire after a week.

## How it fits together

```
server/
  app.js         Express REST API + Socket.IO (auth, clubs, games, realtime rooms)
  auth.js        scrypt password hashing, cookie sessions
  account.js     sign-up, login, password change and reset links
  chesslogic.js  move validation / game-over detection (chess.js)
  clock.js       server-authoritative clocks
  ratings.js     per-club Elo
  tournaments.js / pairing.js   Swiss and round-robin tournaments
  profiles.js    player profiles
  puzzles.js     puzzles from your mistakes
  pgn.js         PGN import
  push.js        Web Push notifications
  maintenance.js daily backups and clean-up sweeps
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

Opening names: [lichess-org/chess-openings](https://github.com/lichess-org/chess-openings) (CC0), compiled into `public/data/openings.json` by `scripts/build-openings.mjs`.

[Stockfish](https://stockfishchess.org/) is free software under the GNU GPL v3; the app serves the unmodified WebAssembly build from the [`stockfish`](https://github.com/nmrugg/stockfish.js) npm package (by Nathan Rugg and Chess.com), whose source is available at that link. Its license text is served at `/vendor/stockfish/COPYING.txt`.

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

### Behind nginx with HTTPS

The app needs WebSockets (`/socket.io/`) and the original protocol and client address. A minimal site:

```nginx
server {
    listen 443 ssl;
    http2 on;
    server_name chess.example.com;
    # ssl_certificate / ssl_certificate_key …

    client_max_body_size 4m;          # PGN imports

    location / {
        proxy_pass http://CONTAINER_IP:3000;
        proxy_http_version 1.1;
        proxy_set_header Host $host;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
        # WebSockets
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection "upgrade";
        proxy_read_timeout 1h;
    }
}
```

The app trusts `X-Forwarded-*` from private-network addresses by default, so with nginx on your LAN cookies are marked Secure and rate limits see real client addresses with no extra settings. If nginx reaches the container from a public address, set `TRUST_PROXY` to that address in `/etc/chessclub/chessclub.env` and restart (`systemctl restart chessclub`). Notifications and installing to the Home Screen only work over HTTPS.
