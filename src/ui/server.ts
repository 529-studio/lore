import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { Buffer } from 'node:buffer';
import { randomBytes } from 'node:crypto';
import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { parse } from 'yaml';
import { openDb, type DB } from '../db.js';
import { initCommand } from '../commands/init.js';
import { claimFreshness } from '../merge.js';
import { activeAt, head, inBranch, makeCommit, supersedeClaim, upsertClaim, type ClaimRow } from '../model.js';
import { branchFor, currentSession } from '../session.js';
import { readConfig } from '../config.js';
import { ActionError, approveDrafts, attestClaim, rejectDraft, revertCommit } from '../actions.js';
import { resolvePrincipal, teamMode } from '../identity.js';
import { describePolicy, isPermissiveTrust, requireAction } from '../policy.js';
import { installCanon } from '../canon/index.js';
import { explainClaim } from '../canon/explain.js';
import { gitHead } from '../util/git.js';
import { isAncestor } from '../sync.js';

export interface UiOptions {
  port?: number;
  host?: string;
}

export interface UiHandle {
  url: string;
  server: Server;
  close: () => Promise<void>;
}

export const GRAPH_WORKER_SCRIPT = `
self.onmessage = function(e) {
  const data = e.data;
  if (!data || data.type !== 'simulate') return;

  const start = Date.now();
  const width = data.width || 920;
  const height = data.height || 580;
  const nodes = data.nodes || [];
  const links = data.links || [];
  const clustered = data.clustered !== false;
  const iterations = data.iterations || (nodes.length > 500 ? 50 : 80);
  const clusterCentroids = data.clusterCentroids || {
    file: { x: width * 0.42, y: height * 0.46 },
    env:  { x: width * 0.82, y: height * 0.28 },
    pkg:  { x: width * 0.18, y: height * 0.72 },
    doc:  { x: width * 0.80, y: height * 0.75 },
    obj:  { x: width * 0.50, y: height * 0.58 },
  };

  const total = nodes.length;
  const nodeMap = new Map();
  for (let i = 0; i < total; i++) nodeMap.set(nodes[i].id, nodes[i]);

  for (let idx = 0; idx < total; idx++) {
    const n = nodes[idx];
    if (clustered) {
      const cCenter = clusterCentroids[n.type] || clusterCentroids.file;
      const angle = (idx / (total || 1)) * 2 * Math.PI;
      const jitter = 40 + (idx % 6) * 16;
      n.x = cCenter.x + Math.cos(angle) * jitter;
      n.y = cCenter.y + Math.sin(angle) * jitter;
    } else {
      const angle = (idx / (total || 1)) * 2 * Math.PI;
      const r = 110 + (idx % 4) * 55;
      n.x = width / 2 + Math.cos(angle) * r;
      n.y = height / 2 + Math.sin(angle) * r;
    }
  }

  const cellSize = 100;
  for (let iter = 0; iter < iterations; iter++) {
    const decay = 1 - (iter / iterations) * 0.7;
    if (total <= 250) {
      for (let i = 0; i < total; i++) {
        const a = nodes[i];
        for (let j = i + 1; j < total; j++) {
          const b = nodes[j];
          const dx = b.x - a.x;
          const dy = b.y - a.y;
          const minDist = 110 + Math.min(25, Math.max(a.degree, b.degree)) * 6;
          const dSq = dx * dx + dy * dy;
          if (dSq < minDist * minDist) {
            const dist = Math.sqrt(dSq) || 1;
            const f = ((minDist - dist) / dist) * 0.35 * decay;
            a.x -= dx * f; a.y -= dy * f;
            b.x += dx * f; b.y += dy * f;
          }
        }
      }
    } else {
      const grid = new Map();
      for (let i = 0; i < total; i++) {
        const n = nodes[i];
        const gx = Math.floor(n.x / cellSize);
        const gy = Math.floor(n.y / cellSize);
        const k = (gx << 16) ^ gy;
        let bucket = grid.get(k);
        if (!bucket) { bucket = []; grid.set(k, bucket); }
        bucket.push(n);
      }
      for (let i = 0; i < total; i++) {
        const a = nodes[i];
        const gx = Math.floor(a.x / cellSize);
        const gy = Math.floor(a.y / cellSize);
        for (let ox = -1; ox <= 1; ox++) {
          for (let oy = -1; oy <= 1; oy++) {
            const k = ((gx + ox) << 16) ^ (gy + oy);
            const bucket = grid.get(k);
            if (!bucket) continue;
            for (let bIdx = 0; bIdx < bucket.length; bIdx++) {
              const b = bucket[bIdx];
              if (b.id <= a.id) continue;
              const dx = b.x - a.x;
              const dy = b.y - a.y;
              const minDist = 90 + Math.min(20, Math.max(a.degree, b.degree)) * 4;
              const dSq = dx * dx + dy * dy;
              if (dSq < minDist * minDist) {
                const dist = Math.sqrt(dSq) || 1;
                const f = ((minDist - dist) / dist) * 0.30 * decay;
                a.x -= dx * f; a.y -= dy * f;
                b.x += dx * f; b.y += dy * f;
              }
            }
          }
        }
      }
    }
    for (let l = 0; l < links.length; l++) {
      const link = links[l];
      const src = typeof link.source === 'object' ? link.source : nodeMap.get(link.source);
      const tgt = typeof link.target === 'object' ? link.target : nodeMap.get(link.target);
      if (!src || !tgt) continue;
      const dx = tgt.x - src.x;
      const dy = tgt.y - src.y;
      const dist = Math.sqrt(dx * dx + dy * dy) || 1;
      const hubBonus = Math.min(25, Math.max(src.degree, tgt.degree)) * 6;
      const targetDist = 95 + hubBonus;
      const f = (dist - targetDist) * 0.04 * decay;
      src.x += (dx / dist) * f;
      src.y += (dy / dist) * f;
      tgt.x -= (dx / dist) * f;
      tgt.y -= (dy / dist) * f;
    }
    if (clustered) {
      for (let i = 0; i < total; i++) {
        const n = nodes[i];
        const cCenter = clusterCentroids[n.type] || clusterCentroids.file;
        n.x += (cCenter.x - n.x) * 0.045 * decay;
        n.y += (cCenter.y - n.y) * 0.045 * decay;
      }
    } else {
      for (let i = 0; i < total; i++) {
        const n = nodes[i];
        n.x += (width / 2 - n.x) * 0.025 * decay;
        n.y += (height / 2 - n.y) * 0.025 * decay;
      }
    }
  }

  if (total > 0) {
    let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
    for (let i = 0; i < total; i++) {
      const n = nodes[i];
      if (n.x < minX) minX = n.x;
      if (n.x > maxX) maxX = n.x;
      if (n.y < minY) minY = n.y;
      if (n.y > maxY) maxY = n.y;
    }
    const rangeX = maxX - minX || 1;
    const rangeY = maxY - minY || 1;
    const padX = 75;
    const padY = 55;
    const targetW = width - padX * 2;
    const targetH = height - padY * 2;
    for (let i = 0; i < total; i++) {
      const n = nodes[i];
      n.x = padX + ((n.x - minX) / rangeX) * targetW;
      n.y = padY + ((n.y - minY) / rangeY) * targetH;
    }
  }

  function createQuadtree(pts, x0, y0, x1, y1, depth) {
    if (depth > 8 || pts.length <= 4) return { x0, y0, x1, y1, points: pts };
    const midX = (x0 + x1) / 2;
    const midY = (y0 + y1) / 2;
    const q0 = [], q1 = [], q2 = [], q3 = [];
    for (let i = 0; i < pts.length; i++) {
      const p = pts[i];
      if (p.x < midX) {
        if (p.y < midY) q0.push(p); else q2.push(p);
      } else {
        if (p.y < midY) q1.push(p); else q3.push(p);
      }
    }
    return {
      x0, y0, x1, y1,
      children: [
        createQuadtree(q0, x0, y0, midX, midY, depth + 1),
        createQuadtree(q1, midX, y0, x1, midY, depth + 1),
        createQuadtree(q2, x0, midY, midX, y1, depth + 1),
        createQuadtree(q3, midX, midY, x1, y1, depth + 1),
      ]
    };
  }

  const quadtree = createQuadtree(nodes.map(n => ({ id: n.id, x: n.x, y: n.y })), 0, 0, width, height, 0);

  self.postMessage({
    type: 'complete',
    nodes: nodes,
    durationMs: Date.now() - start,
    quadtree: quadtree,
  });
};
`;

export interface SyncStatusPayload {
  remoteStatus: 'in sync' | 'ahead' | 'behind' | 'diverged' | 'not synced yet' | 'standalone';
  remoteType: string | null;
  remotePath: string | null;
  activeAgents: number;
  agentBranches: string[];
  lastSyncAt: string | null;
  lastSyncAction: string | null;
}

export function getSyncStatus(db: DB, root: string): SyncStatusPayload {
  const activeSessions = db.prepare(`
    SELECT id, started_at, last_seen_at FROM session
    WHERE last_seen_at >= datetime('now', '-10 minutes')
    ORDER BY last_seen_at DESC
  `).all() as Array<{ id: string; started_at: string; last_seen_at: string }>;

  const agentBranches = db.prepare(`
    SELECT name FROM ref WHERE name LIKE 'agent/%'
  `).all() as Array<{ name: string }>;

  const config = readConfig(root);
  let remoteStatus: SyncStatusPayload['remoteStatus'] = 'standalone';
  let remoteType: string | null = null;
  let remotePath: string | null = null;

  if (config?.remote) {
    remoteType = config.remote.type;
    remotePath =
      config.remote.type === 'dir'
        ? config.remote.path
        : config.remote.url_env
          ? `$${config.remote.url_env}`
          : 'postgres';
    const local = head(db, 'main');
    const remote = config.remote_main;
    if (!local || !remote) {
      remoteStatus = 'not synced yet';
    } else if (local === remote) {
      remoteStatus = 'in sync';
    } else if (isAncestor(db, remote, local)) {
      remoteStatus = 'ahead';
    } else if (isAncestor(db, local, remote)) {
      remoteStatus = 'behind';
    } else {
      remoteStatus = 'diverged';
    }
  }

  const lastSync = db.prepare(`
    SELECT action, agent_id, ts FROM agent_action_log
    WHERE action IN ('SYNC_OUTGOING', 'SYNC_INCOMING')
    ORDER BY ts DESC LIMIT 1
  `).get() as { action: string; agent_id: string; ts: string } | undefined;

  return {
    remoteStatus,
    remoteType,
    remotePath,
    activeAgents: Math.max(activeSessions.length, agentBranches.length),
    agentBranches: agentBranches.map((b) => b.name),
    lastSyncAt: lastSync?.ts ?? null,
    lastSyncAction: lastSync?.action ?? null,
  };
}

