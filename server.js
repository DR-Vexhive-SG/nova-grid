#!/usr/bin/env node
/**
 * Nova Grid — a small turn-based territory strategy game for 2-4 players.
 * Humans play in the browser, agents play via the JSON API (see /api/docs and README.md).
 * Zero dependencies. Node 18+. State is in memory.
 */
"use strict";

const http = require("http");
const crypto = require("crypto");
const fs = require("fs");
const path = require("path");

const PORT = parseInt(process.env.PORT || "3000", 10);
const PUBLIC_DIR = path.join(__dirname, "public");

/* ---------------- game rules ---------------- */

const PLAYER_COLORS = ["#ff6b6b", "#2ec4b6", "#ff9f1c", "#7b8cff"];

function capacity(board, r, c) {
  // corner: 2, edge: 3, interior: 4
  const rows = board.length, cols = board[0].length;
  const onRowEdge = r === 0 || r === rows - 1;
  const onColEdge = c === 0 || c === cols - 1;
  return (onRowEdge ? 1 : 2) + (onColEdge ? 1 : 2);
}

function neighbors(board, r, c) {
  const out = [];
  if (r > 0) out.push([r - 1, c]);
  if (r < board.length - 1) out.push([r + 1, c]);
  if (c > 0) out.push([r, c - 1]);
  if (c < board[0].length - 1) out.push([r, c + 1]);
  return out;
}

function emptyBoard(rows, cols) {
  return Array.from({ length: rows }, () =>
    Array.from({ length: cols }, () => ({ owner: null, count: 0 }))
  );
}

/** Apply one move. Mutates game. Deterministic cascade (row-major scan rounds). */
function applyMove(game, seat, r, c) {
  const board = game.board;
  const cell = board[r][c];
  if (cell.owner !== null && cell.owner !== seat) throw new Error("cell occupied by opponent");
  cell.owner = seat;
  cell.count += 1;
  const captured = { from: {}, cells: 0 };

  // cascade
  for (let guard = 0; guard < 10000; guard++) {
    let exploded = false;
    for (let i = 0; i < board.length; i++) {
      for (let j = 0; j < board[i].length; j++) {
        const b = board[i][j];
        if (b.count > capacity(board, i, j)) {
          exploded = true;
          const cap = capacity(board, i, j);
          const prevOwner = b.owner;
          b.count -= cap;
          if (b.count === 0) b.owner = null;
          for (const [ni, nj] of neighbors(board, i, j)) {
            const nb = board[ni][nj];
            if (nb.owner !== null && nb.owner !== seat) {
              captured.from[nb.owner] = (captured.from[nb.owner] || 0) + 1;
              captured.cells++;
            } else if (nb.owner === null) {
              captured.cells++;
            }
            nb.owner = seat;
            nb.count += 1;
          }
          if (prevOwner !== seat && b.owner === seat) { /* converted by later blast if needed */ }
        }
      }
    }
    if (!exploded) break;
  }

  // eliminations: zero orbs after having had a turn, OR no legal move at all
  const orbs = countOrbs(game);
  game.players.forEach((p) => {
    if (orbs[p.seat] > 0) p.everHadOrbs = true;
    if (p.movesMade > 0 && orbs[p.seat] === 0) p.active = false;
    else if (p.active && legalMovesFor(game, p.seat).length === 0) p.active = false;
  });

  game.moveCount += 1;
  game.log.push({ n: game.moveCount, seat, r, c, at: Date.now(), captured: captured.cells });

  const stillIn = game.players.filter((p) => p.active);
  if (stillIn.length <= 1) {
    game.status = "finished";
    game.winner = stillIn.length === 1 ? stillIn[0].seat : null;
    game.winReason = stillIn.length === 1 ? "last player with orbs" : "no player with a legal move";
    return captured;
  }
  if (game.moveCount >= game.turnLimit) {
    game.status = "finished";
    const best = Math.max(...game.players.map((p) => orbs[p.seat] || 0));
    const winners = game.players.filter((p) => (orbs[p.seat] || 0) === best).map((p) => p.seat);
    game.winner = winners.length === 1 ? winners[0] : null;
    game.winReason = winners.length === 1 ? "turn limit: most orbs" : `turn limit: tie between seats ${winners.join(", ")}`;
    return captured;
  }
  // advance to the next active player that actually has a legal move
  let next = nextSeat(game, seat);
  let hops = 0;
  while (legalMovesFor(game, next).length === 0 && hops <= game.players.length) {
    game.players[next].active = false;
    next = nextSeat(game, next);
    hops++;
  }
  game.turn = next;
  return captured;
}

function countOrbs(game) {
  const orbs = {};
  for (const row of game.board) for (const cell of row) {
    if (cell.owner !== null) orbs[cell.owner] = (orbs[cell.owner] || 0) + cell.count;
  }
  return orbs;
}

