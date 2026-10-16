# ✦ Nova Grid

A small, polished turn-based territory strategy game for **2–4 players** — humans play in the
browser, AI agents play over a documented HTTP/JSON API, and they can share the same match.
Matches finish in minutes. Zero dependencies: one server file, one UI file, one sample bot.

![players](https://img.shields.io/badge/players-2--4-blue) ![deps](https://img.shields.io/badge/dependencies-0-brightgreen)

## Rules (one paragraph)

Each player, on their turn, places **one orb** on any empty cell or on a cell they already own.
A cell holds orbs up to its number of neighbors (corner 2, edge 3, interior 4); placing an orb
that exceeds capacity makes the cell **explode**: it sends one orb to each neighbor, flipping
them to the exploding player's color, and chains cascade across the board. A player left with
zero orbs after having had a turn is eliminated. **Last color standing wins**; if the turn
limit (60 placements per player) is reached, the player with the most orbs wins. That is the
whole ruleset — but every turn you must choose between expanding, detonating early, or holding
a corner, and there is no single dominant strategy.

## Play now (humans)

```bash
node server.js          # serves the game UI on http://localhost:3000
```

Open `http://localhost:3000`, click **New match vs bot**, then **Start match** — any seat you
leave empty is filled by the built-in bot. To play with friends, share the match code (or the
`/?join=CODE` link); no install, no login, no accounts. A finished match exposes its full
**match log** (every move, with flips) for replay.

The host can also run it as a container:

```bash
docker build -t novagrid . && docker run -p 3000:3000 novagrid
```

## Play (agents, HTTP/JSON API)

Everything is plain JSON over HTTP; no SDK, no keys — seats are claimed with a per-seat token
issued at creation/join. Full docs are served by the game itself at **`GET /api/docs`**.

| Method | Path | Purpose |
|---|---|---|
| `POST` | `/api/games` | Create a match `{players:2\|3\|4, fillBots?:bool, name?:string}` → returns state + host token |
| `GET`  | `/api/games` | List open lobby matches |
| `POST` | `/api/games/:ref/join` | Take a free seat `{name?, seat?, fill?:bool}` → `{seat, token, state}` (`ref` = id or 6-char code) |
| `POST` | `/api/games/:ref/start` | Host starts the match (empty seats become bots) |
| `GET`  | `/api/games/:ref?token=` | Full state: board, whose turn, **legal moves**, orbs |
| `POST` | `/api/games/:ref/moves` | Place an orb `{token, r, c}` (0-indexed) |
| `GET`  | `/api/games/:ref/log` | Move-by-move match log + result (replay) |
| `GET`  | `/healthz` | Liveness |

A move only succeeds on an empty cell or one you own, and only on your turn; errors say why
(`not your turn`, `cell occupied by opponent`, …) with HTTP 4xx.

### Sample bot

`sample_bot.mjs` is a complete, commented agent player — greedy 1-ply search that weighs
explosions, corner value and opponent-feeding risk:

```bash
node sample_bot.mjs http://localhost:3000            # create a match and play it out
node sample_bot.mjs https://your-host CODE my-bot    # join someone's match by code
```

It prints `WIN/DRAW/LOSS`, final orbs and the replay endpoint when the match ends.

## How it works

- `server.js` — dependency-free Node (18+) HTTP server: rules engine, deterministic cascade
  resolution (row-major rounds), in-memory match store, JSON API, static UI. Matches are
  addressable by a short human-typable code (e.g. `K7MQ2X`); spectators can watch any match.
- `public/index.html` — the whole UI in one file: lobby, board, legal-move highlighting,
  bots, invite links, match log. It talks only to the public API — the same API agents use,
  which is why human and agent play cannot diverge.
- The cascade logic in `sample_bot.mjs` mirrors the server exactly, so an agent can
  simulate moves locally before submitting.

## Judging-friendly notes

- A fresh match is one `POST /api/games` + one `POST …/start` away; the sample bot plays a
  full match unattended in under a minute.
- Everything is reproducible from `/api/games/:ref/log`: every position, flip and the result.
- No accounts, no database, no build step, no external services — `node server.js` is the
  entire deployment.

## License

MIT — see [LICENSE](LICENSE).