const HTML = String.raw`<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>Lore — Memory & Knowledge Hub</title>
<link rel="icon" type="image/svg+xml" href="/favicon.svg" />
<link rel="alternate icon" type="image/png" href="/favicon.png" />
<link rel="shortcut icon" href="/favicon.ico" />
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
  .brand { display:flex; align-items:center; gap:10px; }
  .brand-logo { color:var(--accent); display:flex; align-items:center; }
  .brand-logo svg { width:22px; height:22px; }
  h1 { font-size:16px; margin:0; letter-spacing:.03em; font-weight:700; color:var(--ink); }
  .brand-sub { font-size:12px; color:var(--muted); }
  nav { display:flex; gap:6px; }
  nav button { background:transparent; border:1px solid var(--line); color:var(--muted); padding:5px 12px; border-radius:6px; cursor:pointer; font:inherit; transition:all .15s; }
  nav button:hover { color:var(--ink); border-color:var(--muted); }
  nav button.on { color:var(--ink); border-color:var(--accent); background:rgba(88,166,255,0.1); }
  .hdr-right { display:flex; align-items:center; gap:12px; }
  .muted { color:var(--muted); }
  .repo-badge { display:inline-flex; align-items:center; gap:6px; background:var(--bg); border:1px solid var(--line); border-radius:6px; padding:3px 8px; font-size:12px; }
  .repo-icon { display:flex; align-items:center; color:var(--muted); }
  .repo-name { font-weight:600; color:var(--ink); max-width:180px; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
  button.act.mini { padding:2px 8px; font-size:11px; border-radius:4px; margin-left:2px; }
  .live-indicator { display:inline-flex; align-items:center; gap:6px; font-size:11px; font-weight:600; letter-spacing:0.04em; color:var(--text); background:rgba(35, 134, 54, 0.15); border:1px solid rgba(46, 160, 67, 0.35); padding:3px 8px; border-radius:12px; font-family:ui-monospace,monospace; user-select:none; }
  .live-dot { width:7px; height:7px; border-radius:50%; background:var(--green); box-shadow:0 0 6px var(--green); }
  .live-indicator.offline { background:rgba(218, 54, 51, 0.15); border-color:rgba(218, 54, 51, 0.35); color:var(--muted); }
  .live-indicator.offline .live-dot { background:var(--red); box-shadow:none; }
  .sync-indicator { display:inline-flex; align-items:center; gap:6px; font-size:11px; font-weight:600; padding:3px 8px; border-radius:12px; font-family:ui-monospace,monospace; user-select:none; border:1px solid var(--line); background:var(--bg); color:var(--muted); }
  .sync-dot { width:7px; height:7px; border-radius:50%; background:var(--muted); }
  .sync-indicator.synced { background:rgba(35, 134, 54, 0.15); border-color:rgba(46, 160, 67, 0.35); color:var(--ok); }
  .sync-indicator.synced .sync-dot { background:var(--ok); box-shadow:0 0 6px var(--ok); }
  .sync-indicator.ahead { background:rgba(88, 166, 255, 0.15); border-color:rgba(88, 166, 255, 0.35); color:var(--accent); }
  .sync-indicator.ahead .sync-dot { background:var(--accent); }
  .sync-indicator.behind { background:rgba(210, 153, 34, 0.15); border-color:rgba(210, 153, 34, 0.35); color:var(--warn); }
  .sync-indicator.behind .sync-dot { background:var(--warn); box-shadow:0 0 6px var(--warn); }
  .sync-indicator.diverged { background:rgba(248, 81, 73, 0.15); border-color:rgba(248, 81, 73, 0.35); color:var(--err); }
  .sync-indicator.diverged .sync-dot { background:var(--err); }
  .agent-badge { font-size:10px; padding:1px 5px; border-radius:8px; background:rgba(188, 140, 255, 0.2); color:var(--purple); border:1px solid rgba(188, 140, 255, 0.3); }

  /* Skeleton Loading Shimmer */
  .skeleton-line { height:12px; border-radius:4px; background:rgba(255,255,255,0.07); margin-bottom:8px; }
  .skeleton-line.short { width:40%; }
  .skeleton-line.mid { width:70%; }
  .skeleton-line.big { height:26px; width:50%; margin-bottom:10px; }
  @keyframes shimmer { 0% { opacity:0.3; } 50% { opacity:0.75; } 100% { opacity:0.3; } }
  .skeleton-shimmer { animation: shimmer 1.4s infinite ease-in-out; }
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

  /* Dossier View */
  .dossier-grid { display:grid; grid-template-columns:repeat(auto-fill, minmax(380px, 1fr)); gap:14px; padding:16px; }
  .d-card { background:var(--panel); border:1px solid var(--line); border-radius:8px; display:flex; flex-direction:column; overflow:hidden; transition:border-color .15s ease, box-shadow .15s ease; }
  .d-card:hover { border-color:#388bfd; box-shadow:0 4px 16px rgba(0,0,0,0.3); }
  .d-hdr { padding:12px 14px; background:rgba(255,255,255,0.02); border-bottom:1px solid var(--line); display:flex; justify-content:space-between; align-items:center; gap:8px; }
  .d-title-box { display:flex; align-items:center; gap:8px; min-width:0; }
  .d-title { font-weight:600; font-size:13px; color:var(--ink); word-break:break-all; }
  .d-badge { font-size:10px; text-transform:uppercase; font-weight:700; padding:2px 7px; border-radius:10px; letter-spacing:.05em; flex-shrink:0; }
  .d-facts { padding:10px 14px; display:flex; flex-direction:column; gap:8px; flex:1; font-size:12px; }
  .d-fact-item { display:flex; align-items:baseline; gap:8px; line-height:1.4; padding:4px 6px; border-radius:4px; cursor:pointer; transition:background .1s; }
  .d-fact-item:hover { background:rgba(88,166,255,0.08); }
  .d-fact-pred { font-size:10px; font-weight:600; text-transform:uppercase; letter-spacing:.04em; color:var(--accent); background:rgba(88,166,255,0.12); padding:1px 6px; border-radius:3px; flex-shrink:0; }
  .d-fact-val { color:var(--ink); word-break:break-word; flex:1; }
  .d-foot { padding:10px 14px; border-top:1px solid var(--line); background:rgba(0,0,0,0.15); display:flex; justify-content:space-between; align-items:center; }
  
  /* Modal */
  .modal-overlay { position:fixed; top:0; left:0; right:0; bottom:0; background:rgba(0,0,0,0.7); display:none; justify-content:center; align-items:center; z-index:999; padding:20px; }
  .modal { background:var(--panel); border:1px solid var(--line); border-radius:8px; width:100%; max-width:540px; display:grid; gap:16px; padding:20px; box-shadow:0 12px 32px rgba(0,0,0,0.5); }
  .modal h3 { margin:0; font-size:16px; }
  .modal .form-group { display:grid; gap:6px; }
  .modal label { font-size:12px; color:var(--muted); font-weight:600; text-transform:uppercase; letter-spacing:.05em; }
  .modal-actions { display:flex; justify-content:flex-end; gap:8px; margin-top:8px; }
  .type-pill { background:rgba(22, 27, 34, 0.88); border:1px solid var(--line); color:var(--muted); padding:5px 12px; border-radius:14px; font:11px ui-monospace, Menlo, monospace; cursor:pointer; transition:all .15s ease; }
  .type-pill:hover { color:var(--ink); border-color:var(--muted); }
  .type-pill.on { background:rgba(88, 166, 255, 0.15); color:var(--accent); border-color:var(--accent); font-weight:600; }
  .type-pill:disabled { opacity:0.5; cursor:not-allowed; }

  /* View Switcher */
  .view-switcher { display:inline-flex; background:#090d13; padding:2px; border-radius:6px; border:1px solid var(--line); gap:2px; }
  .view-btn { background:transparent; border:1px solid transparent; color:var(--muted); padding:5px 12px; border-radius:4px; font:12px/1.2 ui-monospace, Menlo, monospace; cursor:pointer; transition:all .15s ease; }
  .view-btn:hover { color:var(--ink); background:rgba(255,255,255,0.05); }
  .view-btn.on { background:var(--panel); color:var(--accent); border-color:var(--line); box-shadow:0 1px 3px rgba(0,0,0,0.4); font-weight:600; }

  /* Graph Explorer */
  #graph-box { width:100%; height:580px; background:#090d13; overflow:hidden; position:relative; border-bottom:1px solid var(--line); }
  #graph-svg { width:100%; height:100%; cursor:grab; user-select:none; }
  #graph-svg:active { cursor:grabbing; }
  .graph-toolbar { position:absolute; top:12px; left:16px; display:flex; align-items:center; gap:8px; z-index:10; pointer-events:auto; flex-wrap:wrap; }
  .graph-controls { position:absolute; bottom:12px; right:16px; display:flex; align-items:center; gap:6px; z-index:15; pointer-events:auto; }
  .graph-badge { background:rgba(22, 27, 34, 0.88); border:1px solid var(--line); padding:4px 10px; border-radius:20px; font-size:11px; color:var(--muted); backdrop-filter:blur(8px); }
  .graph-btn { background:rgba(22, 27, 34, 0.88); border:1px solid var(--line); color:var(--ink); padding:5px 10px; border-radius:6px; font:12px ui-monospace, Menlo, monospace; cursor:pointer; backdrop-filter:blur(8px); transition:all .15s; }
  .graph-btn:hover { background:var(--line); border-color:var(--muted); }
  .graph-btn.primary { background:rgba(88, 166, 255, 0.15); border-color:var(--accent); color:var(--accent); font-weight:600; }
  .graph-btn.pill-sm { padding:3px 8px; border-radius:12px; font-size:11px; color:var(--muted); }
  .graph-btn.pill-sm.on { background:var(--accent); color:#0d1117; font-weight:600; border-color:var(--accent); }
  .graph-legend { position:absolute; bottom:12px; left:16px; display:flex; gap:12px; background:rgba(22, 27, 34, 0.88); border:1px solid var(--line); padding:6px 12px; border-radius:6px; font-size:11px; color:var(--muted); backdrop-filter:blur(8px); pointer-events:none; z-index:10; }
  .legend-item { display:flex; align-items:center; gap:6px; }
  .legend-dot { width:8px; height:8px; border-radius:50%; }

  /* Graph Node Drawer */
  #graph-drawer { position:absolute; top:12px; bottom:52px; right:12px; width:330px; background:rgba(22, 27, 34, 0.95); border:1px solid var(--line); border-radius:8px; padding:16px; display:none; flex-direction:column; gap:12px; box-shadow:-4px 0 24px rgba(0,0,0,0.6); backdrop-filter:blur(12px); z-index:20; overflow-y:auto; }
  .drawer-hdr { display:flex; justify-content:space-between; align-items:flex-start; gap:8px; border-bottom:1px solid var(--line); padding-bottom:10px; }
  .drawer-title { font-size:13px; font-weight:600; word-break:break-all; color:var(--ink); }
  .drawer-sec { display:flex; flex-direction:column; gap:6px; }
  .drawer-sec-lbl { font-size:11px; font-weight:600; color:var(--muted); text-transform:uppercase; letter-spacing:.05em; }
  .drawer-list { display:flex; flex-direction:column; gap:6px; max-height:220px; overflow-y:auto; }
  .drawer-item { background:#0d1117; border:1px solid var(--line); border-radius:6px; padding:8px 10px; font-size:11px; display:grid; gap:4px; }
  .drawer-item-rel { display:flex; justify-content:space-between; align-items:center; }
  .node circle { stroke-width:2px; transition:r .2s, stroke-width .2s, stroke .2s; cursor:pointer; }
  .node:hover circle { stroke:#ffffff; stroke-width:3px; }
  .node.selected circle { stroke:#ffffff; stroke-width:3.5px; filter:drop-shadow(0 0 6px var(--accent)); }
  .node text { font-size:11px; fill:#e6edf3; font-family:ui-monospace,monospace; pointer-events:none; paint-order:stroke fill; stroke:#090d13; stroke-width:3.5px; stroke-linejoin:round; stroke-linecap:round; }
  .node.dimmed { opacity:0.12; }
  .link { stroke:#30363d; stroke-opacity:0.6; stroke-width:1.5px; transition:stroke-opacity .2s, stroke .2s; }
  .link.highlighted { stroke:var(--accent); stroke-opacity:1; stroke-width:2.5px; }
  .link.dimmed { stroke-opacity:0.06; }
</style>
</head>
<body>
<header>
  <div class="brand">
    <span class="brand-logo" aria-hidden="true">
      <svg viewBox="0 0 512 512" fill="none" role="img">
        <rect x="88" y="88" width="64" height="336" rx="32" fill="currentColor"/>
        <rect x="184" y="88" width="240" height="64" rx="32" fill="currentColor"/>
        <rect x="184" y="224" width="184" height="64" rx="32" fill="currentColor" opacity="0.78"/>
        <rect x="184" y="360" width="128" height="64" rx="32" fill="currentColor" opacity="0.52"/>
      </svg>
    </span>
    <h1>Lore</h1>
    <span class="brand-sub">Memory for AI Coding Agents</span>
  </div>
  <div class="repo-badge" id="repo-badge" title="Active Repository">
    <span class="repo-icon" aria-hidden="true">
      <svg viewBox="0 0 16 16" width="14" height="14" fill="currentColor"><path d="M1.75 1A1.75 1.75 0 0 0 0 2.75v10.5C0 14.216.784 15 1.75 15h12.5A1.75 1.75 0 0 0 16 13.25v-8.5A1.75 1.75 0 0 0 14.25 3H7.5a.25.25 0 0 1-.2-.1l-.9-1.2A1.75 1.75 0 0 0 4.99 1H1.75Z"></path></svg>
    </span>
    <span id="repo-name" class="repo-name">…</span>
    <button class="act mini" id="btn-switch-repo" title="Choose another repository folder">Switch Repo</button>
  </div>
  <nav>
    <button data-tab="knowledge" class="on">Knowledge Hub</button>
    <button data-tab="review">Review <span id="nav-draft-badge" style="display:none" class="tag draft">0</span></button>
    <button data-tab="undo">Undo</button>
    <button data-tab="ontology">Ontology</button>
    <button data-tab="settings">Settings</button>
  </nav>
  <div class="hdr-right">
    <span id="sync-indicator" class="sync-indicator" title="Multi-agent sync status">
      <span class="sync-dot"></span>
      <span id="sync-text">Standalone</span>
      <span id="agent-count-badge" class="agent-badge" style="display:none">0 agents</span>
    </span>
    <span id="live-indicator" class="live-indicator" title="Live real-time stream active">
      <span class="live-dot"></span> LIVE
    </span>
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
        <div class="view-switcher" style="margin-left:auto;">
          <button class="view-btn on" id="view-dossier">Dossier</button>
          <button class="view-btn" id="view-cards">Cards</button>
          <button class="view-btn" id="view-graph">Graph</button>
          <button class="view-btn" id="view-raw">Raw Table</button>
        </div>
      </div>

      <!-- Graph Container -->
      <div id="graph-box" style="display:none">
        <div class="graph-toolbar">
          <button class="graph-btn primary" id="graph-reset-selection" style="display:none">← Back to Overview</button>
          <span class="graph-badge" id="graph-stat">0 nodes</span>
          <div style="display:flex; gap:4px;" id="graph-type-filters">
            <button class="graph-btn pill-sm on" data-type="all">All</button>
            <button class="graph-btn pill-sm" data-type="file">Files</button>
            <button class="graph-btn pill-sm" data-type="env">Env</button>
            <button class="graph-btn pill-sm" data-type="doc">Docs/Rules</button>
            <button class="graph-btn pill-sm" data-type="pkg">Packages</button>
            <button class="graph-btn pill-sm" data-type="internal">Internal Only</button>
          </div>
          <select id="graph-predicate-select" class="graph-btn" style="padding:3px 8px; font-size:11px;" title="Filter by predicate relationship">
            <option value="all">All Relationships</option>
          </select>
          <button class="graph-btn pill-sm on" id="graph-cluster-mode" title="Toggle Semantic Clustering Force">Clusters: ON</button>
          <button class="graph-btn pill-sm on" id="graph-density-toggle" title="Toggle High-Density Web Worker Mode (up to 1,200 nodes)">Density: High</button>
        </div>

        <div class="graph-controls">
          <button class="graph-btn" id="graph-zoom-in" title="Zoom In">+</button>
          <button class="graph-btn" id="graph-zoom-out" title="Zoom Out">−</button>
          <button class="graph-btn" id="graph-zoom-reset" title="Reset View">⟲ Reset</button>
        </div>

        <svg id="graph-svg">
          <defs>
            <marker id="arrow-imports" viewBox="0 0 10 10" refX="22" refY="5" markerWidth="6" markerHeight="6" orient="auto-start-reverse">
              <path d="M 0 1.5 L 8 5 L 0 8.5 z" fill="#bc8cff"/>
            </marker>
            <marker id="arrow-read" viewBox="0 0 10 10" refX="22" refY="5" markerWidth="6" markerHeight="6" orient="auto-start-reverse">
              <path d="M 0 1.5 L 8 5 L 0 8.5 z" fill="#d29922"/>
            </marker>
            <marker id="arrow-invariant" viewBox="0 0 10 10" refX="22" refY="5" markerWidth="6" markerHeight="6" orient="auto-start-reverse">
              <path d="M 0 1.5 L 8 5 L 0 8.5 z" fill="#f85149"/>
            </marker>
            <marker id="arrow-route" viewBox="0 0 10 10" refX="22" refY="5" markerWidth="6" markerHeight="6" orient="auto-start-reverse">
              <path d="M 0 1.5 L 8 5 L 0 8.5 z" fill="#2ea043"/>
            </marker>
            <marker id="arrow-default" viewBox="0 0 10 10" refX="22" refY="5" markerWidth="6" markerHeight="6" orient="auto-start-reverse">
              <path d="M 0 1.5 L 8 5 L 0 8.5 z" fill="#58a6ff"/>
            </marker>
          </defs>
          <g id="graph-viewport"></g>
        </svg>

        <!-- Graph Node Drawer -->
        <div id="graph-drawer">
          <div class="drawer-hdr">
            <div>
              <span id="drawer-type" class="tag" style="margin-bottom:6px; display:inline-block">File</span>
              <div id="drawer-title" class="drawer-title"></div>
            </div>
            <div style="display:flex; gap:4px; align-items:center;">
              <button class="graph-btn primary pill-sm" id="drawer-reset-btn" title="Back to Overview">← Overview</button>
              <button class="act" id="drawer-close" style="padding:2px 8px;">✕</button>
            </div>
          </div>
          <div class="drawer-sec">
            <span class="drawer-sec-lbl">Connected Facts & Relations</span>
            <div id="drawer-relations" class="drawer-list"></div>
          </div>
          <div class="drawer-sec" style="margin-top:auto;">
            <button class="act primary" id="drawer-focus-btn" style="width:100%;">Focus This Subgraph</button>
          </div>
        </div>

        <div class="graph-legend">
          <div class="legend-item"><span class="legend-dot" style="background:#58a6ff"></span> File</div>
          <div class="legend-item"><span class="legend-dot" style="background:#d29922"></span> Env Var</div>
          <div class="legend-item"><span class="legend-dot" style="background:#bc8cff"></span> Package</div>
          <div class="legend-item"><span class="legend-dot" style="background:#f85149"></span> Doc/Rule</div>
          <div class="legend-item"><span class="legend-dot" style="background:#8b949e"></span> Value</div>
        </div>
      </div>

      <!-- Dossier Container -->
      <div id="dossier-view" class="dossier-grid"></div>

      <!-- Cards Container -->
      <div id="cards-view" class="grid-view" style="display:none"></div>

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
        <h2>Active Repository</h2>
      </div>
      <div style="padding:16px; display:flex; flex-direction:column; gap:10px">
        <div style="font-size:12px; color:var(--muted)">Current memory store directory:</div>
        <div id="settings-active-repo" style="font-family:ui-monospace,Menlo,monospace; font-size:13px; background:var(--bg); border:1px solid var(--line); border-radius:6px; padding:10px 14px; word-break:break-all">…</div>
        <div>
          <button class="act primary" id="settings-switch-repo-btn">Browse / Switch Repository</button>
        </div>
      </div>
    </div>
    <div class="panel" style="margin-top:20px">
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
  <div class="modal" style="max-width:580px">
    <h3 id="modal-title">Record Memory for AI Agents</h3>
    <div id="modal-audit-note" style="display:none; padding:8px 10px; background:rgba(88,166,255,0.08); border:1px solid rgba(88,166,255,0.3); border-radius:6px; font-size:12px; color:var(--accent)">
      Lore maintains an immutable commit history. Submitting will record an inverse supersede commit with audit provenance.
    </div>

    <div id="modal-type-container" style="display:grid; gap:6px">
      <label style="font-size:11px; color:var(--muted); font-weight:600; text-transform:uppercase; letter-spacing:.05em">Memory Type</label>
      <div id="modal-type-selector" style="display:flex; gap:6px; flex-wrap:wrap">
        <button type="button" class="type-pill on" data-type="rule">Rule / Guideline</button>
        <button type="button" class="type-pill" data-type="env">Config / Env</button>
        <button type="button" class="type-pill" data-type="invariant">Code Invariant</button>
        <button type="button" class="type-pill" data-type="custom">Custom / Expert</button>
      </div>
    </div>

    <div class="form-group" id="form-group-scope">
      <label id="modal-scope-label">Rule Identifier or Target Scope</label>
      <input id="modal-scope" placeholder="e.g. auth:bearer-token or src/server.ts" list="entity-suggestions" autocomplete="off" />
      <datalist id="entity-suggestions"></datalist>
      <div id="modal-scope-hint" style="font-size:11px; color:var(--muted)">Target entity or scope this memory applies to. Autocompletes known files and rules.</div>
    </div>

    <div class="form-group" id="form-group-pred" style="display:none">
      <label>Predicate (Relationship)</label>
      <input id="modal-pred" placeholder="e.g. enforces_invariant, notes, read_by" list="pred-suggestions" />
      <datalist id="pred-suggestions">
        <option value="enforces_invariant">Enforces invariant</option>
        <option value="defines_rule">Defines rule</option>
        <option value="notes">Operational notes</option>
        <option value="read_by">Referenced in file</option>
        <option value="has_guardrail">Has guardrail</option>
        <option value="has_constraint">Has constraint</option>
        <option value="decides">Decides (ADR)</option>
        <option value="exposes_route">Exposes route</option>
        <option value="imports_module">Imports module</option>
        <option value="declared_dependency">Declared dependency</option>
      </datalist>
    </div>

    <div class="form-group">
      <label id="modal-obj-label">What Lore Should Remember</label>
      <textarea id="modal-obj" rows="3" placeholder="State the rule, invariant, configuration requirement, or instruction for AI agents..."></textarea>
    </div>

    <div id="modal-preview-box" style="background:#090d13; border:1px solid var(--line); border-radius:6px; padding:10px 12px; display:grid; gap:4px">
      <div style="font-size:10px; font-weight:700; color:var(--muted); text-transform:uppercase; letter-spacing:.05em">What AI Agents Will See (Live Retrieval Preview)</div>
      <div id="modal-preview-text" style="font-family:ui-monospace,Menlo,monospace; font-size:11px; color:var(--accent); line-height:1.4; word-break:break-all">
        [score 2.0] rule:general — enforces_invariant: "..." (active, canonical, T2 human)
      </div>
    </div>

    <div class="modal-actions">
      <button class="act" id="modal-cancel">Cancel</button>
      <button class="act primary" id="modal-save">Save Memory</button>
    </div>
  </div>
</div>

<script>
const CSRF = '__CSRF__';

const eventSource = new EventSource('/api/events');
eventSource.addEventListener('message', (e) => {
  console.log('SSE message:', e.data);
});
eventSource.addEventListener('memory:changed', () => {
  loadHealth();
  refreshKnowledge();
});
eventSource.addEventListener('claim:written', () => {
  loadHealth();
  refreshKnowledge();
});
eventSource.addEventListener('claim:approved', () => {
  loadHealth();
  refreshKnowledge();
  loadReview();
});
eventSource.addEventListener('repo:switched', () => {
  location.reload();
});
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
  'supersedes': 'Supersedes',
  'enforces_invariant': 'Enforces invariant',
  'defines_rule': 'Defines rule',
  'decides': 'Decides (ADR)',
  'has_guardrail': 'Has guardrail',
  'has_constraint': 'Has constraint',
  'notes': 'Operational notes'
};

let currentTab = 'knowledge';
let currentView = 'dossier';
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
  if (h.sync) {
    const syncEl = $('sync-indicator');
    const textEl = $('sync-text');
    const agentBadge = $('agent-count-badge');
    if (syncEl && textEl && agentBadge) {
      syncEl.className = 'sync-indicator';
      if (h.sync.remoteStatus === 'in sync') {
        syncEl.classList.add('synced');
        textEl.textContent = 'In sync';
      } else if (h.sync.remoteStatus === 'ahead') {
        syncEl.classList.add('ahead');
        textEl.textContent = 'Local ahead';
      } else if (h.sync.remoteStatus === 'behind') {
        syncEl.classList.add('behind');
        textEl.textContent = 'Behind';
      } else if (h.sync.remoteStatus === 'diverged') {
        syncEl.classList.add('diverged');
        textEl.textContent = 'Diverged';
      } else {
        textEl.textContent = 'Standalone';
      }

      if (h.sync.activeAgents > 0) {
        agentBadge.style.display = 'inline-block';
        agentBadge.textContent = h.sync.activeAgents + (h.sync.activeAgents === 1 ? ' agent' : ' agents');
      } else {
        agentBadge.style.display = 'none';
      }

      syncEl.title = 'Remote: ' + (h.sync.remoteType || 'none') + ' (' + h.sync.remoteStatus + ')' +
        ' | Active agents: ' + h.sync.activeAgents +
        ' | Last sync: ' + (h.sync.lastSyncAt || 'never');
    }
  }
  if (h.repo) {
    const nameEl = $('repo-name');
    if (nameEl) nameEl.textContent = h.repo.name;
    const badgeEl = $('repo-badge');
    if (badgeEl) badgeEl.title = 'Active Repository: ' + h.repo.path;
    const settingsRepo = $('settings-active-repo');
    if (settingsRepo) settingsRepo.textContent = h.repo.path;
  }
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

function renderDossierView(claims) {
  const box = $('dossier-view');
  box.replaceChildren();
  if (!claims.length) {
    box.append(el('div', 'No knowledge claims match the selected filters.', 'muted'));
    return;
  }

  const bySubject = new Map();
  for (const c of claims) {
    const list = bySubject.get(c.subject) || [];
    list.push(c);
    bySubject.set(c.subject, list);
  }

  for (const [subject, factList] of bySubject.entries()) {
    const card = el('div', undefined, 'd-card');

    let entityType = 'file';
    let label = subject;
    let badgeColor = '#58a6ff';
    if (subject.startsWith('env:')) { entityType = 'env'; label = subject.slice(4); badgeColor = '#d29922'; }
    else if (subject.startsWith('rule:')) { entityType = 'rule'; label = subject.slice(5); badgeColor = '#f85149'; }
    else if (subject.startsWith('doc:')) { entityType = 'doc'; label = subject.slice(4); badgeColor = '#bc8cff'; }
    else if (subject.startsWith('adr:')) { entityType = 'adr'; label = subject.slice(4); badgeColor = '#bc8cff'; }
    else if (subject.startsWith('pkg:')) { entityType = 'pkg'; label = subject.slice(4); badgeColor = '#56d364'; }
    else if (subject.startsWith('sym:')) { entityType = 'symbol'; label = subject.slice(4); badgeColor = '#39c5cf'; }
    else if (subject.startsWith('file:')) { entityType = 'file'; label = subject.slice(5); badgeColor = '#58a6ff'; }

    // Header
    const hdr = el('div', undefined, 'd-hdr');
    const titleBox = el('div', undefined, 'd-title-box');
    const badge = el('span', entityType, 'd-badge');
    badge.style.background = badgeColor + '22';
    badge.style.color = badgeColor;
    badge.style.border = '1px solid ' + badgeColor + '55';
    titleBox.append(badge);

    const titleEl = el('span', label, 'd-title');
    titleEl.title = subject;
    titleBox.append(titleEl);
    hdr.append(titleBox);

    const countTag = el('span', factList.length + ' fact' + (factList.length > 1 ? 's' : ''), 'tag muted');
    hdr.append(countTag);
    card.append(hdr);

    // Facts list
    const factsContainer = el('div', undefined, 'd-facts');
    for (const f of factList) {
      const item = el('div', undefined, 'd-fact-item');
      item.onclick = () => inspectClaim(f.id);

      const predLabel = PREDICATE_LABELS[f.predicate] || f.predicate;
      const predTag = el('span', predLabel, 'd-fact-pred');
      item.append(predTag);

      const valEl = el('span', f.object, 'd-fact-val');
      item.append(valEl);

      if (f.freshness === 'stale') {
        item.append(el('span', 'stale', 'tag stale'));
      }
      factsContainer.append(item);
    }
    card.append(factsContainer);

    // Footer
    const foot = el('div', undefined, 'd-foot');
    const tags = el('div', undefined, 'k-tags');
    const anyStale = factList.some(f => f.freshness === 'stale');
    tags.append(el('span', factList[0].state, 'tag ' + factList[0].state));
    tags.append(el('span', anyStale ? 'stale' : 'valid', 'tag ' + (anyStale ? 'stale' : 'valid')));
    foot.append(tags);

    const acts = el('div', undefined, 'k-tags');
    const addBtn = el('button', '+ Add Fact', 'act');
    addBtn.onclick = (e) => {
      e.stopPropagation();
      openNewModal({ scope: subject });
    };
    acts.append(addBtn);

    const inspBtn = el('button', 'Inspect', 'act');
    inspBtn.onclick = (e) => {
      e.stopPropagation();
      inspectClaim(factList[0].id);
    };
    acts.append(inspBtn);

    foot.append(acts);
    card.append(foot);

    box.append(card);
  }
}

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

let graphState = {
  zoom: 1,
  panX: 0,
  panY: 0,
  typeFilter: 'all',
  predicateFilter: 'all',
  clustered: true,
  highDensity: true,
  quadtree: null,
  hoveredNode: null,
  selectedNode: null,
  focusedSubgraph: null,
  isDragging: false,
  dragStartX: 0,
  dragStartY: 0,
};

let graphWorker = null;
function getGraphWorker() {
  if (graphWorker) return graphWorker;
  try {
    if (typeof Worker !== 'undefined') {
      graphWorker = new Worker('/graph-worker.js');
      return graphWorker;
    }
  } catch (err) {
    console.warn('[graph] Web Worker unavailable, using main thread', err);
  }
  return null;
}

function queryQuadtree(qt, qx, qy, maxRadius) {
  if (!qt) return null;
  let closest = null;
  let closestDistSq = maxRadius * maxRadius;

  function search(node) {
    if (!node) return;
    if (
      qx < node.x0 - maxRadius ||
      qx > node.x1 + maxRadius ||
      qy < node.y0 - maxRadius ||
      qy > node.y1 + maxRadius
    ) {
      return;
    }
    if (node.points) {
      for (let i = 0; i < node.points.length; i++) {
        const p = node.points[i];
        const dx = p.x - qx;
        const dy = p.y - qy;
        const dSq = dx * dx + dy * dy;
        if (dSq < closestDistSq) {
          closestDistSq = dSq;
          closest = p;
        }
      }
      return;
    }
    if (node.children) {
      for (let i = 0; i < node.children.length; i++) {
        search(node.children[i]);
      }
    }
  }

  search(qt);
  return closest;
}

function highlightHoveredNode(nodeId) {
  if (graphState.selectedNode) return;
  const vp = $('graph-viewport');
  if (!vp) return;
  const nodes = vp.querySelectorAll('.node');
  const links = vp.querySelectorAll('.link');
  if (!nodeId) {
    for (const n of nodes) n.style.opacity = '1';
    for (const l of links) { l.style.opacity = '0.65'; l.style.strokeWidth = '1.5'; }
    return;
  }
  for (const n of nodes) {
    n.style.opacity = n.getAttribute('data-id') === nodeId ? '1' : '0.25';
  }
  for (const l of links) {
    const isConn = l.getAttribute('data-source') === nodeId || l.getAttribute('data-target') === nodeId;
    l.style.opacity = isConn ? '1' : '0.12';
    l.style.strokeWidth = isConn ? '2.5' : '1';
  }
}

function runLocalSimulation(nodes, links, width, height, clustered) {
  const start = Date.now();
  const total = nodes.length;
  const nodeMap = new Map();
  for (let i = 0; i < total; i++) nodeMap.set(nodes[i].id, nodes[i]);

  const clusterCentroids = {
    file: { x: width * 0.42, y: height * 0.46 },
    env:  { x: width * 0.82, y: height * 0.28 },
    pkg:  { x: width * 0.18, y: height * 0.72 },
    doc:  { x: width * 0.80, y: height * 0.75 },
    obj:  { x: width * 0.50, y: height * 0.58 },
  };

  for (let idx = 0; idx < total; idx++) {
    const n = nodes[idx];
    if (clustered) {
      const cCenter = clusterCentroids[n.type] || clusterCentroids.file;
      const angle = (idx / (total || 1)) * 2 * Math.PI;
      const jitter = 40 + (idx % 6) * 16;
      n.x = cCenter.x + Math.cos(angle) * jitter;
      n.y = cCenter.y + Math.sin(angle) * jitter;
    } else {
      const angle = (idx / (total || 1)) * 2 * Math.PI;
      const r = 110 + (idx % 4) * 55;
      n.x = width / 2 + Math.cos(angle) * r;
      n.y = height / 2 + Math.sin(angle) * r;
    }
  }

  const iterations = total > 500 ? 50 : 80;
  const cellSize = 100;
  for (let iter = 0; iter < iterations; iter++) {
    const decay = 1 - (iter / iterations) * 0.7;
    if (total <= 250) {
      for (let i = 0; i < total; i++) {
        const a = nodes[i];
        for (let j = i + 1; j < total; j++) {
          const b = nodes[j];
          const dx = b.x - a.x;
          const dy = b.y - a.y;
          const minDist = 110 + Math.min(25, Math.max(a.degree, b.degree)) * 6;
          const dSq = dx * dx + dy * dy;
          if (dSq < minDist * minDist) {
            const dist = Math.sqrt(dSq) || 1;
            const f = ((minDist - dist) / dist) * 0.35 * decay;
            a.x -= dx * f; a.y -= dy * f;
            b.x += dx * f; b.y += dy * f;
          }
        }
      }
    } else {
      const grid = new Map();
      for (let i = 0; i < total; i++) {
        const n = nodes[i];
        const gx = Math.floor(n.x / cellSize);
        const gy = Math.floor(n.y / cellSize);
        const k = (gx << 16) ^ gy;
        let bucket = grid.get(k);
        if (!bucket) { bucket = []; grid.set(k, bucket); }
        bucket.push(n);
      }
      for (let i = 0; i < total; i++) {
        const a = nodes[i];
        const gx = Math.floor(a.x / cellSize);
        const gy = Math.floor(a.y / cellSize);
        for (let ox = -1; ox <= 1; ox++) {
          for (let oy = -1; oy <= 1; oy++) {
            const k = ((gx + ox) << 16) ^ (gy + oy);
            const bucket = grid.get(k);
            if (!bucket) continue;
            for (let bIdx = 0; bIdx < bucket.length; bIdx++) {
              const b = bucket[bIdx];
              if (b.id <= a.id) continue;
              const dx = b.x - a.x;
              const dy = b.y - a.y;
              const minDist = 90 + Math.min(20, Math.max(a.degree, b.degree)) * 4;
              const dSq = dx * dx + dy * dy;
              if (dSq < minDist * minDist) {
                const dist = Math.sqrt(dSq) || 1;
                const f = ((minDist - dist) / dist) * 0.30 * decay;
                a.x -= dx * f; a.y -= dy * f;
                b.x += dx * f; b.y += dy * f;
              }
            }
          }
        }
      }
    }
    for (let l = 0; l < links.length; l++) {
      const link = links[l];
      const src = typeof link.source === 'object' ? link.source : nodeMap.get(link.source);
      const tgt = typeof link.target === 'object' ? link.target : nodeMap.get(link.target);
      if (!src || !tgt) continue;
      const dx = tgt.x - src.x;
      const dy = tgt.y - src.y;
      const dist = Math.sqrt(dx * dx + dy * dy) || 1;
      const hubBonus = Math.min(25, Math.max(src.degree, tgt.degree)) * 6;
      const targetDist = 95 + hubBonus;
      const f = (dist - targetDist) * 0.04 * decay;
      src.x += (dx / dist) * f;
      src.y += (dy / dist) * f;
      tgt.x -= (dx / dist) * f;
      tgt.y -= (dy / dist) * f;
    }
    if (clustered) {
      for (let i = 0; i < total; i++) {
        const n = nodes[i];
        const cCenter = clusterCentroids[n.type] || clusterCentroids.file;
        n.x += (cCenter.x - n.x) * 0.045 * decay;
        n.y += (cCenter.y - n.y) * 0.045 * decay;
      }
    } else {
      for (let i = 0; i < total; i++) {
        const n = nodes[i];
        n.x += (width / 2 - n.x) * 0.025 * decay;
        n.y += (height / 2 - n.y) * 0.025 * decay;
      }
    }
  }

  if (total > 0) {
    let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
    for (let i = 0; i < total; i++) {
      const n = nodes[i];
      if (n.x < minX) minX = n.x;
      if (n.x > maxX) maxX = n.x;
      if (n.y < minY) minY = n.y;
      if (n.y > maxY) maxY = n.y;
    }
    const rangeX = maxX - minX || 1;
    const rangeY = maxY - minY || 1;
    const padX = 75;
    const padY = 55;
    const targetW = width - padX * 2;
    const targetH = height - padY * 2;
    for (let i = 0; i < total; i++) {
      const n = nodes[i];
      n.x = padX + ((n.x - minX) / rangeX) * targetW;
      n.y = padY + ((n.y - minY) / rangeY) * targetH;
    }
  }

  function createQuadtree(pts, x0, y0, x1, y1, depth) {
    if (depth > 8 || pts.length <= 4) return { x0, y0, x1, y1, points: pts };
    const midX = (x0 + x1) / 2;
    const midY = (y0 + y1) / 2;
    const q0 = [], q1 = [], q2 = [], q3 = [];
    for (let i = 0; i < pts.length; i++) {
      const p = pts[i];
      if (p.x < midX) {
        if (p.y < midY) q0.push(p); else q2.push(p);
      } else {
        if (p.y < midY) q1.push(p); else q3.push(p);
      }
    }
    return {
      x0, y0, x1, y1,
      children: [
        createQuadtree(q0, x0, y0, midX, midY, depth + 1),
        createQuadtree(q1, midX, y0, x1, midY, depth + 1),
        createQuadtree(q2, x0, midY, midX, y1, depth + 1),
        createQuadtree(q3, midX, midY, x1, y1, depth + 1),
      ]
    };
  }

  const quadtree = createQuadtree(nodes.map(n => ({ id: n.id, x: n.x, y: n.y })), 0, 0, width, height, 0);
  return { nodes, quadtree, durationMs: Date.now() - start, isWorker: false };
}

function updateGraphTransform() {
  const vp = $('graph-viewport');
  if (vp) {
    vp.setAttribute('transform', 'translate(' + graphState.panX + ',' + graphState.panY + ') scale(' + graphState.zoom + ')');
  }
}

function resetGraphSelection() {
  graphState.selectedNode = null;
  graphState.focusedSubgraph = null;
  const drawer = $('graph-drawer');
  if (drawer) drawer.style.display = 'none';
  const resetBtn = $('graph-reset-selection');
  if (resetBtn) resetBtn.style.display = 'none';

  const svg = $('graph-svg');
  if (svg) {
    for (const el of svg.querySelectorAll('.node')) el.classList.remove('selected', 'dimmed');
    for (const el of svg.querySelectorAll('.link')) el.classList.remove('highlighted', 'dimmed');
  }
  renderActiveView();
}

function selectGraphNode(n, links, claims) {
  graphState.selectedNode = n.id;
  const svg = $('graph-svg');

  const neighborIds = new Set([n.id]);
  for (const l of links) {
    if (l.source.id === n.id || l.target.id === n.id) {
      neighborIds.add(l.source.id);
      neighborIds.add(l.target.id);
    }
  }

  for (const g of svg.querySelectorAll('.node')) {
    const id = g.getAttribute('data-id');
    if (id === n.id) {
      g.classList.add('selected');
      g.classList.remove('dimmed');
    } else if (neighborIds.has(id)) {
      g.classList.remove('dimmed', 'selected');
    } else {
      g.classList.add('dimmed');
      g.classList.remove('selected');
    }
  }
  for (const l of svg.querySelectorAll('.link')) {
    const src = l.getAttribute('data-source');
    const tgt = l.getAttribute('data-target');
    if (src === n.id || tgt === n.id) {
      l.classList.add('highlighted');
      l.classList.remove('dimmed');
    } else {
      l.classList.add('dimmed');
      l.classList.remove('highlighted');
    }
  }

  const drawer = $('graph-drawer');
  const dType = $('drawer-type');
  const dTitle = $('drawer-title');
  const dRels = $('drawer-relations');
  const dFocusBtn = $('drawer-focus-btn');
  const resetBtn = $('graph-reset-selection');

  let typeLabel = 'Value';
  let typeTagClass = 'tag';
  if (n.type === 'file') { typeLabel = 'Source File'; typeTagClass = 'tag file'; }
  else if (n.type === 'env') { typeLabel = 'Environment Var'; typeTagClass = 'tag draft'; }
  else if (n.type === 'pkg') { typeLabel = 'Package / Module'; typeTagClass = 'tag active'; }
  else if (n.type === 'doc') { typeLabel = 'Doc / Rule'; typeTagClass = 'tag valid'; }

  dType.textContent = typeLabel;
  dType.className = typeTagClass;
  dTitle.textContent = n.id;

  dRels.replaceChildren();
  const touchingClaims = claims.filter(c => c.subject === n.id || String(c.object).slice(0, 30) === n.id || String(c.object) === n.id);
  if (!touchingClaims.length) {
    dRels.append(el('div', 'No direct claims in current sample.', 'muted'));
  } else {
    for (const c of touchingClaims) {
      const item = el('div', undefined, 'drawer-item');
      const relRow = el('div', undefined, 'drawer-item-rel');
      const relTxt = el('span', c.predicate + ' ' + (c.subject === n.id ? '→ ' + String(c.object).slice(0, 22) : '← ' + c.subject));
      relTxt.style.fontWeight = '600';
      relRow.append(relTxt);

      const insp = el('button', 'Inspect', 'act');
      insp.style.padding = '2px 6px';
      insp.onclick = (e) => { e.stopPropagation(); inspectClaim(c.id); };
      relRow.append(insp);

      item.append(relRow);
      const subRow = el('div', undefined, 'k-tags');
      subRow.append(el('span', c.state, 'tag ' + c.state), el('span', c.freshness, 'tag ' + c.freshness));
      item.append(subRow);
      dRels.append(item);
    }
  }

  dFocusBtn.textContent = graphState.focusedSubgraph === n.id ? 'Show Full Graph' : 'Focus Only This Subgraph';
  dFocusBtn.onclick = () => {
    graphState.focusedSubgraph = graphState.focusedSubgraph === n.id ? null : n.id;
    renderActiveView();
  };

  drawer.style.display = 'flex';
  resetBtn.style.display = 'inline-block';
}

function shortLabel(id) {
  if (!id) return '';
  if (id.startsWith('file:') || id.startsWith('doc:')) {
    const raw = id.slice(id.indexOf(':') + 1);
    const parts = raw.split('/');
    return parts.length > 1 ? parts.slice(-2).join('/') : raw;
  }
  if (id.startsWith('env:') || id.startsWith('rule:') || id.startsWith('pkg:')) {
    return id.slice(id.indexOf(':') + 1);
  }
  if (id.startsWith('sym:')) {
    return id.split('#').pop() || id;
  }
  return id.length > 25 ? id.slice(0, 22) + '…' : id;
}

function renderGraphView(claims) {
  const svg = $('graph-svg');
  let viewport = $('graph-viewport');
  if (!viewport) {
    svg.replaceChildren();
    viewport = document.createElementNS('http://www.w3.org/2000/svg', 'g');
    viewport.setAttribute('id', 'graph-viewport');
    svg.append(viewport);
  } else {
    viewport.replaceChildren();
  }

  const width = svg.clientWidth || 920;
  const height = 580;
  svg.setAttribute('viewBox', '0 0 ' + width + ' ' + height);
  updateGraphTransform();

  let targetClaims = claims;
  if (graphState.focusedSubgraph) {
    const focusId = graphState.focusedSubgraph;
    targetClaims = claims.filter(c => c.subject === focusId || String(c.object).slice(0, 30) === focusId || String(c.object) === focusId);
    $('graph-reset-selection').style.display = 'inline-block';
  } else if (!graphState.selectedNode) {
    $('graph-reset-selection').style.display = 'none';
  }

  // Populate predicate selector dynamically from available claims
  const predSelect = $('graph-predicate-select');
  if (predSelect) {
    const availablePreds = new Set();
    for (const c of claims) {
      if (c.predicate) availablePreds.add(c.predicate);
    }
    const currentVal = graphState.predicateFilter || 'all';
    predSelect.replaceChildren();
    const allOpt = document.createElement('option');
    allOpt.value = 'all';
    allOpt.textContent = 'All Relationships';
    predSelect.append(allOpt);
    for (const pred of Array.from(availablePreds).sort()) {
      const opt = document.createElement('option');
      opt.value = pred;
      opt.textContent = (PREDICATE_LABELS[pred] || pred) + ' (' + pred + ')';
      predSelect.append(opt);
    }
    predSelect.value = availablePreds.has(currentVal) ? currentVal : 'all';
    graphState.predicateFilter = predSelect.value;
  }

  if (graphState.predicateFilter && graphState.predicateFilter !== 'all') {
    targetClaims = targetClaims.filter(c => c.predicate === graphState.predicateFilter);
  }

  if (graphState.typeFilter !== 'all') {
    targetClaims = targetClaims.filter(c => {
      if (graphState.typeFilter === 'env') return c.subject.startsWith('env:');
      if (graphState.typeFilter === 'file') return c.subject.startsWith('file:') || String(c.object).startsWith('src/') || String(c.object).endsWith('.ts');
      if (graphState.typeFilter === 'pkg') return c.subject.startsWith('pkg:') || c.predicate === 'imports_module';
      if (graphState.typeFilter === 'doc') return c.subject.startsWith('doc:') || c.subject.startsWith('rule:');
      if (graphState.typeFilter === 'internal') {
        const isPkg = c.subject.startsWith('pkg:') || (c.predicate === 'imports_module' && !String(c.object).startsWith('.') && !String(c.object).startsWith('src/'));
        return !isPkg;
      }
      return true;
    });
  }

  const nodes = new Map();
  const links = [];

  const addNode = (id, type) => {
    if (!nodes.has(id)) {
      nodes.set(id, { id, type, x: 0, y: 0, degree: 0 });
    }
    return nodes.get(id);
  };

  const maxSample = graphState.highDensity ? 1200 : 85;
  const sample = targetClaims.slice(0, maxSample);
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
    sNode.degree++;
    oNode.degree++;
    links.push({ source: sNode, target: oNode, label: c.predicate });
  }

  $('graph-stat').textContent = nodes.size + ' nodes, ' + links.length + ' relations (calculating layout...)';

  function renderGraphElements(nodeMap, linkList) {
    viewport.replaceChildren();
    const getLinkStyle = (predicate) => {
      if (predicate === 'imports_module') return { color: '#bc8cff', marker: 'url(#arrow-imports)' };
      if (predicate === 'read_by') return { color: '#d29922', marker: 'url(#arrow-read)' };
      if (predicate === 'enforces_invariant') return { color: '#f85149', marker: 'url(#arrow-invariant)' };
      if (predicate === 'exposes_route') return { color: '#2ea043', marker: 'url(#arrow-route)' };
      return { color: '#58a6ff', marker: 'url(#arrow-default)' };
    };

    for (const l of linkList) {
      const line = document.createElementNS('http://www.w3.org/2000/svg', 'line');
      const style = getLinkStyle(l.label);
      line.setAttribute('x1', l.source.x); line.setAttribute('y1', l.source.y);
      line.setAttribute('x2', l.target.x); line.setAttribute('y2', l.target.y);
      line.setAttribute('class', 'link');
      line.setAttribute('stroke', style.color);
      line.setAttribute('stroke-opacity', '0.65');
      line.setAttribute('stroke-width', '1.5');
      line.setAttribute('marker-end', style.marker);
      line.setAttribute('data-source', l.source.id);
      line.setAttribute('data-target', l.target.id);
      line.setAttribute('data-predicate', l.label);

      const titleEl = document.createElementNS('http://www.w3.org/2000/svg', 'title');
      titleEl.textContent = l.source.id + ' — [' + l.label + '] → ' + l.target.id;
      line.append(titleEl);

      viewport.append(line);
    }

    const nodeArr = Array.from(nodeMap.values());
    for (const n of nodeArr) {
      const g = document.createElementNS('http://www.w3.org/2000/svg', 'g');
      g.setAttribute('class', 'node' + (graphState.selectedNode === n.id ? ' selected' : ''));
      g.setAttribute('data-id', n.id);
      g.setAttribute('transform', 'translate(' + n.x + ',' + n.y + ')');

      const titleEl = document.createElementNS('http://www.w3.org/2000/svg', 'title');
      titleEl.textContent = n.id + ' (' + n.degree + ' connection' + (n.degree === 1 ? '' : 's') + ')';
      g.append(titleEl);

      const circle = document.createElementNS('http://www.w3.org/2000/svg', 'circle');
      const r = Math.min(14, 7 + Math.floor(Math.sqrt(n.degree || 1) * 2));
      circle.setAttribute('r', String(r));
      let color = '#58a6ff';
      if (n.type === 'env') color = '#d29922';
      else if (n.type === 'pkg') color = '#bc8cff';
      else if (n.type === 'doc') color = '#f85149';
      else if (n.type === 'obj') color = '#8b949e';
      circle.setAttribute('fill', color);
      circle.setAttribute('stroke', '#161b22');
      g.append(circle);

      const text = document.createElementNS('http://www.w3.org/2000/svg', 'text');
      text.setAttribute('dx', String(r + 5));
      text.setAttribute('dy', '4');
      text.textContent = shortLabel(n.id);
      g.append(text);

      g.onclick = (e) => {
        e.stopPropagation();
        selectGraphNode(n, linkList, targetClaims);
      };

      viewport.append(g);
    }

    if (graphState.selectedNode && nodeMap.has(graphState.selectedNode)) {
      selectGraphNode(nodeMap.get(graphState.selectedNode), linkList, targetClaims);
    }
  }

  const worker = getGraphWorker();
  if (worker) {
    worker.onmessage = (e) => {
      if (e.data && e.data.type === 'complete') {
        const posMap = new Map();
        for (const n of e.data.nodes) posMap.set(n.id, n);
        for (const n of nodes.values()) {
          const p = posMap.get(n.id);
          if (p) { n.x = p.x; n.y = p.y; }
        }
        graphState.quadtree = e.data.quadtree;
        $('graph-stat').textContent = nodes.size + ' nodes, ' + links.length + ' relations (worker: ' + e.data.durationMs + 'ms, quadtree indexed)';
        renderGraphElements(nodes, links);
      }
    };
    worker.postMessage({
      type: 'simulate',
      nodes: Array.from(nodes.values()).map(n => ({ id: n.id, type: n.type, degree: n.degree })),
      links: links.map(l => ({ source: l.source.id, target: l.target.id, label: l.label })),
      width,
      height,
      clustered: graphState.clustered,
    });
  } else {
    const res = runLocalSimulation(Array.from(nodes.values()), links, width, height, graphState.clustered);
    graphState.quadtree = res.quadtree;
    $('graph-stat').textContent = nodes.size + ' nodes, ' + links.length + ' relations (main: ' + res.durationMs + 'ms, quadtree indexed)';
    renderGraphElements(nodes, links);
  }
}

function renderActiveView() {
  const filtered = filterClaimsList();
  if (currentView === 'dossier') renderDossierView(filtered);
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
  if (data.repo) {
    const settingsRepo = $('settings-active-repo');
    if (settingsRepo) settingsRepo.textContent = data.repo.path;
  }
  for (const [k, v] of [
    ['active repository', data.repo ? data.repo.path : '—'],
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

let currentMemoryType = 'rule';

function setMemoryType(type) {
  currentMemoryType = type;
  for (const b of document.querySelectorAll('#modal-type-selector .type-pill')) {
    b.classList.toggle('on', b.dataset.type === type);
  }
  const scopeLabel = $('modal-scope-label');
  const scopeInput = $('modal-scope');
  const scopeHint = $('modal-scope-hint');
  const predGroup = $('form-group-pred');
  const objLabel = $('modal-obj-label');
  const objInput = $('modal-obj');

  if (type === 'rule') {
    scopeLabel.textContent = 'Rule Identifier or Target Scope';
    scopeInput.placeholder = 'e.g. auth:bearer-token or src/server.ts';
    scopeHint.textContent = 'Rule name or target scope. Prepends rule: if omitted.';
    predGroup.style.display = 'none';
    objLabel.textContent = 'Rule Statement / Guideline';
    objInput.placeholder = 'State what AI agents must follow when touching this code...';
  } else if (type === 'env') {
    scopeLabel.textContent = 'Environment Variable Name';
    scopeInput.placeholder = 'e.g. DATABASE_URL, LORE_TOKEN';
    scopeHint.textContent = 'Env var name. Prepends env: if omitted.';
    predGroup.style.display = 'none';
    objLabel.textContent = 'Configuration Requirement / Fallback';
    objInput.placeholder = 'Describe usage, format, default value, or fallback behavior...';
  } else if (type === 'invariant') {
    scopeLabel.textContent = 'Target File or Symbol';
    scopeInput.placeholder = 'e.g. src/remotes/postgres.ts or src/db.ts#openDb';
    scopeHint.textContent = 'Target file or symbol where this invariant holds.';
    predGroup.style.display = 'none';
    objLabel.textContent = 'Code Invariant / Guardrail';
    objInput.placeholder = 'State the technical guardrail or critical business constraint...';
  } else if (type === 'custom') {
    scopeLabel.textContent = 'Subject (Entity ID)';
    scopeInput.placeholder = 'e.g. doc:SPEC.md, rule:auth, env:PORT';
    scopeHint.textContent = 'Exact subject entity id.';
    predGroup.style.display = 'grid';
    objLabel.textContent = 'Object Value';
    objInput.placeholder = 'Factual assertion or object value...';
  }
  updateModalPreview();
}

function updateModalPreview() {
  const scope = ($('modal-scope').value || '').trim();
  const obj = ($('modal-obj').value || '').trim();
  const pred = ($('modal-pred').value || '').trim();

  let s = scope;
  let p = pred;
  if (currentMemoryType === 'rule') {
    s = scope ? (scope.startsWith('rule:') || scope.startsWith('file:') || scope.startsWith('doc:') ? scope : 'rule:' + scope) : 'rule:<name>';
    p = scope && scope.startsWith('doc:') ? 'defines_rule' : 'enforces_invariant';
  } else if (currentMemoryType === 'env') {
    s = scope ? (scope.startsWith('env:') ? scope : 'env:' + scope) : 'env:<NAME>';
    p = 'notes';
  } else if (currentMemoryType === 'invariant') {
    s = scope ? (scope.startsWith('file:') || scope.startsWith('sym:') ? scope : 'file:' + scope) : 'file:<path>';
    p = 'has_guardrail';
  } else if (currentMemoryType === 'custom') {
    s = scope || '<subject>';
    p = pred || '<predicate>';
  }

  const statement = obj ? '"' + obj + '"' : '"..."';
  $('modal-preview-text').textContent = '[score 2.0] ' + s + ' — ' + p + ': ' + statement + ' (active, canonical, T2 human)';
}

for (const btn of document.querySelectorAll('#modal-type-selector .type-pill')) {
  btn.onclick = () => setMemoryType(btn.dataset.type);
}
$('modal-scope').oninput = updateModalPreview;
$('modal-obj').oninput = updateModalPreview;
$('modal-pred').oninput = updateModalPreview;

async function loadEntitySuggestions() {
  try {
    const list = await (await fetch('/api/entities')).json();
    const datalist = $('entity-suggestions');
    if (!datalist) return;
    datalist.replaceChildren();
    for (const ent of list) {
      const opt = document.createElement('option');
      opt.value = ent.id;
      opt.textContent = '[' + ent.type + '] ' + ent.label;
      datalist.append(opt);
    }
  } catch {
    // ignore
  }
}

function openNewModal(prefill) {
  editingClaim = null;
  $('modal-title').textContent = 'Record Memory for AI Agents';
  $('modal-audit-note').style.display = 'none';
  $('modal-type-container').style.display = 'grid';
  $('modal-scope').disabled = false;
  $('modal-pred').disabled = false;
  $('modal-obj').value = '';

  let initialType = 'rule';
  if (prefill && prefill.type) initialType = prefill.type;
  else if (prefill && prefill.scope) {
    if (prefill.scope.startsWith('env:')) initialType = 'env';
    else if (prefill.scope.startsWith('file:') || prefill.scope.startsWith('sym:')) initialType = 'invariant';
    else if (prefill.scope.startsWith('rule:')) initialType = 'rule';
  }
  setMemoryType(initialType);

  if (prefill && prefill.scope) {
    $('modal-scope').value = prefill.scope;
  } else {
    $('modal-scope').value = '';
  }
  if (prefill && prefill.predicate) {
    $('modal-pred').value = prefill.predicate;
  }
  updateModalPreview();
  loadEntitySuggestions();
  $('claim-modal').style.display = 'flex';
}

function openEditModal(claim) {
  editingClaim = claim;
  $('modal-title').textContent = 'Edit / Supersede Memory';
  $('modal-audit-note').style.display = 'block';
  $('modal-type-container').style.display = 'none';
  setMemoryType('custom');
  $('modal-scope').value = claim.subject;
  $('modal-scope').disabled = true;
  $('form-group-pred').style.display = 'grid';
  $('modal-pred').value = claim.predicate;
  $('modal-pred').disabled = true;
  $('modal-obj').value = claim.object;
  updateModalPreview();
  $('claim-modal').style.display = 'flex';
}

function closeModal() {
  $('claim-modal').style.display = 'none';
  editingClaim = null;
}

$('btn-new-claim').onclick = () => openNewModal();
$('modal-cancel').onclick = closeModal;
$('modal-save').onclick = async () => {
  const scope = $('modal-scope').value.trim();
  const obj = $('modal-obj').value.trim();
  const customPred = $('modal-pred').value.trim();
  if (!obj) { banner('Memory statement cannot be empty', 'err'); return; }

  try {
    if (editingClaim) {
      await api('/api/supersede', { claim: editingClaim.id, object: obj });
      banner('Superseded memory ' + editingClaim.id, 'ok');
    } else {
      if (!scope) { banner('Target scope or entity is required', 'err'); return; }
      let subject = scope;
      let predicate = 'enforces_invariant';

      if (currentMemoryType === 'rule') {
        subject = scope.startsWith('rule:') || scope.startsWith('file:') || scope.startsWith('doc:') ? scope : 'rule:' + scope;
        predicate = scope.startsWith('doc:') ? 'defines_rule' : 'enforces_invariant';
      } else if (currentMemoryType === 'env') {
        subject = scope.startsWith('env:') ? scope : 'env:' + scope;
        predicate = 'notes';
      } else if (currentMemoryType === 'invariant') {
        subject = scope.startsWith('file:') || scope.startsWith('sym:') ? scope : 'file:' + scope;
        predicate = 'has_guardrail';
      } else if (currentMemoryType === 'custom') {
        if (!customPred) { banner('Predicate is required in Custom mode', 'err'); return; }
        subject = scope;
        predicate = customPred;
      }

      await api('/api/claim', { subject, predicate, object: obj });
      banner('Recorded memory: ' + subject, 'ok');
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
  $('view-dossier').classList.toggle('on', view === 'dossier');
  $('view-cards').classList.toggle('on', view === 'cards');
  $('view-graph').classList.toggle('on', view === 'graph');
  $('view-raw').classList.toggle('on', view === 'raw');

  $('dossier-view').style.display = view === 'dossier' ? 'grid' : 'none';
  $('cards-view').style.display = view === 'cards' ? 'grid' : 'none';
  $('graph-box').style.display = view === 'graph' ? 'block' : 'none';
  $('raw-view').style.display = view === 'raw' ? 'block' : 'none';

  renderActiveView();
}

$('view-dossier').onclick = () => switchView('dossier');
$('view-cards').onclick = () => switchView('cards');
$('view-graph').onclick = () => switchView('graph');
$('view-raw').onclick = () => switchView('raw');

// Graph mouse pan and zoom interactions
const graphSvg = $('graph-svg');
graphSvg.onmousedown = (e) => {
  if (e.target === graphSvg || e.target.id === 'graph-viewport' || e.target.tagName.toLowerCase() === 'line') {
    graphState.isDragging = true;
    graphState.dragStartX = e.clientX - graphState.panX;
    graphState.dragStartY = e.clientY - graphState.panY;
  }
};
window.addEventListener('mousemove', (e) => {
  if (!graphState.isDragging) return;
  graphState.panX = e.clientX - graphState.dragStartX;
  graphState.panY = e.clientY - graphState.dragStartY;
  updateGraphTransform();
});
window.addEventListener('mouseup', () => {
  graphState.isDragging = false;
});
graphSvg.onwheel = (e) => {
  e.preventDefault();
  const factor = e.deltaY < 0 ? 1.15 : 0.87;
  graphState.zoom = Math.min(Math.max(graphState.zoom * factor, 0.3), 3.5);
  updateGraphTransform();
};
graphSvg.onclick = (e) => {
  if (e.target === graphSvg || e.target.id === 'graph-viewport') {
    if (graphState.selectedNode) {
      resetGraphSelection();
    }
  }
};
graphSvg.onmousemove = (e) => {
  if (graphState.isDragging || !graphState.quadtree) return;
  const rect = graphSvg.getBoundingClientRect();
  const mx = (e.clientX - rect.left - graphState.panX) / graphState.zoom;
  const my = (e.clientY - rect.top - graphState.panY) / graphState.zoom;
  const hit = queryQuadtree(graphState.quadtree, mx, my, 22);
  const hitId = hit ? hit.id : null;
  if (graphState.hoveredNode !== hitId) {
    graphState.hoveredNode = hitId;
    highlightHoveredNode(hitId);
  }
};
graphSvg.onmouseleave = () => {
  if (graphState.hoveredNode) {
    graphState.hoveredNode = null;
    highlightHoveredNode(null);
  }
};

$('graph-zoom-in').onclick = () => {
  graphState.zoom = Math.min(graphState.zoom * 1.25, 3.5);
  updateGraphTransform();
};
$('graph-zoom-out').onclick = () => {
  graphState.zoom = Math.max(graphState.zoom / 1.25, 0.3);
  updateGraphTransform();
};
$('graph-zoom-reset').onclick = () => {
  graphState.zoom = 1;
  graphState.panX = 0;
  graphState.panY = 0;
  updateGraphTransform();
};
$('graph-reset-selection').onclick = resetGraphSelection;
$('drawer-close').onclick = resetGraphSelection;
$('drawer-reset-btn').onclick = resetGraphSelection;

for (const btn of document.querySelectorAll('#graph-type-filters button')) {
  btn.onclick = () => {
    for (const b of document.querySelectorAll('#graph-type-filters button')) b.classList.remove('on');
    btn.classList.add('on');
    graphState.typeFilter = btn.dataset.type;
    renderActiveView();
  };
}

const predSelectEl = $('graph-predicate-select');
if (predSelectEl) {
  predSelectEl.onchange = (e) => {
    graphState.predicateFilter = e.target.value;
    renderActiveView();
  };
}

const clusterModeBtn = $('graph-cluster-mode');
if (clusterModeBtn) {
  clusterModeBtn.onclick = () => {
    graphState.clustered = !graphState.clustered;
    clusterModeBtn.textContent = graphState.clustered ? 'Clusters: ON' : 'Clusters: OFF';
    clusterModeBtn.classList.toggle('on', graphState.clustered);
    renderActiveView();
  };
}

const densityToggleBtn = $('graph-density-toggle');
if (densityToggleBtn) {
  densityToggleBtn.onclick = () => {
    graphState.highDensity = !graphState.highDensity;
    densityToggleBtn.textContent = graphState.highDensity ? 'Density: High' : 'Density: Standard';
    densityToggleBtn.classList.toggle('on', graphState.highDensity);
    renderActiveView();
  };
}

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

function renderCardsSkeleton() {
  const cards = $('cards');
  if (!cards) return;
  cards.replaceChildren();
  for (let i = 0; i < 4; i++) {
    const c = el('div', undefined, 'card skeleton-shimmer');
    c.innerHTML = '<div class="skeleton-line big"></div><div class="skeleton-line short"></div><div class="skeleton-line mid"></div>';
    cards.append(c);
  }
}

function renderKnowledgeSkeleton() {
  const grid = $('knowledge-grid');
  if (!grid) return;
  grid.replaceChildren();
  for (let i = 0; i < 6; i++) {
    const k = el('div', undefined, 'k-card skeleton-shimmer');
    k.innerHTML = '<div class="skeleton-line mid"></div><div class="skeleton-line short"></div><div class="skeleton-line big" style="height:48px;width:100%"></div>';
    grid.append(k);
  }
}

async function triggerSwitchRepo() {
  banner('Opening folder browser...', 'muted');
  try {
    const browseRes = await api('/api/repo/browse', {});
    if (browseRes.switched) {
      banner('Switched to repository: ' + browseRes.repo.name, 'ok');
      await refreshAll();
      return;
    }
    if (browseRes.cancelled) {
      banner('', '');
      return;
    }
  } catch {
    // If native browse failed or cancelled, fallback to prompt
  }
  const current = $('repo-name')?.title || '';
  const target = window.prompt('Enter path to repository folder:', current);
  if (target && target.trim()) {
    try {
      const res = await api('/api/repo/switch', { path: target.trim() });
      if (res.ok) {
        banner('Switched to repository: ' + res.repo.name, 'ok');
        await refreshAll();
      }
    } catch (e) {
      banner(e.message, 'err');
    }
  }
}

async function refreshAll() {
  renderCardsSkeleton();
  renderKnowledgeSkeleton();
  await refreshKnowledge();
  if (currentTab === 'review') await loadReview();
  if (currentTab === 'undo') await loadCommits();
  if (currentTab === 'ontology') await loadOntology();
  if (currentTab === 'settings') await loadSettings();
}

const switchBtn = $('btn-switch-repo');
if (switchBtn) switchBtn.onclick = triggerSwitchRepo;
const settingsSwitchBtn = $('settings-switch-repo-btn');
if (settingsSwitchBtn) settingsSwitchBtn.onclick = triggerSwitchRepo;

renderCardsSkeleton();
renderKnowledgeSkeleton();
refreshKnowledge();

let liveRefreshTimer = null;
function scheduleLiveRefresh() {
  if (liveRefreshTimer) clearTimeout(liveRefreshTimer);
  liveRefreshTimer = setTimeout(() => {
    loadHealth().catch(() => {});
    if (currentTab === 'knowledge') refreshKnowledge();
    else if (currentTab === 'review') loadReview();
    else if (currentTab === 'undo') loadCommits();
  }, 200);
}

function initEventStream() {
  if (typeof EventSource === 'undefined') return;
  const indicator = $('live-indicator');
  let es;
  try {
    es = new EventSource('/api/events');
  } catch {
    if (indicator) indicator.classList.add('offline');
    return;
  }

  es.addEventListener('open', () => {
    if (indicator) {
      indicator.classList.remove('offline');
      indicator.title = 'Live real-time stream active';
    }
  });

  es.addEventListener('connected', () => {
    if (indicator) indicator.classList.remove('offline');
  });

  ['claim:written', 'claim:approved', 'claim:rejected', 'claim:superseded', 'claim:reverted', 'claim:attested', 'memory:changed', 'repo:switched'].forEach((evt) => {
    es.addEventListener(evt, () => {
      scheduleLiveRefresh();
    });
  });

  es.addEventListener('error', () => {
    if (indicator) {
      indicator.classList.add('offline');
      indicator.title = 'Reconnecting to live stream...';
    }
  });
}
initEventStream();
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

const LORE_FAVICON_SVG = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 512 512" fill="none" role="img" aria-label="Lore">
  <rect width="512" height="512" rx="96" fill="#0d1117"/>
  <rect x="88" y="88" width="64" height="336" rx="32" fill="#e6edf3"/>
  <rect x="184" y="88" width="240" height="64" rx="32" fill="#e6edf3"/>
  <rect x="184" y="224" width="184" height="64" rx="32" fill="#e6edf3" opacity="0.78"/>
  <rect x="184" y="360" width="128" height="64" rx="32" fill="#e6edf3" opacity="0.52"/>
</svg>`;