function nextSeat(game, from) {
  const n = game.players.length;
  for (let k = 1; k <= n; k++) {
    const s = (from + k) % n;
    if (game.players[s].active) return s;
  }
  return from;
}

function legalMovesFor(game, seat) {
  const out = [];
  for (let r = 0; r < game.board.length; r++)
    for (let c = 0; c < game.board[0].length; c++) {
      const cell = game.board[r][c];
      if (cell.owner === null || cell.owner === seat) out.push([r, c]);
    }
  return out;
}

function legalMoves(game) { return legalMovesFor(game, game.turn); }

/* ---------------- bot (same heuristic server-side and in sample_bot.mjs) ---------------- */

function chooseMove(game) {
  const seat = game.turn;
  const moves = legalMoves(game);
  if (moves.length === 0) return null;
  // scoreMove works on the public view ({o,n} cells), not the internal one
  const view = {
    board: game.board.map((row) => row.map((cell) => ({ o: cell.owner, n: cell.count }))),
    legalMoves: moves,
  };
  let best = moves[0], bestScore = -Infinity;
  for (const [r, c] of moves) {
    const score = scoreMove(view, seat, r, c) + Math.random() * 0.5;
    if (score > bestScore) { bestScore = score; best = [r, c]; }
  }
  return best;
}

function scoreMove(game, seat, r, c) {
  // 1-ply simulation on a copy
  const board = game.board.map((row) => row.map((cell) => ({ ...cell })));
  const cap = capacity(board, r, c);
  const before = snapshotCounts(board);
  board[r][c].owner = seat;
  board[r][c].count += 1;
  let captured = 0, grew = 0;
  for (let guard = 0; guard < 1000; guard++) {
    let exploded = false;
    for (let i = 0; i < board.length; i++) for (let j = 0; j < board[i].length; j++) {
      const b = board[i][j];
      if (b.count > capacity(board, i, j)) {
        exploded = true;
        const k = capacity(board, i, j);
        b.count -= k;
        if (b.count === 0) b.owner = null;
        for (const [ni, nj] of neighbors(board, i, j)) {
          const nb = board[ni][nj];
          if (nb.owner !== null && nb.owner !== seat) captured++;
          nb.owner = seat;
          nb.count += 1;
        }
      }
    }
    if (!exploded) break;
  }
  const after = snapshotCounts(board);
  grew = (after[seat] || 0) - (before[seat] || 0);
  let oppRisk = 0;
  // penalize feeding opponents' near-critical cells (basic safety)
  for (let i = 0; i < board.length; i++) for (let j = 0; j < board[i].length; j++) {
    const b = board[i][j];
    if (b.owner !== null && b.owner !== seat && b.count === capacity(board, i, j) - 1) oppRisk += 2;
  }
  const cornerBonus = (r === 0 || r === board.length - 1) && (c === 0 || c === board[0].length - 1) ? 3 : 0;
  void cap;
  return captured * 12 + grew * 2 + cornerBonus - oppRisk;
}

function snapshotCounts(board) {
  const out = {};
  for (const row of board) for (const cell of row) {
    if (cell.owner !== null) out[cell.owner] = (out[cell.owner] || 0) + cell.count;
  }
  return out;
}

/* ---------------- store ---------------- */

const games = new Map();       // id -> game
const codeIndex = new Map();   // short code -> id

function newId() { return "g" + crypto.randomBytes(8).toString("hex"); }
function newCode() {
  const alphabet = "ABCDEFGHJKMNPQRSTUVWXYZ23456789";
  for (;;) {
    let code = "";
    const buf = crypto.randomBytes(6);
    for (let i = 0; i < 6; i++) code += alphabet[buf[i] % alphabet.length];
    if (!codeIndex.has(code)) return code;
  }
}
function newToken() { return crypto.randomBytes(16).toString("hex"); }

function createGame({ players = 2, fillBots = false, name = "" } = {}) {
  players = Math.min(4, Math.max(2, parseInt(players, 10) || 2));
  const rows = players <= 2 ? 6 : 5;
  const cols = players <= 2 ? 6 : 5;
  const id = newId();
  const code = newCode();
  const game = {
    id, code,
    status: "lobby",            // lobby | playing | finished
    players: Array.from({ length: players }, (_, seat) => ({
      seat, name: seat === 0 ? "host" : `seat${seat}`,
      isBot: fillBots && seat > 0, token: newToken(),
      active: true, movesMade: 0, everHadOrbs: false, color: PLAYER_COLORS[seat],
    })),
    board: emptyBoard(rows, cols),
    turn: 0, winner: null, winReason: null,
    moveCount: 0,
    turnLimit: players * 60,
    createdAt: Date.now(),
    name: String(name || "").slice(0, 60),
    log: [],
  };
  games.set(id, game);
  codeIndex.set(code, id);
  if (fillBots) startGame(game);
  return game;
}

