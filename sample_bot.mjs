#!/usr/bin/env node
/**
 * Nova Grid sample bot — a basic agent player over the HTTP/JSON API.
 *
 * Usage:
 *   node sample_bot.mjs <server-url> [match-code] [bot-name]
 *
 *   No match-code: creates a new 2-player match (seat 2 filled by this bot after
 *   the host starts — here the host is the bot itself, so it starts immediately).
 *   With match-code: joins the first free seat of someone else's match.
 *
 * Strategy: greedy 1-ply — prefer moves that explode and flip opponent orbs,
 * keep a presence on corners (they are the cheapest cells to overflow), avoid
 * feeding an opponent's almost-critical cell. Basic on purpose: it is a
 * starting point, not a strong player.
 */

const BASE = (process.argv[2] || "http://localhost:3000").replace(/\/$/, "");
const CODE = process.argv[3] || null;
const NAME = process.argv[4] || "sample-bot";

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function api(path, opts = {}) {
  const res = await fetch(BASE + path, {
    headers: { "content-type": "application/json" },
    ...opts,
    body: opts.body ? JSON.stringify(opts.body) : undefined,
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(`${path} → ${res.status} ${data.error || ""}`.trim());
  return data;
}

/* ---- same greedy heuristic as the built-in bot ---- */

const cap = (board, r, c) =>
  (r === 0 || r === board.length - 1 ? 1 : 2) + (c === 0 || c === board[0].length - 1 ? 1 : 2);

function nbrs(board, r, c) {
  const out = [];
  if (r > 0) out.push([r - 1, c]);
  if (r < board.length - 1) out.push([r + 1, c]);
  if (c > 0) out.push([r, c - 1]);
  if (c < board[0].length - 1) out.push([r, c + 1]);
  return out;
}

function scoreMove(state, seat, r, c) {
  const board = state.board.map((row) => row.map((cell) => ({ o: cell.o, n: cell.n })));
  const before = {};
  for (const row of board) for (const cell of row) if (cell.o != null) before[cell.o] = (before[cell.o] || 0) + cell.n;
  board[r][c].o = seat; board[r][c].n += 1;
  let captured = 0;
  for (let guard = 0; guard < 1000; guard++) {
    let exploded = false;
    for (let i = 0; i < board.length; i++) for (let j = 0; j < board[i].length; j++) {
      const b = board[i][j];
      if (b.n > cap(board, i, j)) {
        exploded = true;
        b.n -= cap(board, i, j);
        if (b.n === 0) b.o = null;
        for (const [ni, nj] of nbrs(board, i, j)) {
          if (board[ni][nj].o != null && board[ni][nj].o !== seat) captured++;
          board[ni][nj].o = seat;
          board[ni][nj].n += 1;
        }
      }
    }
    if (!exploded) break;
  }
  let mine = 0;
  for (const row of board) for (const cell of row) if (cell.o === seat) mine += cell.n;
  let oppRisk = 0;
  for (let i = 0; i < board.length; i++) for (let j = 0; j < board[i].length; j++) {
    const b = board[i][j];
    if (b.o != null && b.o !== seat && b.n === cap(board, i, j) - 1) oppRisk += 2;
  }
  const corner = (r === 0 || r === board.length - 1) && (c === 0 || c === board[0].length - 1) ? 3 : 0;
  void before;
  return captured * 12 + (mine - (before[seat] || 0)) * 2 + corner - oppRisk;
}

function chooseMove(state, seat) {
  let best = null, bestScore = -Infinity;
  for (const [r, c] of state.legalMoves) {
    const s = scoreMove(state, seat, r, c) + Math.random() * 0.5;
    if (s > bestScore) { bestScore = s; best = [r, c]; }
  }
  return best;
}

/* ---- main loop ---- */

async function main() {
  let token, state;
  if (CODE) {
    const j = await api(`/api/games/${CODE}/join`, { method: "POST", body: { name: NAME } });
    token = j.token; state = j.state;
    console.log(`joined ${state.code} as seat ${j.seat}`);
  } else {
    const c = await api("/api/games", { method: "POST", body: { players: 2, name: `${NAME}'s match` } });
    token = c.token; state = c.state;
    console.log(`created match ${state.code} — invite: ${BASE}/?join=${state.code}`);
    state = await api(`/api/games/${state.code}/start`, { method: "POST", body: { token } });
  }
  const seat = state.players.findIndex((p) => p.you);
  console.log(`playing seat ${seat} (${state.players[seat].color})`);

  for (;;) {
    state = await api(`/api/games/${state.code}?token=${token}`);
    if (state.status === "finished") break;
    if (state.status === "playing" && state.turn === seat) {
      const mv = chooseMove(state, seat);
      if (!mv) { await sleep(500); continue; }
      state = await api(`/api/games/${state.code}/moves`, { method: "POST", body: { token, r: mv[0], c: mv[1] } });
      console.log(`move #${state.moveCount}: (${mv[0]},${mv[1]})`);
    }
    await sleep(700);
  }
  const me = state.players[seat];
  const verdict = state.winner === seat ? "WIN" : state.winner == null ? "DRAW" : "LOSS";
  console.log(`${verdict} — ${state.winReason} | orbs: ` +
    state.players.map((p) => `${p.name}:${p.orbs}`).join(" "));
  console.log(`replay: GET ${BASE}/api/games/${state.code}/log`);
}

main().catch((e) => { console.error(e.message); process.exit(1); });