const FAVICON_PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAACAAAAAgCAYAAABzenr0AAAABGdBTUEAALGPC/xhBQAAACBjSFJNAAB6JgAAgIQAAPoAAACA6AAAdTAAAOpgAAA6mAAAF3CculE8AAAARGVYSWZNTQAqAAAACAABh2kABAAAAAEAAAAaAAAAAAADoAEAAwAAAAEAAQAAoAIABAAAAAEAAAAgoAMABAAAAAEAAAAgAAAAAKyGYvMAAAGdaVRYdFhNTDpjb20uYWRvYmUueG1wAAAAAAA8eDp4bXBtZXRhIHhtbG5zOng9ImFkb2JlOm5zOm1ldGEvIiB4OnhtcHRrPSJYTVAgQ29yZSA2LjAuMCI+CiAgIDxyZGY6UkRGIHhtbG5zOnJkZj0iaHR0cDovL3d3dy53My5vcmcvMTk5OS8wMi8yMi1yZGYtc3ludGF4LW5zIyI+CiAgICAgIDxyZGY6RGVzY3JpcHRpb24gcmRmOmFib3V0PSIiCiAgICAgICAgICAgIHhtbG5zOmV4aWY9Imh0dHA6Ly9ucy5hZG9iZS5jb20vZXhpZi8xLjAvIj4KICAgICAgICAgPGV4aWY6UGl4ZWxYRGltZW5zaW9uPjUxMjwvZXhpZjpQaXhlbFhEaW1lbnNpb24+CiAgICAgICAgIDxleGlmOlBpeGVsWURpbWVuc2lvbj41MTI8L2V4aWY6UGl4ZWxZRGltZW5zaW9uPgogICAgICA8L3JkZjpEZXNjcmlwdGlvbj4KICAgPC9yZGY6UkRGPgo8L3g6eG1wbWV0YT4KuC9IVwAABBBJREFUWAm9V1tIVFEUXXcc36SEZCQF/tiIpkkFamoKQR+ZkY+flBCJ6EMtKAz6ligUv0OzIEItUieMfoKgd30UpIVhotlD+9EvwcfozHTWYc5453bHuTfUDZdz7z6Ptc7e++yzr+YXgoCsrq7izdv36B9w4+69Xvj9Pmiaprr/q+XymuZA/Zla1FRXouhwAZxOZ3AtTREYHvmMyy1XBYF38Hq9iIuLCw7aiJelpSVERUUJAoXoaL+O/bk5cllJYGTkCyoqazAz8wfx8fEbgRd2jcXFRaSl7cJjdz9yc/dBW15e9pefrMLzF682HVyxIomy0hI8GRqEJkzuP3qsHNHR0apftvQdY8LhcEjTqU6/z4dV4SJd6Kgu05YxRJ8bY2llZQXPnj6Bs+/+Q+lzPQGfAIkSk3KysjA3N4eZ6WlJkLGRkJCAjIwMSSoYvabQkKDLwvdjY2MSg5tRwrWIrW3bvjNkHe6MA9va21FZXY252Vk0NTbi9cuX2JGaiptdXcjPzwdJWhHu/NHgIK60tMg5Rks4jKak2V0uF05VVUkz796zB7V1dfCInRSXlKCsrEzuxgq4GsONuDIzpUuVji2xnUZGVMaKI6iIkVBsbCw04ZJp4YqFhQXpBqsWoCunf/2SrtS7gASIvZYRqAmIAtd/M0Y+fviAi83NOF5e/k9QqbH6lgDilKG3pycYR/p+vpsSMA5S34xmt/Cne2CA9JU6bMsRvkBMxcTEmI6zRYAr0B0bKbYJENzoIjNCxtgyG0OdLQIE5vlNTEyURzXk/AYQaHZmOq8IXgZgJIk8IrACwXmZ1Dc0oKCwkGaAGQFGOnNHV2cnvk9MRCRhmQCP4/68PFTX1IBpNJyQFHPH6dpaXGttDTcsqF/LjUHV1r5YtgCP4PCnTxjo77fkgr7eXkQ+qDaCkFHNALzT3Y0HfX1bH4R0jEydwhKsbiKJlRPANSy7QA9o9Yzr54R7t02Ap4GiJ6ESk77YDAdo1NsiwBswKztbXtckwCPHQBMpAePj3/B1dDSEmBHM7NuUgH53nMRvnwjAtPR0nKiokCWW2rXq3+vai/n5efz88SOkhDMD1eucXEgPyHeWUUpHs/JK9YrdJyclIVrcah7xbRReUsnJybLqYca0IsR2KCA1gYCs4VhGse+3KCZ4n7MemJqawvfJySA5NYfjVJ+dOOA8renCJX/nrdshPyKqKGVppi9Kqee9npKSAk3kfCWslDnO4/HI/KD067U8yufPnf2PslyYzawc4yVktOZ6BFRZ7jh08ACKiwrlFaqfwMVodqM/qafO+NgB53VNTGI7aNKOthvyd4kdmy3E4K8ZMYktHcl/tCH3Q5QeKZFXrZVUa5co16TZiUEsYlKCf8f8YJbb6t/zvxKZ4N1STXklAAAAAElFTkSuQmCC',
  'base64'
);

