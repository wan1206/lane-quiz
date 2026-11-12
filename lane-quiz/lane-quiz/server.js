// Lane Quiz Run: game server. Serves the game page and runs live sessions over WebSockets.
const http = require("http"), fs = require("fs"), path = require("path");
const { WebSocketServer } = require("ws");

const QS = JSON.parse(fs.readFileSync(path.join(__dirname, "questions.json"), "utf8"));
const TL = 5;          // seconds to answer
const MAXP = 50;       // players per game
const GRACE = 1000;    // ms allowed for late network packets
const PAGE = path.join(__dirname, "public", "index.html");

const server = http.createServer((req, res) => {
  if (req.url === "/healthz") { res.end("ok"); return; }
  res.writeHead(200, { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-cache" });
  res.end(fs.readFileSync(PAGE));
});
const wss = new WebSocketServer({ server, maxPayload: 2048 });
const games = new Map();
const send = (ws, o) => { if (ws && ws.readyState === 1) ws.send(JSON.stringify(o)); };
const all = (g, o) => { send(g.host, o); g.players.forEach((_, w) => send(w, o)); };
const newCode = () => { let c; do c = String(1000 + Math.floor(Math.random() * 9000)); while (games.has(c)); return c; };
const lobby = g => { send(g.host, { t: "lobby", players: [...g.players.values()].map(p => p.name), max: MAXP });
  g.players.forEach((_, w) => send(w, { t: "lobby", n: g.players.size })); };

function ask(g) {
  const q = QS[g.qi];
  g.phase = "q";
  g.ord = [0, 1, 2, 3].sort(() => Math.random() - 0.5);       // lane order
  const all4 = [q.a, ...q.w];
  g.ans = g.ord.map(o => all4[o]);
  g.cor = g.ord.indexOf(0);                                    // correct lane (never sent to clients early)
  g.players.forEach(p => { p.pick = null; });
  g.t0 = Date.now();
  all(g, { t: "q", qi: g.qi, total: QS.length, text: q.q, answers: g.ans, tl: TL });
  g.timer = setTimeout(() => result(g), TL * 1000 + GRACE);
}

function result(g) {
  g.phase = "r";
  const d = [0, 0, 0, 0];
  g.players.forEach(p => {
    const k = p.pick; let pts = 0;
    if (k) {
      d[k.lane]++;
      const lock = Math.max(0, Math.min(TL, TL - (k.at - g.t0) / 1000));   // seconds left when locked in
      if (k.lane === g.cor && lock > 0) {
        p.st++; p.c++; p.tt += TL - lock;
        pts = 100 + Math.round(lock / TL * 10) * 10 + Math.min(p.st - 1, 5) * 20;
        p.s += pts; p.hist[g.qi] = true;
      } else p.st = 0;
    } else p.st = 0;
    p.pts = pts; p.picked = !!k;
  });
  const rows = [...g.players.values()].sort((a, b) => b.s - a.s);
  rows.forEach((p, i) => { p.rank = i + 1; });
  g.players.forEach((p, w) => send(w, { t: "r", pts: p.pts, s: p.s, rank: p.rank, n: rows.length, picked: p.picked, correct: g.ans[g.cor] }));
  send(g.host, { t: "r", text: QS[g.qi].q, answers: g.ans, cor: g.cor, d, n: rows.length, top: rows.slice(0, 5).map(p => [p.name, p.s]) });
  g.qi++;
  g.timer = setTimeout(() => (g.qi >= QS.length ? end(g) : ask(g)), 4500);
}

function end(g) {
  g.phase = "end";
  const rows = [...g.players.values()].sort((a, b) => b.s - a.s);
  rows.forEach((p, i) => { p.rank = i + 1; });
  const acc = QS.map((q, i) => ({ q: q.q, pct: rows.length ? Math.round(rows.filter(p => p.hist[i]).length / rows.length * 100) : 0 }));
  send(g.host, { t: "end", acc, rows: rows.map(p => ({ n: p.name, s: p.s, c: p.c, avg: p.c ? +(p.tt / p.c).toFixed(1) : null })), total: QS.length });
  g.players.forEach((p, w) => send(w, { t: "end", rank: p.rank, s: p.s, n: rows.length }));
  g.timer = setTimeout(() => games.delete(g.code), 30 * 60 * 1000);
}

wss.on("connection", ws => {
  ws.alive = true;
  ws.on("pong", () => { ws.alive = true; });
  ws.on("message", raw => {
    let m; try { m = JSON.parse(raw); } catch { return; }
    if (m.t === "host" && !ws.g) {
      const g = { code: newCode(), host: ws, players: new Map(), phase: "lobby", qi: 0 };
      games.set(g.code, g); ws.g = g; ws.role = "h";
      send(ws, { t: "hosted", code: g.code }); lobby(g);
    } else if (m.t === "join" && !ws.g) {
      const g = games.get(String(m.code || "")), name = String(m.name || "").trim().slice(0, 14);
      if (!g) return send(ws, { t: "err", m: "Game not found. Check the code." });
      if (g.phase !== "lobby") return send(ws, { t: "err", m: "This game has already started." });
      if (g.players.size >= MAXP) return send(ws, { t: "err", m: "This game is full (" + MAXP + " players)." });
      if (!name) return send(ws, { t: "err", m: "Please enter a name." });
      g.players.set(ws, { name, s: 0, st: 0, c: 0, tt: 0, pick: null, hist: [] });
      ws.g = g; ws.role = "p"; send(ws, { t: "joined", name }); lobby(g);
    } else if (m.t === "start" && ws.role === "h" && ws.g.phase === "lobby" && ws.g.players.size) {
      ask(ws.g);
    } else if (m.t === "pick" && ws.role === "p") {
      const g = ws.g, now = Date.now(), l = Number(m.lane);
      if (g.phase === "q" && now <= g.t0 + TL * 1000 + GRACE - 200 && l >= 0 && l < 4) g.players.get(ws).pick = { lane: l | 0, at: now };
    }
  });
  ws.on("close", () => {
    const g = ws.g; if (!g) return;
    if (ws.role === "h") { clearTimeout(g.timer); g.players.forEach((_, w) => send(w, { t: "err", m: "The host left the game." })); games.delete(g.code); }
    else if (g.phase === "lobby") { g.players.delete(ws); lobby(g); }
  });
});
setInterval(() => wss.clients.forEach(ws => { if (!ws.alive) return ws.terminate(); ws.alive = false; ws.ping(); }), 25000);

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log("Lane Quiz Run listening on port " + PORT));