function startGame(game) {
  // any seat that never joined becomes a bot
  game.players.forEach((p, seat) => {
    if (seat !== 0 && !p.joined && !p.isBot) { p.isBot = true; p.name = "bot"; }
    if (p.isBot && !p.name) p.name = "bot";
  });
  game.status = "playing";
  game.turn = 0;
}

function findGame(ref) {
  if (games.has(ref)) return games.get(ref);
  const id = codeIndex.get(String(ref || "").toUpperCase());
  return id ? games.get(id) : null;
}

function playerByToken(game, token) {
  return game.players.find((p) => p.token === token) || null;
}

/* bot driver: after each human move, bots play with a small delay for UX */
function driveBots(game) {
  if (game.status !== "playing") return;
  const current = game.players[game.turn];
  if (!current || !current.isBot) return;
  setTimeout(() => {
    try {
      if (game.status !== "playing") return;
      const mv = chooseMove(game);
      if (!mv) return;
      const [r, c] = mv;
      applyMove(game, current.seat, r, c);
      current.movesMade += 1;
      if (countOrbs(game)[current.seat] > 0) current.everHadOrbs = true;
      driveBots(game);
    } catch (e) {
      console.error("bot move failed:", e && e.message);
    }
  }, 450);
}

/* ---------------- HTTP ---------------- */

const MIME = { ".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8", ".css": "text/css; charset=utf-8", ".svg": "image/svg+xml", ".png": "image/png", ".ico": "image/x-icon" };

function sendJSON(res, code, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(code, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" });
  res.end(body);
}

function publicState(game, forToken = null) {
  const orbs = countOrbs(game);
  return {
    id: game.id,
    code: game.code,
    status: game.status,
    name: game.name,
    rows: game.board.length,
    cols: game.board[0].length,
    turn: game.turn,
    moveCount: game.moveCount,
    turnLimit: game.turnLimit,
    winner: game.winner,
    winReason: game.winReason,
    players: game.players.map((p) => ({
      seat: p.seat, name: p.name, isBot: p.isBot, color: p.color,
      active: p.active, orbs: orbs[p.seat] || 0, movesMade: p.movesMade,
      you: forToken ? p.token === forToken : undefined,
    })),
    board: game.board.map((row) => row.map((cell) => ({ o: cell.owner, n: cell.count }))),
    legalMoves: game.status === "playing" ? legalMoves(game) : [],
    lastMove: game.log.length ? game.log[game.log.length - 1] : null,
  };
}

async function readBody(req) {
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > 64 * 1024) throw new Error("body too large");
    chunks.push(chunk);
  }
  if (!chunks.length) return {};
  try { return JSON.parse(Buffer.concat(chunks).toString("utf8")); } catch { return {}; }
}

