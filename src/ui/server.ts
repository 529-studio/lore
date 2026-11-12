import { createServer, type Server } from 'node:http';
import Database from 'better-sqlite3';
import { dbPathFor } from '../db.js';
import { claimFreshness } from '../merge.js';
import { head } from '../model.js';
import { branchFor, currentSession } from '../session.js';
import { readConfig } from '../config.js';

export interface UiOptions {
  port?: number;
  host?: string;
}

export interface UiHandle {
  url: string;
  server: Server;
  close: () => Promise<void>;
}

const HTML = String.raw`<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>Lore — memory health</title>
<style>
  :root { color-scheme: dark; --bg:#0d1117; --panel:#161b22; --line:#30363d; --ink:#e6edf3; --muted:#8b949e; --accent:#58a6ff; --ok:#3fb950; --warn:#d29922; --err:#f85149; }
  * { box-sizing: border-box; }
  body { margin:0; font: 14px/1.5 ui-monospace, Menlo, monospace; background:var(--bg); color:var(--ink); }
  header { padding:20px 24px; border-bottom:1px solid var(--line); display:flex; gap:24px; align-items:baseline; flex-wrap:wrap; }
  h1 { font-size:16px; margin:0; letter-spacing:.02em; }
  .muted { color:var(--muted); }
  main { padding:24px; display:grid; gap:24px; }
  .cards { display:grid; grid-template-columns:repeat(auto-fit,minmax(140px,1fr)); gap:12px; }
  .card { background:var(--panel); border:1px solid var(--line); border-radius:8px; padding:14px; }
  .card .n { font-size:24px; font-weight:600; }
  .card .l { color:var(--muted); font-size:12px; text-transform:uppercase; letter-spacing:.06em; }
  section { background:var(--panel); border:1px solid var(--line); border-radius:8px; overflow:hidden; }
  section h2 { margin:0; padding:12px 16px; font-size:13px; text-transform:uppercase; letter-spacing:.08em; color:var(--muted); border-bottom:1px solid var(--line); }
  .controls { display:flex; gap:8px; padding:12px 16px; border-bottom:1px solid var(--line); flex-wrap:wrap; }
  input, select { background:var(--bg); color:var(--ink); border:1px solid var(--line); border-radius:6px; padding:6px 10px; font:inherit; }
  table { width:100%; border-collapse:collapse; }
  th, td { text-align:left; padding:8px 16px; border-bottom:1px solid var(--line); vertical-align:top; }
  th { color:var(--muted); font-weight:500; font-size:12px; }
  tr:last-child td { border-bottom:0; }
  .tag { display:inline-block; padding:1px 6px; border-radius:4px; font-size:11px; border:1px solid var(--line); }
  .active { color:var(--ok); } .draft { color:var(--warn); } .retracted { color:var(--err); }
  .stale { color:var(--err); } .ahead { color:var(--warn); }
  code { color:var(--accent); }
  ul.commits { list-style:none; margin:0; padding:8px 16px; }
  ul.commits li { padding:4px 0; border-bottom:1px solid var(--line); }
  ul.commits li:last-child { border-bottom:0; }
</style>
</head>
<body>
<header>
  <h1>Lore — memory health</h1>
  <span id="branch" class="muted"></span>
  <span id="remote" class="muted"></span>
</header>
<main>
  <div class="cards" id="cards"></div>
  <section>
    <h2>Claims</h2>
    <div class="controls">
      <input id="q" placeholder="filter subject, predicate, object" size="32" />
      <select id="state">
        <option value="">all states</option>
        <option value="active">active</option>
        <option value="draft">draft</option>
        <option value="retracted">retracted</option>
      </select>
      <select id="fresh">
        <option value="">any freshness</option>
        <option value="valid">valid</option>
        <option value="stale">stale</option>
        <option value="ahead">ahead of checkout</option>
      </select>
    </div>
    <table>
      <thead><tr><th>subject</th><th>predicate</th><th>object</th><th>state</th><th>freshness</th><th>authority</th></tr></thead>
      <tbody id="claims"></tbody>
    </table>
  </section>
  <section>
    <h2>Recent commits</h2>
    <ul class="commits" id="commits"></ul>
  </section>
</main>
<script>
const el = (tag, text, cls) => { const n = document.createElement(tag); if (text !== undefined) n.textContent = text; if (cls) n.className = cls; return n; };
const state = { q: '', status: '', fresh: '' };

async function loadHealth() {
  const h = await (await fetch('/api/health')).json();
  document.getElementById('branch').textContent = 'branch ' + h.branch;
  document.getElementById('remote').textContent = h.remote ? 'remote ' + h.remote : '';
  const cards = document.getElementById('cards');
  cards.replaceChildren();
  for (const [label, value, cls] of [
    ['active', h.active, 'active'], ['draft', h.draft, 'draft'],
    ['stale', h.stale, 'stale'], ['ahead', h.ahead, 'ahead'],
    ['conflicts', h.conflicts, h.conflicts ? 'stale' : ''],
  ]) {
    const card = el('div', undefined, 'card');
    card.append(el('div', String(value), 'n ' + cls), el('div', label, 'l'));
    cards.append(card);
  }
}

async function loadClaims() {
  const params = new URLSearchParams({ limit: '200' });
  if (state.q) params.set('q', state.q);
  if (state.status) params.set('status', state.status);
  if (state.fresh) params.set('fresh', state.fresh);
  const rows = await (await fetch('/api/claims?' + params)).json();
  const body = document.getElementById('claims');
  body.replaceChildren();
  for (const c of rows) {
    const tr = el('tr');
    tr.append(el('td', c.subject), el('td', c.predicate), el('td', c.object));
    const st = el('td'); st.append(el('span', c.state, 'tag ' + c.state)); tr.append(st);
    const fr = el('td'); fr.append(el('span', c.freshness, c.freshness)); tr.append(fr);
    tr.append(el('td', 'T' + c.authority));
    body.append(tr);
  }
  if (!rows.length) { const tr = el('tr'); const td = el('td', 'no claims match', 'muted'); td.colSpan = 6; tr.append(td); body.append(tr); }
}

async function loadCommits() {
  const rows = await (await fetch('/api/commits')).json();
  const list = document.getElementById('commits');
  list.replaceChildren();
  for (const c of rows) {
    const li = el('li');
    li.append(el('code', c.id.slice(0, 12)), el('span', '  ' + c.ts.replace('T', ' ').slice(0, 16) + '  '), el('span', c.message), el('span', '  ' + c.author, 'muted'));
    if (c.merge_parent_id) li.append(el('span', '  merge', 'muted'));
    list.append(li);
  }
}

let timer;
function refresh() { loadHealth(); loadClaims(); loadCommits(); }
document.getElementById('q').addEventListener('input', (e) => { state.q = e.target.value; clearTimeout(timer); timer = setTimeout(loadClaims, 150); });
document.getElementById('state').addEventListener('change', (e) => { state.status = e.target.value; loadClaims(); });
document.getElementById('fresh').addEventListener('change', (e) => { state.fresh = e.target.value; loadClaims(); });
refresh();
setInterval(refresh, 5000);
</script>
</body>
</html>`;