function saveDesktopRepo(repoPath: string): void {
  const home = process.env.HOME || process.env.USERPROFILE;
  if (!home) return;
  const cfgDir = path.join(home, '.config', 'lore');
  const cfgFile = path.join(cfgDir, 'desktop.json');
  try {
    mkdirSync(cfgDir, { recursive: true });
    writeFileSync(cfgFile, JSON.stringify({ repo: repoPath }) + '\n', 'utf8');
  } catch {
    // ignore
  }
}

function pickFolderNative(): string | null {
  try {
    if (process.platform === 'darwin') {
      const script = 'POSIX path of (choose folder with prompt "Choose a repository for Lore")';
      const out = execFileSync('osascript', ['-e', script], { encoding: 'utf8' }).trim();
      return out || null;
    } else if (process.platform === 'win32') {
      const ps = `Add-Type -AssemblyName System.Windows.Forms; $d = New-Object System.Windows.Forms.FolderBrowserDialog; $d.Description = 'Choose a repository for Lore'; if ($d.ShowDialog() -eq 'OK') { Write-Output $d.SelectedPath }`;
      const out = execFileSync('powershell', ['-NoProfile', '-Command', ps], { encoding: 'utf8' }).trim();
      return out || null;
    } else {
      try {
        return execFileSync('zenity', ['--file-selection', '--directory', '--title=Choose a repository for Lore'], { encoding: 'utf8' }).trim() || null;
      } catch {
        return execFileSync('kdialog', ['--getexistingdirectory', process.cwd()], { encoding: 'utf8' }).trim() || null;
      }
    }
  } catch {
    return null;
  }
}