const DOCS = {
  name: "Nova Grid API",
  version: "1.0",
  endpoints: [
    { method: "POST", path: "/api/games", body: "{players: 2|3|4, fillBots?: bool, name?: string}", returns: "game state incl. your seat token for seat 0 (host)" },
    { method: "POST", path: "/api/games/:ref/join", body: "{name?: string, token?: string, seat?: int, fill?: bool}", returns: "{seat, token, state}. ref = game id or 6-char code. Join a free seat; pass fill:true to become a bot seat." },
    { method: "GET", path: "/api/games/:ref", qs: "token (optional)", returns: "public state; with token, includes your seat marker and legal moves for your turn" },
    { method: "POST", path: "/api/games/:ref/moves", body: "{token, r, c}", returns: "new state. Only the player whose turn it is may move; cells must be empty or yours." },
    { method: "GET", path: "/api/games/:ref/log", returns: "{moves:[{n,seat,r,c,at,captured}]} — full match log for replay" },
    { method: "POST", path: "/api/games/:ref/start", body: "{token (host)}", returns: "starts the match, filling empty seats with bots" },
    { method: "GET", path: "/api/games", returns: "list of open lobby games (id, code, players, seats free)" },
  ],
  rules: {
    turn: "Place one orb on any empty cell or on a cell you already own.",
    overflow: "A cell holds orbs up to its number of neighbors (corner 2, edge 3, interior 4). Exceeding it explodes the cell: it sends one orb to each neighbor, flipping them to your color — chains cascade.",
    elimination: "A player left with zero orbs after having had a turn is eliminated.",
    win: "Last player with orbs wins. If the turn limit (60 placements per player) is reached, most orbs wins.",
  },
  protocol: "All bodies are JSON. Every write carries your seat token. Values are numbers. Board coordinates are 0-indexed [r, c], r = row from top.",
};

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, "http://x");
  const p = url.pathname;

  try {
    // --- API ---
    if (p === "/api/docs") return sendJSON(res, 200, DOCS);

    if (p === "/healthz") return sendJSON(res, 200, { ok: true, games: games.size });

    if (p === "/api/games" && req.method === "GET") {
      const list = [...games.values()]
        .filter((g) => g.status === "lobby")
        .map((g) => ({
          id: g.id, code: g.code, name: g.name,
          players: g.players.length,
          freeSeats: g.players.filter((x) => !x.isBot).length - 1,
        }));
      return sendJSON(res, 200, { games: list });
    }

    if (p === "/api/games" && req.method === "POST") {
      const body = await readBody(req);
      const game = createGame(body);
      return sendJSON(res, 201, { token: game.players[0].token, state: publicState(game, game.players[0].token) });
    }

    const m = p.match(/^\/api\/games\/([^/]+)(\/[a-z_]+)?$/);
    if (m) {
      const game = findGame(m[1]);
      if (!game) return sendJSON(res, 404, { error: "no such game" });
      const sub = m[2] || "";
      const qsToken = url.searchParams.get("token");

      if (sub === "" && req.method === "GET") {
        return sendJSON(res, 200, publicState(game, qsToken));
      }
      if (sub === "/log" && req.method === "GET") {
        return sendJSON(res, 200, { id: game.id, moves: game.log, result: { winner: game.winner, reason: game.winReason } });
      }
      if (sub === "/join" && req.method === "POST") {
        const body = await readBody(req);
        let seat;
        if (body.token) {
          const existing = playerByToken(game, body.token);
          if (existing) return sendJSON(res, 200, { seat: existing.seat, token: existing.token, state: publicState(game, existing.token) });
        }
        const free = game.players.find((x) => !x.isBot && !x.joined && x.seat !== 0);
        seat = body.seat != null ? parseInt(body.seat, 10) : (free ? free.seat : undefined);
        if (seat == null || isNaN(seat) || !game.players[seat]) return sendJSON(res, 409, { error: "no free seat" });
        if (seat === 0 && !body.token) return sendJSON(res, 409, { error: "seat 0 is the host seat; create your own match or take another seat" });
        const pl = game.players[seat];
        if (pl.joined && !body.token) return sendJSON(res, 409, { error: "seat taken" });
        pl.joined = true;
        if (body.name) pl.name = String(body.name).slice(0, 24);
        if (body.fill) pl.isBot = true;
        return sendJSON(res, 200, { seat, token: pl.token, state: publicState(game, pl.token) });
      }
      if (sub === "/start" && req.method === "POST") {
        const body = await readBody(req);
        const host = playerByToken(game, body.token);
        if (!host || host.seat !== 0) return sendJSON(res, 403, { error: "host token required" });
        if (game.status !== "lobby") return sendJSON(res, 409, { error: "already started" });
        startGame(game);
        driveBots(game);
        return sendJSON(res, 200, publicState(game, host.token));
      }
      if (sub === "/moves" && req.method === "POST") {
        const body = await readBody(req);
        const pl = playerByToken(game, body.token);
        if (!pl) return sendJSON(res, 403, { error: "bad token" });
        if (game.status !== "playing") return sendJSON(res, 409, { error: `game is ${game.status}` });
        if (game.turn !== pl.seat) return sendJSON(res, 409, { error: "not your turn", turn: game.turn });
        const r = parseInt(body.r, 10), c = parseInt(body.c, 10);
        if (isNaN(r) || isNaN(c) || r < 0 || c < 0 || r >= game.board.length || c >= game.board[0].length)
          return sendJSON(res, 400, { error: "coordinates out of range" });
        const cell = game.board[r][c];
        if (cell.owner !== null && cell.owner !== pl.seat)
          return sendJSON(res, 409, { error: "cell occupied by opponent" });
        applyMove(game, pl.seat, r, c);
        pl.movesMade += 1;
        if (countOrbs(game)[pl.seat] > 0) pl.everHadOrbs = true;
        driveBots(game);
        return sendJSON(res, 200, publicState(game, pl.token));
      }
      return sendJSON(res, 404, { error: "unknown endpoint" });
    }

    // --- static UI ---
    if (req.method === "GET") {
      let file = p === "/" ? "/index.html" : p;
      file = path.normalize(file).replace(/^(\.\.[/\\])+/, "");
      const full = path.join(PUBLIC_DIR, file);
      if (full.startsWith(PUBLIC_DIR) && fs.existsSync(full) && fs.statSync(full).isFile()) {
        const ext = path.extname(full);
        res.writeHead(200, { "content-type": MIME[ext] || "application/octet-stream", "cache-control": "no-cache" });
        return fs.createReadStream(full).pipe(res);
      }
    }
    sendJSON(res, 404, { error: "not found" });
  } catch (e) {
    sendJSON(res, 500, { error: String((e && e.message) || e) });
  }
});

server.listen(PORT, () => console.log(`Nova Grid listening on :${PORT}`));