function json(res: import('node:http').ServerResponse, body: unknown, status = 200): void {
  const payload = JSON.stringify(body);
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
  res.end(payload);
}

export function startUi(root: string, opts: UiOptions = {}): Promise<UiHandle> {
  const db = new Database(dbPathFor(root));
  db.pragma('journal_mode = WAL');

  const server = createServer((req, res) => {
    const url = new URL(req.url ?? '/', 'http://localhost');
    if (req.method !== 'GET') {
      json(res, { error: 'read-only' }, 405);
      return;
    }

    if (url.pathname === '/') {
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' });
      res.end(HTML);
      return;
    }

    if (url.pathname === '/api/health') {
      const session = currentSession(root);
      const branch = branchFor(session);
      const tip = head(db, branch) ?? head(db, 'main');
      const counts = db.prepare('SELECT state, COUNT(*) n FROM claim GROUP BY state').all() as Array<{ state: string; n: number }>;
      const byState = new Map(counts.map((r) => [r.state, r.n]));
      let stale = 0;
      let ahead = 0;
      const ids = db
        .prepare(
          `SELECT DISTINCT e.claim_id FROM evidence e
           WHERE e.kind IN ('file','test')`,
        )
        .all() as Array<{ claim_id: string }>;
      for (const row of ids) {
        const freshness = claimFreshness(db, root, row.claim_id);
        if (freshness === 'stale') stale += 1;
        if (freshness === 'ahead') ahead += 1;
      }
      const conflicts = (db.prepare('SELECT COUNT(*) n FROM merge_conflict WHERE resolved = 0').get() as { n: number }).n;
      const config = readConfig(root);
      json(res, {
        branch,
        tip,
        active: byState.get('active') ?? 0,
        draft: byState.get('draft') ?? 0,
        retracted: byState.get('retracted') ?? 0,
        stale,
        ahead,
        conflicts,
        remote: config?.remote ? (config.remote.type === 'dir' ? config.remote.path : 'postgres') : null,
      });
      return;
    }

    if (url.pathname === '/api/claims') {
      const limit = Math.min(Number(url.searchParams.get('limit') ?? 200) || 200, 1000);
      const status = url.searchParams.get('status');
      const q = url.searchParams.get('q');
      const fresh = url.searchParams.get('fresh');
      const clauses: string[] = [];
      const params: unknown[] = [];
      if (status) {
        clauses.push('state = ?');
        params.push(status);
      }
      if (q) {
        clauses.push('(subject_id LIKE ? OR predicate LIKE ? OR object_json LIKE ?)');
        params.push(`%${q}%`, `%${q}%`, `%${q}%`);
      }
      const where = clauses.length ? `WHERE ${clauses.join(' AND ')}` : '';
      const rows = db
        .prepare(`SELECT * FROM claim ${where} ORDER BY tx_from DESC LIMIT ?`)
        .all(...params, limit) as Array<Record<string, unknown>>;

      const out = rows
        .map((row) => {
          const freshness = claimFreshness(db, root, String(row.id));
          return {
            id: row.id,
            subject: row.subject_id,
            predicate: row.predicate,
            object: (() => {
              try {
                return String(JSON.parse(String(row.object_json)));
              } catch {
                return String(row.object_json);
              }
            })(),
            state: row.state,
            authority: row.authority,
            author: row.author,
            freshness,
          };
        })
        .filter((row) => !fresh || row.freshness === fresh);

      json(res, out);
      return;
    }

    if (url.pathname === '/api/commits') {
      const rows = db
        .prepare('SELECT id, parent_id, merge_parent_id, message, author, ts FROM memory_commit ORDER BY ts DESC LIMIT 50')
        .all();
      json(res, rows);
      return;
    }

    if (url.pathname === '/api/conflicts') {
      const rows = db
        .prepare('SELECT * FROM merge_conflict WHERE resolved = 0 ORDER BY id DESC')
        .all();
      json(res, rows);
      return;
    }

    json(res, { error: 'not found' }, 404);
  });

  const host = opts.host ?? '127.0.0.1';
  const port = opts.port ?? 4173;

  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, host, () => {
      const address = server.address();
      const actual = typeof address === 'object' && address ? address.port : port;
      const url = `http://${host}:${actual}`;
      resolve({
        url,
        server,
        close: () =>
          new Promise<void>((done) => {
            server.close(() => {
              db.close();
              done();
            });
          }),
      });
    });
  });
}