export function startUi(initialRoot: string, opts: UiOptions = {}): Promise<UiHandle> {
  installCanon();
  let root = path.resolve(initialRoot);
  let db = openDb(root);
  db.pragma('journal_mode = WAL');
  const csrf = randomBytes(24).toString('base64url');
  const host = opts.host ?? '127.0.0.1';
  let actualPort = opts.port ?? 4173;

  const sseClients = new Set<ServerResponse>();

  function broadcastEvent(eventType: string, payload: unknown): void {
    const data = JSON.stringify(payload);
    const msg = `event: ${eventType}\ndata: ${data}\n\n`;
    for (const client of sseClients) {
      try {
        client.write(msg);
      } catch {
        sseClients.delete(client);
      }
    }
  }

  let lastDataVersion = (db.pragma('data_version', { simple: true }) as number) ?? 0;
  const pingInterval = setInterval(() => {
    for (const client of sseClients) {
      try {
        client.write(': ping\n\n');
      } catch {
        sseClients.delete(client);
      }
    }
  }, 15000);

  const dataVersionInterval = setInterval(() => {
    try {
      const currentVersion = (db.pragma('data_version', { simple: true }) as number) ?? 0;
      if (currentVersion !== lastDataVersion) {
        lastDataVersion = currentVersion;
        broadcastEvent('memory:changed', {
          dataVersion: currentVersion,
          timestamp: new Date().toISOString(),
        });
      }
    } catch {
      // db may be busy
    }
  }, 1000);

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
            const result = approveDrafts(db, root, ref, ids);
            broadcastEvent('claim:approved', { ids, ref, count: ids.length, timestamp: new Date().toISOString() });
            json(res, result);
            return;
          }
          if (url.pathname === '/api/reject') {
            const result = rejectDraft(db, root, ref, String(body.claim), body.reason ? String(body.reason) : undefined);
            broadcastEvent('claim:rejected', { claim: body.claim, reason: body.reason, ref, timestamp: new Date().toISOString() });
            json(res, result);
            return;
          }
          if (url.pathname === '/api/revert') {
            const result = revertCommit(db, root, ref, String(body.commit));
            broadcastEvent('claim:reverted', { commit: body.commit, ref, timestamp: new Date().toISOString() });
            json(res, result);
            return;
          }
          if (url.pathname === '/api/attest') {
            const verdict = body.verdict === 'disagree' ? 'disagree' : 'agree';
            const result = attestClaim(db, root, ref, String(body.claim), verdict, body.reason ? String(body.reason) : undefined);
            broadcastEvent('claim:attested', { claim: body.claim, verdict, timestamp: new Date().toISOString() });
            json(res, result);
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
            requireAction(root, 'write', { subject });
            const author = `human:${resolvePrincipal()?.id ?? 'ui'}`;
            const permissive = isPermissiveTrust(root);
            const run = db.transaction(() => {
              const result = upsertClaim(db, {
                subject,
                predicate,
                object,
                author,
                sessionId: session,
                forceActive: permissive,
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
            const result = run();
            broadcastEvent('claim:written', { claimId: result.id, subject, predicate, state: result.state, timestamp: new Date().toISOString() });
            json(res, result);
            return;
          }
          if (url.pathname === '/api/supersede') {
            const claimId = String(body.claim ?? '').trim();
            const object = String(body.object ?? '').trim();
            if (!claimId || !object) {
              json(res, { error: 'claim and object are required' }, 400);
              return;
            }
            const old = db.prepare('SELECT subject_id FROM claim WHERE id = ?').get(claimId) as
              | { subject_id: string }
              | undefined;
            if (!old) {
              json(res, { error: `no such claim: ${claimId}` }, 404);
              return;
            }
            requireAction(root, 'write', { subject: old.subject_id });
            const author = `human:${resolvePrincipal()?.id ?? 'ui'}`;
            const run = db.transaction(() => {
              const result = supersedeClaim(db, claimId, {
                object,
                author,
                sessionId: session,
                scrubSecrets: true,
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
            const result = run();
            broadcastEvent('claim:superseded', { oldId: result.oldId, newId: result.newId, timestamp: new Date().toISOString() });
            json(res, result);
            return;
          }
          if (url.pathname === '/api/repo/browse') {
            const chosen = pickFolderNative();
            if (!chosen) {
              json(res, { ok: false, cancelled: true });
              return;
            }
            const targetPath = path.resolve(chosen);
            if (!existsSync(path.join(targetPath, '.lore'))) {
              initCommand({ root: targetPath });
            }
            db.close();
            root = targetPath;
            db = openDb(root);
            db.pragma('journal_mode = WAL');
            lastDataVersion = (db.pragma('data_version', { simple: true }) as number) ?? 0;
            saveDesktopRepo(root);
            broadcastEvent('repo:switched', { repo: { name: path.basename(root), path: root }, timestamp: new Date().toISOString() });
            json(res, { ok: true, switched: true, repo: { name: path.basename(root), path: root } });
            return;
          }

          if (url.pathname === '/api/repo/switch') {
            const rawPath = String(body.path ?? '').trim();
            if (!rawPath) {
              json(res, { error: 'path is required' }, 400);
              return;
            }
            const targetPath = path.resolve(rawPath);
            if (!existsSync(targetPath)) {
              json(res, { error: `Directory does not exist: ${targetPath}` }, 400);
              return;
            }
            if (!existsSync(path.join(targetPath, '.lore'))) {
              initCommand({ root: targetPath });
            }
            db.close();
            root = targetPath;
            db = openDb(root);
            db.pragma('journal_mode = WAL');
            lastDataVersion = (db.pragma('data_version', { simple: true }) as number) ?? 0;
            saveDesktopRepo(root);
            broadcastEvent('repo:switched', { repo: { name: path.basename(root), path: root }, timestamp: new Date().toISOString() });
            json(res, { ok: true, repo: { name: path.basename(root), path: root } });
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

      if (url.pathname === '/api/events') {
        res.writeHead(200, {
          'Content-Type': 'text/event-stream',
          'Cache-Control': 'no-cache',
          'Connection': 'keep-alive',
        });
        sseClients.add(res);
        res.write('event: connected\ndata: {"status":"connected"}\n\n');
        res.on('close', () => {
          sseClients.delete(res);
        });
        return;
      }
      
      if (url.pathname === '/') {
        res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' });
        res.end(HTML.replace('__CSRF__', csrf));
        return;
      }

      if (url.pathname === '/graph-worker.js') {
        res.writeHead(200, {
          'content-type': 'application/javascript; charset=utf-8',
          'cache-control': 'public, max-age=3600',
        });
        res.end(GRAPH_WORKER_SCRIPT);
        return;
      }

      if (url.pathname === '/favicon.svg') {
        res.writeHead(200, { 'content-type': 'image/svg+xml', 'cache-control': 'public, max-age=86400' });
        res.end(LORE_FAVICON_SVG);
        return;
      }

      if (url.pathname === '/favicon.png' || url.pathname === '/favicon.ico') {
        res.writeHead(200, {
          'content-type': url.pathname === '/favicon.png' ? 'image/png' : 'image/x-icon',
          'cache-control': 'public, max-age=86400',
        });
        res.end(FAVICON_PNG);
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

      if (url.pathname === '/api/entities') {
        const tip = head(db, ref) ?? head(db, 'main');
        const active = activeAt(db, tip);
        const counts = new Map<string, number>();
        for (const id of active.keys()) {
          const row = db.prepare('SELECT subject_id FROM claim WHERE id = ?').get(id) as { subject_id: string } | undefined;
          if (row?.subject_id) {
            counts.set(row.subject_id, (counts.get(row.subject_id) ?? 0) + 1);
          }
        }
        if (counts.size === 0) {
          const rows = db.prepare("SELECT subject_id, COUNT(*) as cnt FROM claim WHERE state = 'active' GROUP BY subject_id").all() as Array<{ subject_id: string; cnt: number }>;
          for (const r of rows) {
            counts.set(r.subject_id, r.cnt);
          }
        }
        const result = Array.from(counts.entries()).map(([id, claimCount]) => {
          let type = 'file';
          let label = id;
          if (id.startsWith('env:')) { type = 'env'; label = id.slice(4); }
          else if (id.startsWith('rule:')) { type = 'rule'; label = id.slice(5); }
          else if (id.startsWith('doc:')) { type = 'doc'; label = id.slice(4); }
          else if (id.startsWith('adr:')) { type = 'adr'; label = id.slice(4); }
          else if (id.startsWith('pkg:')) { type = 'pkg'; label = id.slice(4); }
          else if (id.startsWith('sym:')) { type = 'symbol'; label = id.slice(4); }
          else if (id.startsWith('file:')) { type = 'file'; label = id.slice(5); }
          return { id, type, label, claimCount };
        }).sort((a, b) => a.id.localeCompare(b.id));
        json(res, result);
        return;
      }

      if (url.pathname === '/api/events') {
        res.writeHead(200, {
          'content-type': 'text/event-stream; charset=utf-8',
          'cache-control': 'no-cache, no-transform',
          'connection': 'keep-alive',
          'x-accel-buffering': 'no',
          'access-control-allow-origin': '*',
        });
        res.write(`event: connected\ndata: ${JSON.stringify({
          status: 'connected',
          branch: ref,
          repo: path.basename(root),
          timestamp: new Date().toISOString(),
        })}\n\n`);

        sseClients.add(res);

        req.on('close', () => {
          sseClients.delete(res);
        });
        return;
      }

      if (url.pathname === '/api/sync/status') {
        json(res, getSyncStatus(db, root));
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
          sync: getSyncStatus(db, root),
          repo: {
            name: path.basename(root),
            path: root,
          },
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
          repo: {
            name: path.basename(root),
            path: root,
          },
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
            clearInterval(pingInterval);
            clearInterval(dataVersionInterval);
            for (const client of sseClients) {
              try {
                client.end();
              } catch {
                // ignore
              }
            }
            sseClients.clear();
            server.close(() => {
              db.close();
              done();
            });
          }),
      });
    });
  });
}
