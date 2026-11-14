import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { randomBytes } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { parse } from 'yaml';
import { openDb } from '../db.js';
import { claimFreshness } from '../merge.js';
import { head, inBranch, makeCommit, supersedeClaim, upsertClaim, type ClaimRow } from '../model.js';
import { branchFor, currentSession } from '../session.js';
import { readConfig } from '../config.js';
import { ActionError, approveDrafts, attestClaim, rejectDraft, revertCommit } from '../actions.js';
import { resolvePrincipal, teamMode } from '../identity.js';
import { describePolicy } from '../policy.js';
import { installCanon } from '../canon/index.js';
import { explainClaim } from '../canon/explain.js';
import { gitHead } from '../util/git.js';

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
<title>Lore — Memory & Knowledge Hub</title>
<style>
  :root {
    color-scheme: dark;
    --bg:#0d1117; --panel:#161b22; --line:#30363d; --ink:#e6edf3;
    --muted:#8b949e; --accent:#58a6ff; --ok:#3fb950; --warn:#d29922;
    --err:#f85149; --purple:#bc8cff; --card-hover:#1c2128;
  }
  * { box-sizing: border-box; }
  body { margin:0; font: 14px/1.5 ui-monospace, Menlo, monospace; background:var(--bg); color:var(--ink); }
  header { padding:14px 24px; border-bottom:1px solid var(--line); display:flex; justify-content:space-between; align-items:center; flex-wrap:wrap; gap:16px; background:var(--panel); }
  .brand { display:flex; align-items:baseline; gap:12px; }
  h1 { font-size:16px; margin:0; letter-spacing:.03em; font-weight:700; color:var(--ink); }
  .brand-sub { font-size:12px; color:var(--muted); }
  nav { display:flex; gap:6px; }
  nav button { background:transparent; border:1px solid var(--line); color:var(--muted); padding:5px 12px; border-radius:6px; cursor:pointer; font:inherit; transition:all .15s; }
  nav button:hover { color:var(--ink); border-color:var(--muted); }
  nav button.on { color:var(--ink); border-color:var(--accent); background:rgba(88,166,255,0.1); }
  .hdr-right { display:flex; align-items:center; gap:12px; }
  .muted { color:var(--muted); }
  main { padding:24px; display:grid; gap:24px; max-width:1400px; margin:0 auto; width:100%; }
  section { display:none; }
  section.on { display:grid; gap:20px; }
  
  /* Metric Cards */
  .cards { display:grid; grid-template-columns:repeat(auto-fit,minmax(180px,1fr)); gap:12px; }
  .card { background:var(--panel); border:1px solid var(--line); border-radius:8px; padding:14px 16px; position:relative; }
  .card .n { font-size:26px; font-weight:700; line-height:1.2; }
  .card .l { color:var(--muted); font-size:11px; text-transform:uppercase; letter-spacing:.08em; font-weight:600; margin-top:4px; }
  .card .desc { font-size:11px; color:var(--muted); margin-top:2px; }
  
  /* Filter & Controls */
  .panel { background:var(--panel); border:1px solid var(--line); border-radius:8px; overflow:hidden; }
  .panel-header { display:flex; justify-content:space-between; align-items:center; padding:12px 16px; border-bottom:1px solid var(--line); flex-wrap:wrap; gap:10px; }
  .panel h2 { margin:0; font-size:13px; text-transform:uppercase; letter-spacing:.08em; color:var(--muted); }
  .controls { display:flex; gap:8px; padding:12px 16px; border-bottom:1px solid var(--line); flex-wrap:wrap; align-items:center; background:rgba(22,27,34,0.5); }
  
  /* Category Pills */
  .pills { display:flex; gap:6px; padding:10px 16px; border-bottom:1px solid var(--line); background:#11151c; overflow-x:auto; }
  .pill { background:transparent; border:1px solid var(--line); color:var(--muted); padding:3px 10px; border-radius:20px; font-size:12px; cursor:pointer; white-space:nowrap; }
  .pill:hover { color:var(--ink); }
  .pill.on { background:var(--accent); color:#000; font-weight:600; border-color:var(--accent); }
  
  input, select, textarea { background:var(--bg); color:var(--ink); border:1px solid var(--line); border-radius:6px; padding:6px 10px; font:inherit; }
  button.act { background:var(--bg); color:var(--ink); border:1px solid var(--line); border-radius:6px; padding:5px 12px; cursor:pointer; font:inherit; transition:border-color .15s; }
  button.act:hover { border-color:var(--accent); }
  button.primary { background:var(--accent); color:#000; font-weight:600; border-color:var(--accent); }
  button.primary:hover { opacity:.9; }
  button.ok { color:var(--ok); border-color:rgba(63,185,80,0.4); }
  button.bad { color:var(--err); border-color:rgba(248,81,73,0.4); }
  
  /* Knowledge Cards View */
  .grid-view { display:grid; grid-template-columns:repeat(auto-fill, minmax(360px, 1fr)); gap:14px; padding:16px; }
  .k-card { background:var(--bg); border:1px solid var(--line); border-radius:8px; padding:14px; display:flex; flex-direction:column; gap:8px; transition:border-color .15s, background .15s; cursor:pointer; }
  .k-card:hover { border-color:var(--accent); background:var(--card-hover); }
  .k-hdr { display:flex; justify-content:space-between; align-items:flex-start; gap:8px; }
  .k-subj { font-weight:600; color:var(--accent); word-break:break-all; font-size:13px; }
  .k-pred { font-size:11px; text-transform:uppercase; letter-spacing:.05em; color:var(--purple); }
  .k-obj { font-size:14px; color:var(--ink); background:var(--panel); padding:8px 10px; border-radius:6px; border:1px solid var(--line); word-break:break-word; max-height:120px; overflow-y:auto; }
  .k-foot { display:flex; justify-content:space-between; align-items:center; font-size:11px; color:var(--muted); margin-top:auto; padding-top:4px; }
  .k-tags { display:flex; gap:6px; align-items:center; flex-wrap:wrap; }
  
  /* Tables */
  table { width:100%; border-collapse:collapse; }
  th, td { text-align:left; padding:8px 16px; border-bottom:1px solid var(--line); vertical-align:top; }
  th { color:var(--muted); font-weight:500; font-size:12px; }
  tr:last-child td { border-bottom:0; }
  
  .tag { display:inline-block; padding:1px 6px; border-radius:4px; font-size:11px; border:1px solid var(--line); }
  .active { color:var(--ok); } .draft { color:var(--warn); } .retracted { color:var(--err); }
  .stale { color:var(--err); } .ahead { color:var(--warn); } .valid { color:var(--ok); }
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
  
  /* Modal */
  .modal-overlay { position:fixed; top:0; left:0; right:0; bottom:0; background:rgba(0,0,0,0.7); display:none; justify-content:center; align-items:center; z-index:999; padding:20px; }
  .modal { background:var(--panel); border:1px solid var(--line); border-radius:8px; width:100%; max-width:540px; display:grid; gap:16px; padding:20px; box-shadow:0 12px 32px rgba(0,0,0,0.5); }
  .modal h3 { margin:0; font-size:16px; }
  .modal .form-group { display:grid; gap:6px; }
  .modal label { font-size:12px; color:var(--muted); font-weight:600; text-transform:uppercase; letter-spacing:.05em; }
  .modal-actions { display:flex; justify-content:flex-end; gap:8px; margin-top:8px; }

  /* Graph Explorer */
  #graph-box { width:100%; height:550px; background:#090d13; overflow:hidden; position:relative; border-bottom:1px solid var(--line); }
  #graph-svg { width:100%; height:100%; cursor:grab; }
  .node circle { stroke-width:2px; transition:r .2s; }
  .node text { font-size:11px; fill:var(--ink); font-family:ui-monospace,monospace; pointer-events:none; }
  .link { stroke:#30363d; stroke-opacity:0.6; stroke-width:1.5px; }
</style>
</head>
<body>
<header>
  <div class="brand">
    <h1>Lore</h1>
    <span class="brand-sub">Memory for AI Coding Agents</span>
  </div>
  <nav>
    <button data-tab="knowledge" class="on">Knowledge Hub</button>
    <button data-tab="review">Review <span id="nav-draft-badge" style="display:none" class="tag draft">0</span></button>
    <button data-tab="undo">Undo</button>
    <button data-tab="ontology">Ontology</button>
    <button data-tab="settings">Settings</button>
  </nav>
  <div class="hdr-right">
    <span id="branch" class="muted"></span>
    <button class="act primary" id="btn-new-claim">+ New Fact</button>
  </div>
</header>
<div id="banner" class="banner"></div>
<main>
  <!-- Knowledge Hub Tab -->
  <section id="tab-knowledge" class="on">
    <div class="cards" id="cards"></div>
    <div class="panel">
      <div class="pills" id="category-pills">
        <button class="pill on" data-cat="all">All Knowledge</button>
        <button class="pill" data-cat="architecture">Architecture & Rules</button>
        <button class="pill" data-cat="env">Environment & Config</button>
        <button class="pill" data-cat="routes">API Routes & Endpoints</button>
        <button class="pill" data-cat="deps">Dependencies & Modules</button>
        <button class="pill" data-cat="inferred">Agent Inferred (T4)</button>
      </div>
      <div class="controls">
        <input id="q" placeholder="Search subject, predicate, object..." size="30" />
        <select id="state">
          <option value="">all states</option>
          <option value="active">active</option>
          <option value="draft">draft</option>
          <option value="retracted">retracted</option>
        </select>
        <select id="fresh">
          <option value="">any freshness</option>
          <option value="valid">valid (verified)</option>
          <option value="stale">stale (drifted)</option>
          <option value="ahead">ahead of checkout</option>
        </select>
        <div style="margin-left:auto; display:flex; gap:6px;">
          <button class="act" id="view-cards" style="font-weight:600">Cards</button>
          <button class="act" id="view-graph">Graph</button>
          <button class="act" id="view-raw">Raw Table</button>
        </div>
      </div>

      <!-- Graph Container -->
      <div id="graph-box" style="display:none">
        <svg id="graph-svg"></svg>
      </div>

      <!-- Cards Container -->
      <div id="cards-view" class="grid-view"></div>

      <!-- Raw Table Container -->
      <div id="raw-view" style="display:none">
        <table>
          <thead>
            <tr>
              <th>Subject</th>
              <th>Predicate</th>
              <th>Object</th>
              <th>State</th>
              <th>Freshness</th>
              <th>Authority</th>
              <th>Actions</th>
            </tr>
          </thead>
          <tbody id="claims-raw"></tbody>
        </table>
      </div>
    </div>
  </section>

  <!-- Review Tab -->
  <section id="tab-review">
    <div class="panel">
      <div class="panel-header">
        <h2>What the agent learned — requires human approval</h2>
        <div>
          <button class="act ok" id="approve-all">Approve all</button>
          <span class="muted" id="review-count"></span>
        </div>
      </div>
      <div id="drafts"></div>
    </div>
  </section>

  <!-- Undo Tab -->
  <section id="tab-undo">
    <div class="panel">
      <div class="panel-header">
        <h2>Session and commit history</h2>
      </div>
      <ul id="commits" style="list-style:none;margin:0;padding:0"></ul>
    </div>
  </section>

  <!-- Ontology Tab -->
  <section id="tab-ontology">
    <div class="panel">
      <div class="panel-header">
        <h2>Project Ontology & Authority Ladder</h2>
      </div>
      <div style="padding:16px">
        <p class="muted" style="margin-top:0">
          Lore validates and merges facts based on deterministic ontology rules defined in <code>lore.ontology.yml</code>.
          Predicates marked as <code>one</code> allow a single live value; <code>many</code> permits concurrent values.
        </p>
        <table style="margin-bottom:24px">
          <thead><tr><th>Predicate</th><th>Cardinality</th><th>TTL (Days)</th><th>Description</th></tr></thead>
          <tbody id="ontology-table"></tbody>
        </table>

        <h3 style="font-size:13px; text-transform:uppercase; letter-spacing:.08em; color:var(--muted)">Authority Ladder Reference</h3>
        <table>
          <thead><tr><th>Tier</th><th>Source Kind</th><th>Trust & Policy</th></tr></thead>
          <tbody>
            <tr><td><code>T0</code></td><td>Test Runner</td><td>Highest authority: automated deterministic test assertions.</td></tr>
            <tr><td><code>T1</code></td><td>Tool / AST</td><td>Deterministic codebase extractors (package.json, imports, routes).</td></tr>
            <tr><td><code>T2</code></td><td>Human Approved</td><td>Verified or authored by human developer.</td></tr>
            <tr><td><code>T3</code></td><td>Human Chat</td><td>Stated conversationally without formal verification.</td></tr>
            <tr><td><code>T4</code></td><td>Agent Inference</td><td>AI deduction; held as draft until approved.</td></tr>
          </tbody>
        </table>
      </div>
    </div>
  </section>

  <!-- Settings Tab -->
  <section id="tab-settings">
    <div class="panel">
      <div class="panel-header">
        <h2>Identity and Environment Policy</h2>
      </div>
      <div class="kv" id="settings"></div>
    </div>
  </section>
</main>

<!-- Detailed Claim & Provenance Inspector Modal -->
<div class="modal-overlay" id="inspector-modal">
  <div class="modal" style="max-width:760px; max-height:88vh; overflow-y:auto; gap:14px">
    <div style="display:flex; justify-content:space-between; align-items:flex-start">
      <div>
        <div style="font-size:11px; text-transform:uppercase; letter-spacing:.08em; color:var(--muted)" id="insp-type">Memory Inspector</div>
        <h3 id="insp-subject" style="margin:4px 0 0; font-size:16px; color:var(--accent); word-break:break-all"></h3>
      </div>
      <button class="act" id="insp-close-btn" style="padding:3px 9px">✕</button>
    </div>

    <!-- Human-Readable Translation -->
    <div style="background:#131d2a; border:1px solid #1f364d; border-radius:6px; padding:12px 14px">
      <div style="font-size:11px; text-transform:uppercase; letter-spacing:.06em; color:var(--accent); font-weight:600; margin-bottom:4px">
        What Lore Remembers (Plain Language)
      </div>
      <div id="insp-summary" style="font-size:14px; line-height:1.5"></div>
    </div>

    <!-- Stored Object Value -->
    <div style="background:var(--bg); border:1px solid var(--line); border-radius:6px; padding:10px 14px">
      <div style="font-size:11px; text-transform:uppercase; letter-spacing:.06em; color:var(--muted); font-weight:600; margin-bottom:4px">
        Stored Value (Object)
      </div>
      <div id="insp-object-val" style="font-size:13px; color:var(--ink); word-break:break-word; max-height:100px; overflow-y:auto"></div>
    </div>

    <!-- Source Evidence & Code Snippet Box -->
    <div style="background:var(--bg); border:1px solid var(--line); border-radius:6px; padding:12px 14px; display:grid; gap:8px">
      <div style="display:flex; justify-content:space-between; align-items:center; flex-wrap:wrap">
        <div style="font-size:11px; text-transform:uppercase; letter-spacing:.06em; color:var(--muted); font-weight:600">
          Source Evidence & Code Context
        </div>
        <div id="insp-evidence-badge"></div>
      </div>
      <div id="insp-evidence-ref" class="muted" style="font-size:12px; word-break:break-all"></div>
      <div id="insp-drift-warning" style="display:none; padding:8px 12px; background:rgba(248,81,73,0.1); border:1px solid var(--err); border-radius:4px; color:var(--err); font-size:12px">
        <strong>Stale Drift Detected:</strong> The file on disk was modified after this claim was recorded. The current file hash differs from commit evidence.
      </div>
      <div id="insp-code-container" style="background:#090d13; border:1px solid #21262d; border-radius:4px; padding:8px; font-size:12px; overflow-x:auto; max-height:240px">
        <pre id="insp-code" style="margin:0; font-family:ui-monospace,Menlo,monospace; line-height:1.5"></pre>
      </div>
    </div>

    <!-- Trust, Authority & Provenance Breakdown -->
    <div style="display:grid; grid-template-columns:1fr 1fr; gap:12px">
      <div style="background:var(--bg); border:1px solid var(--line); border-radius:6px; padding:10px 12px">
        <div style="font-size:11px; text-transform:uppercase; letter-spacing:.06em; color:var(--muted); font-weight:600; margin-bottom:6px">Trust & Policy</div>
        <div style="font-size:12px; display:grid; gap:4px">
          <div>Trust: <span id="insp-trust" class="tag"></span></div>
          <div>Freshness: <span id="insp-freshness" class="tag"></span></div>
          <div class="muted" id="insp-trust-reason" style="font-size:11px; margin-top:2px"></div>
        </div>
      </div>
      <div style="background:var(--bg); border:1px solid var(--line); border-radius:6px; padding:10px 12px">
        <div style="font-size:11px; text-transform:uppercase; letter-spacing:.06em; color:var(--muted); font-weight:600; margin-bottom:6px">Provenance & History</div>
        <div style="font-size:12px; display:grid; gap:4px">
          <div>Authority: <span id="insp-authority" style="font-weight:600"></span></div>
          <div>Author: <code id="insp-author"></code></div>
          <div class="muted" id="insp-timestamp" style="font-size:11px"></div>
        </div>
      </div>
    </div>

    <div class="modal-actions" style="margin-top:4px">
      <button class="act" id="insp-edit-btn">Edit Fact</button>
      <button class="act primary" id="insp-close-action">Close</button>
    </div>
  </div>
</div>

<!-- New / Edit Fact Modal -->
<div class="modal-overlay" id="claim-modal">
  <div class="modal">
    <h3 id="modal-title">Record New Fact</h3>
    <div id="modal-audit-note" style="display:none; padding:8px 10px; background:rgba(88,166,255,0.08); border:1px solid rgba(88,166,255,0.3); border-radius:6px; font-size:12px; color:var(--accent)">
      Lore maintains an immutable commit history. Submitting will record an inverse supersede commit with audit provenance.
    </div>
    <div class="form-group">
      <label>Subject</label>
      <input id="modal-subj" placeholder="e.g. doc:architecture.md, env:DATABASE_URL, rule:auth" />
    </div>
    <div class="form-group">
      <label>Predicate</label>
      <input id="modal-pred" placeholder="e.g. read_by, imports_module, exposes_route, title" list="pred-suggestions" />
      <datalist id="pred-suggestions">
        <option value="read_by">Referenced in file</option>
        <option value="imports_module">Imports module</option>
        <option value="declared_dependency">Declared dependency</option>
        <option value="exposes_route">Exposes route</option>
        <option value="title">Document title</option>
        <option value="has_section">Has section</option>
        <option value="requires_auth">Requires authentication</option>
        <option value="notes">Operational notes</option>
      </datalist>
    </div>
    <div class="form-group">
      <label>Object (Value)</label>
      <textarea id="modal-obj" rows="4" placeholder="Factual statement or value"></textarea>
    </div>
    <div class="modal-actions">
      <button class="act" id="modal-cancel">Cancel</button>
      <button class="act primary" id="modal-save">Save Fact</button>
    </div>
  </div>
</div>

<script>
const CSRF = '__CSRF__';
const $ = (id) => document.getElementById(id);
const el = (tag, text, cls) => { const n = document.createElement(tag); if (text !== undefined) n.textContent = text; if (cls) n.className = cls; return n; };

const PREDICATE_LABELS = {
  'read_by': 'Referenced in file',
  'imports_module': 'Imports module',
  'declared_dependency': 'Declared dependency',
  'exposes_route': 'Exposes route',
  'handles_event': 'Handles event',
  'has_section': 'Document section',
  'section_title': 'Section title',
  'title': 'Document title',
  'detects': 'Rule detection',
  'supersedes': 'Supersedes'
};

let currentTab = 'knowledge';
let currentView = 'cards';
let currentCategory = 'all';
let allClaims = [];
let editingClaim = null;

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
  currentTab = tab;
  for (const b of document.querySelectorAll('nav button')) b.classList.toggle('on', b.dataset.tab === tab);
  for (const s of document.querySelectorAll('main section')) s.classList.toggle('on', s.id === 'tab-' + tab);
  if (tab === 'knowledge') refreshKnowledge();
  if (tab === 'review') loadReview();
  if (tab === 'undo') loadCommits();
  if (tab === 'ontology') loadOntology();
  if (tab === 'settings') loadSettings();
}

async function loadHealth() {
  const h = await (await fetch('/api/health')).json();
  $('branch').textContent = 'branch ' + h.branch;
  const cards = $('cards'); cards.replaceChildren();
  for (const [label, value, cls, desc] of [
    ['Active Facts', h.active, 'active', 'Live verified memory injected into agents'],
    ['Drafts', h.draft, 'draft', 'Inferences awaiting human review'],
    ['Stale Facts', h.stale, 'stale', 'Codebase changed since observation'],
    ['Ahead', h.ahead, 'ahead', 'Observed on newer commit'],
    ['Conflicts', h.conflicts, h.conflicts ? 'stale' : '', 'Rival claims needing resolution'],
  ]) {
    const card = el('div', undefined, 'card');
    card.append(el('div', String(value), 'n ' + cls), el('div', label, 'l'), el('div', desc, 'desc'));
    cards.append(card);
  }
  const badge = $('nav-draft-badge');
  if (h.draft > 0) {
    badge.textContent = String(h.draft);
    badge.style.display = 'inline-block';
  } else {
    badge.style.display = 'none';
  }
}

function filterClaimsList() {
  const q = $('q').value.toLowerCase();
  const st = $('state').value;
  const fr = $('fresh').value;

  return allClaims.filter(c => {
    if (st && c.state !== st) return false;
    if (fr && c.freshness !== fr) return false;
    if (currentCategory === 'architecture' && !c.subject.startsWith('rule:') && !c.subject.startsWith('doc:')) return false;
    if (currentCategory === 'env' && !c.subject.startsWith('env:')) return false;
    if (currentCategory === 'routes' && c.predicate !== 'exposes_route' && c.predicate !== 'handles_event') return false;
    if (currentCategory === 'deps' && !c.subject.startsWith('pkg:') && c.predicate !== 'imports_module' && c.predicate !== 'declared_dependency') return false;
    if (currentCategory === 'inferred' && c.authority !== 4) return false;

    if (q) {
      const match = c.subject.toLowerCase().includes(q) ||
                    c.predicate.toLowerCase().includes(q) ||
                    String(c.object).toLowerCase().includes(q);
      if (!match) return false;
    }
    return true;
  });
}

async function inspectClaim(claimId) {
  try {
    const data = await (await fetch('/api/claim-details?id=' + encodeURIComponent(claimId))).json();
    if (data.error) throw new Error(data.error);

    $('insp-subject').textContent = data.subject + ' : ' + (PREDICATE_LABELS[data.predicate] || data.predicate);
    $('insp-summary').textContent = data.human_summary;
    $('insp-object-val').textContent = data.object;

    $('insp-trust').textContent = data.trust;
    $('insp-trust').className = 'tag ' + data.trust;
    $('insp-freshness').textContent = data.freshness;
    $('insp-freshness').className = 'tag ' + data.freshness;
    $('insp-trust-reason').textContent = data.trust_reason || '';

    $('insp-authority').textContent = 'T' + data.authority + ' (' + (data.authority === 0 ? 'Test' : data.authority === 1 ? 'AST/Tool' : data.authority === 2 ? 'Human Verified' : data.authority === 3 ? 'Chat' : 'Agent Inference') + ')';
    $('insp-author').textContent = data.author;
    $('insp-timestamp').textContent = 'Observed: ' + (data.tx_from ? data.tx_from.replace('T', ' ').slice(0, 19) : '—');

    const ev = (data.evidence && data.evidence[0]) || null;
    if (ev) {
      $('insp-evidence-ref').textContent = ev.kind + ':' + ev.ref + (ev.commit_id ? ' @ ' + ev.commit_id.slice(0, 8) : '');
      $('insp-evidence-badge').replaceChildren(el('span', ev.status, 'tag ' + ev.status));
    } else {
      $('insp-evidence-ref').textContent = 'No evidence attached';
      $('insp-evidence-badge').replaceChildren();
    }

    $('insp-drift-warning').style.display = data.freshness === 'stale' ? 'block' : 'none';

    const pre = $('insp-code');
    pre.replaceChildren();
    if (data.snippet && data.snippet.code && data.snippet.code.length) {
      $('insp-code-container').style.display = 'block';
      for (const line of data.snippet.code) {
        const lineEl = el('div', line.line + ' | ' + line.text);
        if (line.line === data.snippet.targetLine) {
          lineEl.style.background = 'rgba(88,166,255,0.18)';
          lineEl.style.color = '#fff';
          lineEl.style.fontWeight = '600';
        }
        pre.append(lineEl);
      }
    } else {
      $('insp-code-container').style.display = 'none';
    }

    $('insp-edit-btn').onclick = () => {
      closeInspectModal();
      openEditModal({ id: data.id, subject: data.subject, predicate: data.predicate, object: data.object });
    };

    $('inspector-modal').style.display = 'flex';
  } catch (err) {
    banner('Could not load claim details: ' + err.message, 'err');
  }
}

function closeInspectModal() {
  $('inspector-modal').style.display = 'none';
}

$('insp-close-btn').onclick = closeInspectModal;
$('insp-close-action').onclick = closeInspectModal;

function renderCardsView(claims) {
  const box = $('cards-view');
  box.replaceChildren();
  if (!claims.length) {
    box.append(el('div', 'No knowledge claims match the selected filters.', 'muted'));
    return;
  }
  for (const c of claims) {
    const card = el('div', undefined, 'k-card');
    card.onclick = (e) => {
      if (e.target.tagName.toLowerCase() === 'button') return;
      inspectClaim(c.id);
    };

    const hdr = el('div', undefined, 'k-hdr');
    hdr.append(el('div', c.subject, 'k-subj'));
    const predLabel = PREDICATE_LABELS[c.predicate] || c.predicate;
    hdr.append(el('div', predLabel, 'k-pred'));
    card.append(hdr);

    const obj = el('div', c.object, 'k-obj');
    card.append(obj);

    const foot = el('div', undefined, 'k-foot');
    const tags = el('div', undefined, 'k-tags');
    tags.append(el('span', c.state, 'tag ' + c.state));
    tags.append(el('span', c.freshness, 'tag ' + c.freshness));
    tags.append(el('span', 'T' + c.authority, 'tag muted'));
    foot.append(tags);

    const acts = el('div', undefined, 'k-tags');
    const inspBtn = el('button', 'Inspect', 'act');
    inspBtn.onclick = (e) => { e.stopPropagation(); inspectClaim(c.id); };
    acts.append(inspBtn);

    const editBtn = el('button', 'Edit', 'act');
    editBtn.onclick = (e) => { e.stopPropagation(); openEditModal(c); };
    acts.append(editBtn);
    foot.append(acts);

    card.append(foot);
    box.append(card);
  }
}

function renderRawView(claims) {
  const body = $('claims-raw');
  body.replaceChildren();
  if (!claims.length) {
    const tr = el('tr'); const td = el('td', 'No claims match.', 'muted');
    td.colSpan = 7; tr.append(td); body.append(tr);
    return;
  }
  for (const c of claims) {
    const tr = el('tr');
    tr.style.cursor = 'pointer';
    tr.onclick = (e) => {
      if (e.target.tagName.toLowerCase() === 'button') return;
      inspectClaim(c.id);
    };
    tr.append(el('td', c.subject), el('td', c.predicate), el('td', c.object));
    const s = el('td'); s.append(el('span', c.state, 'tag ' + c.state)); tr.append(s);
    const f = el('td'); f.append(el('span', c.freshness, 'tag ' + c.freshness)); tr.append(f);
    tr.append(el('td', 'T' + c.authority));
    const tdAct = el('td');
    const insp = el('button', 'Inspect', 'act');
    insp.style.marginRight = '4px';
    insp.onclick = (e) => { e.stopPropagation(); inspectClaim(c.id); };
    tdAct.append(insp);
    const edit = el('button', 'Edit', 'act');
    edit.onclick = (e) => { e.stopPropagation(); openEditModal(c); };
    tdAct.append(edit);
    tr.append(tdAct);
    body.append(tr);
  }
}

function renderGraphView(claims) {
  const svg = $('graph-svg');
  svg.replaceChildren();
  const width = svg.clientWidth || 900;
  const height = 550;
  svg.setAttribute('viewBox', '0 0 ' + width + ' ' + height);

  const nodes = new Map();
  const links = [];

  const addNode = (id, type) => {
    if (!nodes.has(id)) {
      nodes.set(id, { id, type, x: width/2 + (Math.random()-0.5)*(width*0.7), y: height/2 + (Math.random()-0.5)*(height*0.7) });
    }
    return nodes.get(id);
  };

  const sample = claims.slice(0, 60);
  for (const c of sample) {
    let sType = 'file';
    if (c.subject.startsWith('env:')) sType = 'env';
    else if (c.subject.startsWith('pkg:')) sType = 'pkg';
    else if (c.subject.startsWith('rule:') || c.subject.startsWith('doc:')) sType = 'doc';

    const sNode = addNode(c.subject, sType);
    let oType = 'obj';
    if (String(c.object).startsWith('src/') || String(c.object).endsWith('.ts') || String(c.object).endsWith('.js')) oType = 'file';
    else if (c.predicate === 'imports_module') oType = 'pkg';
    const oNode = addNode(String(c.object).slice(0, 30), oType);
    links.push({ source: sNode, target: oNode, label: c.predicate });
  }

  // Draw links
  for (const l of links) {
    const line = document.createElementNS('http://www.w3.org/2000/svg', 'line');
    line.setAttribute('x1', l.source.x); line.setAttribute('y1', l.source.y);
    line.setAttribute('x2', l.target.x); line.setAttribute('y2', l.target.y);
    line.setAttribute('class', 'link');
    svg.append(line);
  }

  // Draw nodes
  for (const n of nodes.values()) {
    const g = document.createElementNS('http://www.w3.org/2000/svg', 'g');
    g.setAttribute('class', 'node');
    g.setAttribute('transform', 'translate(' + n.x + ',' + n.y + ')');

    const circle = document.createElementNS('http://www.w3.org/2000/svg', 'circle');
    circle.setAttribute('r', '8');
    let color = '#58a6ff';
    if (n.type === 'env') color = '#d29922';
    if (n.type === 'pkg') color = '#bc8cff';
    if (n.type === 'doc') color = '#f85149';
    circle.setAttribute('fill', color);
    circle.setAttribute('stroke', '#161b22');
    g.append(circle);

    const text = document.createElementNS('http://www.w3.org/2000/svg', 'text');
    text.setAttribute('dx', '12'); text.setAttribute('dy', '4');
    text.textContent = n.id;
    g.append(text);

    g.onclick = () => {
      $('q').value = n.id;
      renderActiveView();
    };
    svg.append(g);
  }
}

function renderActiveView() {
  const filtered = filterClaimsList();
  if (currentView === 'cards') renderCardsView(filtered);
  if (currentView === 'raw') renderRawView(filtered);
  if (currentView === 'graph') renderGraphView(filtered);
}

async function loadClaims() {
  const params = new URLSearchParams({ limit: '500' });
  allClaims = await (await fetch('/api/claims?' + params)).json();
  renderActiveView();
}

async function refreshKnowledge() {
  await loadHealth();
  await loadClaims();
}

async function loadReview() {
  const drafts = await (await fetch('/api/claims?status=draft&limit=200')).json();
  const box = $('drafts'); box.replaceChildren();
  $('review-count').textContent = drafts.length ? drafts.length + ' draft(s)' : '';
  $('approve-all').disabled = !drafts.length;
  if (!drafts.length) {
    box.append(el('div', 'Nothing to review. The agent has not proposed any new unverified claims.', 'muted'));
    box.style.padding = '16px'; return;
  }
  box.style.padding = '0';
  for (const c of drafts) {
    const card = el('div', undefined, 'draft-card');
    card.append(el('div', c.subject + ' — ' + (PREDICATE_LABELS[c.predicate] || c.predicate), 'meta'));
    card.append(el('div', c.object, 'obj'));
    card.append(el('div', 'Suggested by ' + c.author + ' · T' + c.authority + ' · ' + c.id, 'meta'));
    if (c.evidence && c.evidence.length) {
      card.append(el('div', c.evidence.map((e) => e.kind + ':' + e.ref).join(', '), 'meta'));
    }
    const actions = el('div', undefined, 'actions');
    const approve = el('button', 'Approve Fact', 'act ok');
    approve.onclick = async () => {
      try { await api('/api/approve', { ids: [c.id] }); banner('Approved ' + c.id, 'ok'); loadReview(); refreshKnowledge(); }
      catch (e) { banner(e.message, 'err'); }
    };
    const reject = el('button', 'Reject Fact', 'act bad');
    reject.onclick = async () => {
      const reason = window.prompt('Reason (optional):') || '';
      try { await api('/api/reject', { claim: c.id, reason }); banner('Rejected ' + c.id, 'ok'); loadReview(); refreshKnowledge(); }
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
      if (!window.confirm('Revert ' + c.id.slice(0, 12) + '? A new inverse commit will be recorded.')) return;
      try { await api('/api/revert', { commit: c.id }); banner('Reverted ' + c.id.slice(0, 12), 'ok'); loadCommits(); refreshKnowledge(); }
      catch (e) { banner(e.message, 'err'); }
    };
    actions.append(undo);
    li.append(actions);
    list.append(li);
  }
  if (!rows.length) list.append(el('li', 'No commits recorded.', 'muted'));
}

async function loadOntology() {
  const data = await (await fetch('/api/ontology')).json();
  const tbody = $('ontology-table');
  tbody.replaceChildren();
  const predicates = data.ontology?.predicates || {};
  const entries = Object.entries(predicates);
  if (!entries.length) {
    const tr = el('tr'); const td = el('td', 'No custom predicates configured in lore.ontology.yml', 'muted');
    td.colSpan = 4; tr.append(td); tbody.append(tr);
    return;
  }
  for (const [pred, conf] of entries) {
    const tr = el('tr');
    tr.append(el('td', pred));
    tr.append(el('td', conf.cardinality || 'one'));
    tr.append(el('td', conf.ttl_days ? conf.ttl_days + ' days' : 'never'));
    tr.append(el('td', PREDICATE_LABELS[pred] || 'Custom predicate'));
    tbody.append(tr);
  }
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

function openNewModal() {
  editingClaim = null;
  $('modal-title').textContent = 'Record New Fact';
  $('modal-audit-note').style.display = 'none';
  $('modal-subj').value = '';
  $('modal-subj').disabled = false;
  $('modal-pred').value = '';
  $('modal-pred').disabled = false;
  $('modal-obj').value = '';
  $('claim-modal').style.display = 'flex';
}

function openEditModal(claim) {
  editingClaim = claim;
  $('modal-title').textContent = 'Edit / Supersede Fact';
  $('modal-audit-note').style.display = 'block';
  $('modal-subj').value = claim.subject;
  $('modal-subj').disabled = true;
  $('modal-pred').value = claim.predicate;
  $('modal-pred').disabled = true;
  $('modal-obj').value = claim.object;
  $('claim-modal').style.display = 'flex';
}

function closeModal() {
  $('claim-modal').style.display = 'none';
  editingClaim = null;
}

$('btn-new-claim').onclick = openNewModal;
$('modal-cancel').onclick = closeModal;
$('modal-save').onclick = async () => {
  const subj = $('modal-subj').value.trim();
  const pred = $('modal-pred').value.trim();
  const obj = $('modal-obj').value.trim();
  if (!obj) { banner('Object value cannot be empty', 'err'); return; }

  try {
    if (editingClaim) {
      await api('/api/supersede', { claim: editingClaim.id, object: obj });
      banner('Superseded fact ' + editingClaim.id, 'ok');
    } else {
      if (!subj || !pred) { banner('Subject and Predicate are required', 'err'); return; }
      await api('/api/claim', { subject: subj, predicate: pred, object: obj });
      banner('Recorded new fact', 'ok');
    }
    closeModal();
    refreshKnowledge();
  } catch (err) {
    banner(err.message, 'err');
  }
};

// Category filters
for (const pill of document.querySelectorAll('#category-pills .pill')) {
  pill.onclick = () => {
    for (const p of document.querySelectorAll('#category-pills .pill')) p.classList.remove('on');
    pill.classList.add('on');
    currentCategory = pill.dataset.cat;
    renderActiveView();
  };
}

// View mode switcher
function switchView(view) {
  currentView = view;
  $('view-cards').style.fontWeight = view === 'cards' ? '600' : 'normal';
  $('view-graph').style.fontWeight = view === 'graph' ? '600' : 'normal';
  $('view-raw').style.fontWeight = view === 'raw' ? '600' : 'normal';

  $('cards-view').style.display = view === 'cards' ? 'grid' : 'none';
  $('graph-box').style.display = view === 'graph' ? 'block' : 'none';
  $('raw-view').style.display = view === 'raw' ? 'block' : 'none';

  renderActiveView();
}

$('view-cards').onclick = () => switchView('cards');
$('view-graph').onclick = () => switchView('graph');
$('view-raw').onclick = () => switchView('raw');

for (const b of document.querySelectorAll('nav button')) b.onclick = () => show(b.dataset.tab);
$('q').addEventListener('input', () => { clearTimeout(window.__t); window.__t = setTimeout(renderActiveView, 150); });
$('state').addEventListener('change', renderActiveView);
$('fresh').addEventListener('change', renderActiveView);

$('approve-all').onclick = async () => {
  const drafts = await (await fetch('/api/claims?status=draft&limit=200')).json();
  if (!drafts.length) return;
  if (!window.confirm('Approve all ' + drafts.length + ' draft(s)?')) return;
  try {
    await api('/api/approve', { ids: drafts.map((d) => d.id) });
    banner('Approved ' + drafts.length + ' claim(s)', 'ok');
    loadReview();
    refreshKnowledge();
  } catch (e) { banner(e.message, 'err'); }
};

refreshKnowledge();
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
          if (url.pathname === '/api/claim') {
            const subject = String(body.subject ?? '').trim();
            const predicate = String(body.predicate ?? '').trim();
            const object = String(body.object ?? '').trim();
            if (!subject || !predicate || !object) {
              json(res, { error: 'subject, predicate, and object are required' }, 400);
              return;
            }
            const author = `human:${resolvePrincipal()?.id ?? 'ui'}`;
            const run = db.transaction(() => {
              const result = upsertClaim(db, {
                subject,
                predicate,
                object,
                author,
                sessionId: session,
                evidence: [{ kind: 'human', ref: subject, commit: gitHead(root) }],
              });
              if (result.state === 'active' && !inBranch(db, ref, result.id)) {
                makeCommit(db, {
                  ref,
                  entries: [{ claim_id: result.id, op: 'add' }],
                  message: `write: ${predicate} ${subject}`,
                  author,
                  kind: 'write',
                });
              }
              return result;
            });
            json(res, run());
            return;
          }
          if (url.pathname === '/api/supersede') {
            const claimId = String(body.claim ?? '').trim();
            const object = String(body.object ?? '').trim();
            if (!claimId || !object) {
              json(res, { error: 'claim and object are required' }, 400);
              return;
            }
            const author = `human:${resolvePrincipal()?.id ?? 'ui'}`;
            const run = db.transaction(() => {
              const result = supersedeClaim(db, claimId, {
                object,
                author,
                sessionId: session,
                evidence: [{ kind: 'human', ref: claimId, commit: gitHead(root) }],
              });
              if (result.state === 'active' && !inBranch(db, ref, result.newId)) {
                makeCommit(db, {
                  ref,
                  entries: [{ claim_id: result.newId, op: 'supersede' }],
                  message: `supersede: ${result.oldId} -> ${result.newId}`,
                  author,
                  kind: 'write',
                });
              }
              return result;
            });
            json(res, run());
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

      if (url.pathname === '/api/ontology') {
        const file = path.join(root, 'lore.ontology.yml');
        const exists = existsSync(file);
        let parsed = {};
        if (exists) {
          try {
            parsed = parse(readFileSync(file, 'utf8')) || {};
          } catch {
            parsed = {};
          }
        }
        json(res, { exists, file, ontology: parsed });
        return;
      }

      if (url.pathname === '/api/claim-details') {
        const id = url.searchParams.get('id');
        if (!id) {
          json(res, { error: 'id parameter is required' }, 400);
          return;
        }
        const claim = db.prepare('SELECT * FROM claim WHERE id = ?').get(id) as ClaimRow | undefined;
        if (!claim) {
          json(res, { error: 'claim not found' }, 404);
          return;
        }
        const explained = explainClaim(db, root, ref, claim);

        // Find code/evidence snippet
        let snippet = null;
        for (const ev of explained.evidence) {
          if (ev.kind === 'file' || ev.kind === 'test') {
            const cleanRef = ev.ref.split('#')[0].replace(/^file:/, '').replace(/^doc:/, '');
            const absPath = path.resolve(root, cleanRef);
            if (existsSync(absPath)) {
              try {
                const lines = readFileSync(absPath, 'utf8').split('\n');
                const targetKey = claim.subject_id.replace(/^(env|file|doc|rule|pkg):/, '').split('#')[0];
                let targetLineIdx = -1;
                for (let i = 0; i < lines.length; i++) {
                  if (lines[i].includes(targetKey) || (explained.object && lines[i].includes(explained.object))) {
                    targetLineIdx = i;
                    break;
                  }
                }
                const center = targetLineIdx >= 0 ? targetLineIdx : 0;
                const start = Math.max(0, center - 4);
                const end = Math.min(lines.length, center + 6);
                snippet = {
                  file: cleanRef,
                  targetLine: targetLineIdx >= 0 ? targetLineIdx + 1 : null,
                  code: lines.slice(start, end).map((text, idx) => ({ line: start + idx + 1, text })),
                };
                break;
              } catch {
                // ignore
              }
            }
          }
        }

        // Generate natural language human summary
        let humanSummary = `Lore records that ${claim.subject_id} has ${claim.predicate} set to "${explained.object}".`;
        if (claim.predicate === 'read_by') {
          humanSummary = `Environment variable "${claim.subject_id.replace(/^env:/, '')}" is read and used by source file "${explained.object}".`;
        } else if (claim.predicate === 'imports_module') {
          humanSummary = `Source file "${claim.subject_id.replace(/^file:/, '')}" imports external module "${explained.object}".`;
        } else if (claim.predicate === 'title') {
          humanSummary = `Document "${claim.subject_id.replace(/^doc:/, '')}" defines document title "${explained.object}".`;
        } else if (claim.predicate === 'has_section') {
          humanSummary = `Document "${claim.subject_id.replace(/^doc:/, '')}" contains section header "${explained.object}".`;
        } else if (claim.predicate === 'exposes_route') {
          humanSummary = `Source file "${claim.subject_id.replace(/^file:/, '')}" exposes HTTP route "${explained.object}".`;
        } else if (claim.predicate === 'declared_dependency') {
          humanSummary = `Package "${claim.subject_id.replace(/^pkg:/, '')}" is declared as a project dependency (${explained.object}).`;
        }

        json(res, {
          ...explained,
          snippet,
          human_summary: humanSummary,
        });
        return;
      }

      if (url.pathname === '/api/health') {
        const tip = head(db, ref) ?? head(db, 'main');
        const counts = db.prepare('SELECT state, COUNT(*) n FROM claim GROUP BY state').all() as Array<{ state: string; n: number }>;
        const byState = new Map(counts.map((r) => [r.state, r.n]));
        let stale = 0;
        let ahead = 0;
        const currentGitHead = gitHead(root);
        const freshnessOpts = { head: currentGitHead };
        const ids = db.prepare("SELECT DISTINCT claim_id FROM evidence WHERE kind IN ('file','test')").all() as Array<{ claim_id: string }>;
        for (const row of ids) {
          const freshness = claimFreshness(db, root, row.claim_id, freshnessOpts);
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

        const currentGitHead = gitHead(root);
        const freshnessOpts = { head: currentGitHead };
        const out = rows
          .map((row) => {
            const id = String(row.id);
            const freshness = claimFreshness(db, root, id, freshnessOpts);
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
