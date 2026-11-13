import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { randomBytes } from 'node:crypto';
import { openDb } from '../db.js';
import { claimFreshness } from '../merge.js';
import { head } from '../model.js';
import { branchFor, currentSession } from '../session.js';
import { readConfig } from '../config.js';
import { ActionError, approveDrafts, attestClaim, rejectDraft, revertCommit } from '../actions.js';
import { resolvePrincipal, teamMode } from '../identity.js';
import { describePolicy } from '../policy.js';
import { installCanon } from '../canon/index.js';

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
<title>Lore — memory</title>
<style>
  :root { color-scheme: dark; --bg:#0d1117; --panel:#161b22; --line:#30363d; --ink:#e6edf3; --muted:#8b949e; --accent:#58a6ff; --ok:#3fb950; --warn:#d29922; --err:#f85149; }
  * { box-sizing: border-box; }
  body { margin:0; font: 14px/1.5 ui-monospace, Menlo, monospace; background:var(--bg); color:var(--ink); }
  header { padding:16px 24px; border-bottom:1px solid var(--line); display:flex; gap:20px; align-items:baseline; flex-wrap:wrap; }
  h1 { font-size:15px; margin:0; letter-spacing:.02em; }
  nav { display:flex; gap:6px; }
  nav button { background:transparent; border:1px solid var(--line); color:var(--muted); padding:4px 10px; border-radius:6px; cursor:pointer; font:inherit; }
  nav button.on { color:var(--ink); border-color:var(--accent); }
  .muted { color:var(--muted); }
  main { padding:24px; display:grid; gap:24px; }
  section { display:none; }
  section.on { display:grid; gap:24px; }
  .cards { display:grid; grid-template-columns:repeat(auto-fit,minmax(140px,1fr)); gap:12px; }
  .card { background:var(--panel); border:1px solid var(--line); border-radius:8px; padding:14px; }
  .card .n { font-size:24px; font-weight:600; }
  .card .l { color:var(--muted); font-size:12px; text-transform:uppercase; letter-spacing:.06em; }
  .panel { background:var(--panel); border:1px solid var(--line); border-radius:8px; overflow:hidden; }
  .panel h2 { margin:0; padding:12px 16px; font-size:13px; text-transform:uppercase; letter-spacing:.08em; color:var(--muted); border-bottom:1px solid var(--line); }
  .controls { display:flex; gap:8px; padding:12px 16px; border-bottom:1px solid var(--line); flex-wrap:wrap; }
  input, select { background:var(--bg); color:var(--ink); border:1px solid var(--line); border-radius:6px; padding:6px 10px; font:inherit; }
  button.act { background:var(--bg); color:var(--ink); border:1px solid var(--line); border-radius:6px; padding:4px 10px; cursor:pointer; font:inherit; }
  button.act:hover { border-color:var(--accent); }
  button.ok { color:var(--ok); } button.bad { color:var(--err); }
  table { width:100%; border-collapse:collapse; }
  th, td { text-align:left; padding:8px 16px; border-bottom:1px solid var(--line); vertical-align:top; }
  th { color:var(--muted); font-weight:500; font-size:12px; }
  tr:last-child td { border-bottom:0; }
  .tag { display:inline-block; padding:1px 6px; border-radius:4px; font-size:11px; border:1px solid var(--line); }
  .active { color:var(--ok); } .draft { color:var(--warn); } .retracted { color:var(--err); }
  .stale { color:var(--err); } .ahead { color:var(--warn); }
  code { color:var(--accent); }
  .draft-card { border-bottom:1px solid var(--line); padding:14px 16px; display:grid; gap:6px; }
  .draft-card:last-child { border-bottom:0; }
  .draft-card .obj { font-size:15px; }
  .draft-card .meta { color:var(--muted); font-size:12px; }
  .draft-card .actions { display:flex; gap:8px; margin-top:4px; }
  .banner { margin:0 24px; padding:10px 14px; border-radius:6px; border:1px solid var(--line); display:none; }
  .banner.err { display:block; border-color:var(--err); color:var(--err); }
  .banner.ok { display:block; border-color:var(--ok); color:var(--ok); }
  .kv { display:grid; grid-template-columns:180px 1fr; gap:6px 16px; padding:14px 16px; }
  .kv div:nth-child(odd) { color:var(--muted); }
</style>
</head>
<body>
<header>
  <h1>Lore</h1>
  <nav>
    <button data-tab="health" class="on">Health</button>
    <button data-tab="review">Review</button>
    <button data-tab="undo">Undo</button>
    <button data-tab="settings">Settings</button>
  </nav>
  <span id="branch" class="muted"></span>
</header>
<div id="banner" class="banner"></div>
<main>
  <section id="tab-health" class="on">
    <div class="cards" id="cards"></div>
    <div class="panel">
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
    </div>
  </section>

  <section id="tab-review">
    <div class="panel">
      <h2>What the agent learned — needs your call</h2>
      <div class="controls">
        <button class="act ok" id="approve-all">Approve all</button>
        <span class="muted" id="review-count"></span>
      </div>
      <div id="drafts"></div>
    </div>
  </section>

  <section id="tab-undo">
    <div class="panel">
      <h2>Sessions and commits</h2>
      <ul id="commits" style="list-style:none;margin:0;padding:0"></ul>
    </div>
  </section>

  <section id="tab-settings">
    <div class="panel">
      <h2>Identity and policy</h2>
      <div class="kv" id="settings"></div>
    </div>
  </section>
</main>
<script>
const CSRF = '__CSRF__';
const $ = (id) => document.getElementById(id);
const el = (tag, text, cls) => { const n = document.createElement(tag); if (text !== undefined) n.textContent = text; if (cls) n.className = cls; return n; };

function banner(message, kind) {
  const b = $('banner');
  b.textContent = message || '';
  b.className = 'banner' + (message ? ' ' + kind : '');
  if (message) setTimeout(() => { b.className = 'banner'; }, 5000);
}

async function api(path, body) {
  const res = await fetch(path, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-lore-csrf': CSRF },
    body: JSON.stringify(body || {}),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || ('HTTP ' + res.status));
  return data;
}

function show(tab) {
  for (const b of document.querySelectorAll('nav button')) b.classList.toggle('on', b.dataset.tab === tab);
  for (const s of document.querySelectorAll('main section')) s.classList.toggle('on', s.id === 'tab-' + tab);
  if (tab === 'health') refreshHealth();
  if (tab === 'review') loadReview();
  if (tab === 'undo') loadCommits();
  if (tab === 'settings') loadSettings();
}

async function loadHealth() {
  const h = await (await fetch('/api/health')).json();
  $('branch').textContent = 'branch ' + h.branch;
  const cards = $('cards'); cards.replaceChildren();
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
  const q = $('q').value; if (q) params.set('q', q);
  const st = $('state').value; if (st) params.set('status', st);
  const fr = $('fresh').value; if (fr) params.set('fresh', fr);
  const rows = await (await fetch('/api/claims?' + params)).json();
  const body = $('claims'); body.replaceChildren();
  for (const c of rows) {
    const tr = el('tr');
    tr.append(el('td', c.subject), el('td', c.predicate), el('td', c.object));
    const s = el('td'); s.append(el('span', c.state, 'tag ' + c.state)); tr.append(s);
    const f = el('td'); f.append(el('span', c.freshness, c.freshness)); tr.append(f);
    tr.append(el('td', 'T' + c.authority));
    body.append(tr);
  }
  if (!rows.length) { const tr = el('tr'); const td = el('td', 'no claims match', 'muted'); td.colSpan = 6; tr.append(td); body.append(tr); }
}

async function loadReview() {
  const drafts = await (await fetch('/api/claims?status=draft&limit=200')).json();
  const box = $('drafts'); box.replaceChildren();
  $('review-count').textContent = drafts.length ? drafts.length + ' draft(s)' : '';
  $('approve-all').disabled = !drafts.length;
  if (!drafts.length) { box.append(el('div', 'Nothing to review. The agent has not proposed anything new.', 'muted')); box.style.padding = '16px'; return; }
  box.style.padding = '0';
  for (const c of drafts) {
    const card = el('div', undefined, 'draft-card');
    card.append(el('div', c.subject + ' — ' + c.predicate, 'meta'));
    card.append(el('div', c.object, 'obj'));
    card.append(el('div', 'suggested by ' + c.author + ' · T' + c.authority + ' · ' + c.id, 'meta'));
    if (c.evidence && c.evidence.length) {
      card.append(el('div', c.evidence.map((e) => e.kind + ':' + e.ref).join(', '), 'meta'));
    }
    const actions = el('div', undefined, 'actions');
    const approve = el('button', 'Approve', 'act ok');
    approve.onclick = async () => {
      try { await api('/api/approve', { ids: [c.id] }); banner('Approved ' + c.id, 'ok'); loadReview(); }
      catch (e) { banner(e.message, 'err'); }
    };
    const reject = el('button', 'Reject', 'act bad');
    reject.onclick = async () => {
      const reason = window.prompt('Reason (optional):') || '';
      try { await api('/api/reject', { claim: c.id, reason }); banner('Rejected ' + c.id, 'ok'); loadReview(); }
      catch (e) { banner(e.message, 'err'); }
    };
    actions.append(approve, reject);
    card.append(actions);
    box.append(card);
  }
}

async function loadCommits() {
  const rows = await (await fetch('/api/commits')).json();
  const list = $('commits'); list.replaceChildren();
  for (const c of rows) {
    const li = el('li', undefined, 'draft-card');
    li.append(el('div', c.message, 'obj'));
    li.append(el('div', c.id.slice(0, 12) + ' · ' + c.ts.replace('T', ' ').slice(0, 16) + ' · ' + c.author + (c.merge_parent_id ? ' · merge' : ''), 'meta'));
    li.append(el('div', c.entries + ' claim change(s)', 'meta'));
    const actions = el('div', undefined, 'actions');
    const undo = el('button', 'Undo this commit', 'act bad');
    undo.onclick = async () => {
      if (!window.confirm('Revert ' + c.id.slice(0, 12) + '? A new commit is created; history is kept.')) return;
      try { await api('/api/revert', { commit: c.id }); banner('Reverted ' + c.id.slice(0, 12), 'ok'); loadCommits(); }
      catch (e) { banner(e.message, 'err'); }
    };
    actions.append(undo);
    li.append(actions);
    list.append(li);
  }
  if (!rows.length) list.append(el('li', 'no commits', 'muted'));
}

async function loadSettings() {
  const data = await (await fetch('/api/identity')).json();
  const box = $('settings'); box.replaceChildren();
  for (const [k, v] of [
    ['identity', data.principal || data.error || '—'],
    ['role', data.role || '—'],
    ['source', data.source || '—'],
    ['team mode', data.team ? 'on' : 'off'],
    ['policy', data.policy || '—'],
    ['remote', data.remote || 'none'],
    ['branch', data.branch || '—'],
  ]) {
    box.append(el('div', k), el('div', String(v)));
  }
}

async function refreshHealth() { await loadHealth(); await loadClaims(); }

for (const b of document.querySelectorAll('nav button')) b.onclick = () => show(b.dataset.tab);
$('q').addEventListener('input', () => { clearTimeout(window.__t); window.__t = setTimeout(loadClaims, 150); });
$('state').addEventListener('change', loadClaims);
$('fresh').addEventListener('change', loadClaims);
$('approve-all').onclick = async () => {
  const drafts = await (await fetch('/api/claims?status=draft&limit=200')).json();
  if (!drafts.length) return;
  if (!window.confirm('Approve all ' + drafts.length + ' draft(s)?')) return;
  try { await api('/api/approve', { ids: drafts.map((d) => d.id) }); banner('Approved ' + drafts.length + ' claim(s)', 'ok'); loadReview(); }
  catch (e) { banner(e.message, 'err'); }
};

refreshHealth();
</script>
</body>
</html>`;

function json(res: ServerResponse, body: unknown, status = 200): void {
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
  res.end(JSON.stringify(body));
}

function readBody(req: IncomingMessage): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    let raw = '';
    req.on('data', (chunk) => {
      raw += chunk;
      if (raw.length > 1_000_000) reject(new Error('body too large'));
    });
    req.on('end', () => {
      try {
        resolve(raw ? (JSON.parse(raw) as Record<string, unknown>) : {});
      } catch {
        reject(new Error('invalid JSON body'));
      }
    });
    req.on('error', reject);
  });
}

function sendActionError(res: ServerResponse, error: unknown): void {
  if (error instanceof ActionError) {
    const status = error.code === 'not_found' ? 404 : error.code === 'policy' ? 403 : 400;
    json(res, { error: error.message, code: error.code }, status);
    return;
  }
  json(res, { error: error instanceof Error ? error.message : String(error) }, 500);
}

export function startUi(root: string, opts: UiOptions = {}): Promise<UiHandle> {
  installCanon();
  const db = openDb(root);
  db.pragma('journal_mode = WAL');
  const csrf = randomBytes(24).toString('base64url');
  const host = opts.host ?? '127.0.0.1';
  let actualPort = opts.port ?? 4173;

  const server = createServer((req, res) => {
    void (async () => {
      const url = new URL(req.url ?? '/', 'http://localhost');
      const session = currentSession(root);
      const ref = branchFor(session);

      if (req.method === 'POST') {
        if (req.headers['x-lore-csrf'] !== csrf) {
          json(res, { error: 'invalid CSRF token' }, 403);
          return;
        }
        const origin = req.headers.origin;
        if (origin) {
          const allowed = [`http://127.0.0.1:${actualPort}`, `http://localhost:${actualPort}`, `http://[::1]:${actualPort}`];
          if (!allowed.includes(origin)) {
            json(res, { error: 'cross-origin write rejected' }, 403);
            return;
          }
        }

        const body = await readBody(req);
        try {
          if (url.pathname === '/api/approve') {
            const ids = Array.isArray(body.ids) ? body.ids.map(String) : body.claim ? [String(body.claim)] : [];
            json(res, approveDrafts(db, root, ref, ids));
            return;
          }
          if (url.pathname === '/api/reject') {
            json(res, rejectDraft(db, root, ref, String(body.claim), body.reason ? String(body.reason) : undefined));
            return;
          }
          if (url.pathname === '/api/revert') {
            json(res, revertCommit(db, root, ref, String(body.commit)));
            return;
          }
          if (url.pathname === '/api/attest') {
            const verdict = body.verdict === 'disagree' ? 'disagree' : 'agree';
            json(res, attestClaim(db, root, ref, String(body.claim), verdict, body.reason ? String(body.reason) : undefined));
            return;
          }
          json(res, { error: 'not found' }, 404);
        } catch (error) {
          sendActionError(res, error);
        }
        return;
      }

      if (req.method !== 'GET') {
        json(res, { error: 'read-only' }, 405);
        return;
      }

      if (url.pathname === '/') {
        res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' });
        res.end(HTML.replace('__CSRF__', csrf));
        return;
      }

      if (url.pathname === '/api/health') {
        const tip = head(db, ref) ?? head(db, 'main');
        const counts = db.prepare('SELECT state, COUNT(*) n FROM claim GROUP BY state').all() as Array<{ state: string; n: number }>;
        const byState = new Map(counts.map((r) => [r.state, r.n]));
        let stale = 0;
        let ahead = 0;
        const ids = db.prepare("SELECT DISTINCT claim_id FROM evidence WHERE kind IN ('file','test')").all() as Array<{ claim_id: string }>;
        for (const row of ids) {
          const freshness = claimFreshness(db, root, row.claim_id);
          if (freshness === 'stale') stale += 1;
          if (freshness === 'ahead') ahead += 1;
        }
        const conflicts = (db.prepare('SELECT COUNT(*) n FROM merge_conflict WHERE resolved = 0').get() as { n: number }).n;
        json(res, {
          branch: ref,
          tip,
          active: byState.get('active') ?? 0,
          draft: byState.get('draft') ?? 0,
          retracted: byState.get('retracted') ?? 0,
          stale,
          ahead,
          conflicts,
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
          .prepare(`SELECT * FROM claim ${where} ORDER BY tx_from DESC, rowid DESC LIMIT ?`)
          .all(...params, limit) as Array<Record<string, unknown>>;

        const out = rows
          .map((row) => {
            const id = String(row.id);
            const freshness = claimFreshness(db, root, id);
            const evidence = db
              .prepare('SELECT kind, ref, status FROM evidence WHERE claim_id = ? ORDER BY kind, ref')
              .all(id) as Array<{ kind: string; ref: string; status: string }>;
            return {
              id,
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
              evidence,
            };
          })
          .filter((row) => !fresh || row.freshness === fresh);

        json(res, out);
        return;
      }

      if (url.pathname === '/api/commits') {
        const rows = db
          .prepare(
            `SELECT c.id, c.parent_id, c.merge_parent_id, c.message, c.author, c.ts,
                    (SELECT COUNT(*) FROM commit_entry e WHERE e.commit_id = c.id) AS entries
             FROM memory_commit c ORDER BY c.ts DESC LIMIT 50`,
          )
          .all();
        json(res, rows);
        return;
      }

      if (url.pathname === '/api/identity') {
        let principal: string | null = null;
        let role: string | null = null;
        let source: string | null = null;
        let error: string | null = null;
        try {
          const p = resolvePrincipal();
          principal = p.id;
          role = p.role;
          source = p.source;
        } catch (err) {
          error = err instanceof Error ? err.message : String(err);
        }
        const config = readConfig(root);
        json(res, {
          principal,
          role,
          source,
          error,
          team: teamMode(),
          policy: describePolicy(root),
          remote: config?.remote
            ? config.remote.type === 'dir'
              ? config.remote.path
              : `postgres${config.remote.url_env ? ` ($${config.remote.url_env})` : ''}`
            : null,
          branch: ref,
        });
        return;
      }

      if (url.pathname === '/api/conflicts') {
        json(res, db.prepare('SELECT * FROM merge_conflict WHERE resolved = 0 ORDER BY id DESC').all());
        return;
      }

      json(res, { error: 'not found' }, 404);
    })();
  });

  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(opts.port ?? 4173, host, () => {
      const address = server.address();
      actualPort = typeof address === 'object' && address ? address.port : (opts.port ?? 4173);
      resolve({
        url: `http://${host}:${actualPort}`,
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
