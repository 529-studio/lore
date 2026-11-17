# Implementation Plan: Server-Sent Events (SSE) Live Memory Event Streaming

Tracking Issue: [#125](https://github.com/529-studio/lore/issues/125)
Estimate: 3.0h, delivery window: sprint 6 day 1

## Overview
Currently, `lore ui` is a static dashboard that only updates on manual page refresh or tab switching. This feature adds a real-time Server-Sent Events (SSE) streaming endpoint `GET /api/events` in `src/ui/server.ts`, an in-process event broadcaster, an external process mutation detector via SQLite `PRAGMA data_version` polling, and browser `EventSource` integration with live visual indicators.

---

### Task 1: Server-Sent Events Endpoint & Change Detection (`src/ui/server.ts`)
- Implement `broadcastEvent(event: string, data: unknown)` and `sseClients` registry.
- Implement `GET /api/events` route:
  - Headers: `Content-Type: text/event-stream`, `Cache-Control: no-cache`, `Connection: keep-alive`.
  - Send initial `connected` handshake event.
  - Set up keepalive ping comment every 15s.
  - Handle socket disconnect and cleanup.
- Add periodic `PRAGMA data_version` check (every 1s) to detect external database writes and broadcast `memory:changed`.
- Broadcast specific events from mutation endpoints:
  - `claim:write` on `/api/action/write`
  - `claim:approve` on `/api/action/approve`
  - `claim:reject` on `/api/action/reject`
  - `claim:supersede` on `/api/action/supersede`
  - `claim:revert` on `/api/action/revert`
- Clean up all intervals on `server.close()`.

### Task 2: Frontend Client Integration (`src/ui/server.ts`)
- Add a live status badge (`<span id="live-indicator" class="live-badge">● LIVE</span>`) in the UI header.
- Add `setupEventSource()` in client script:
  - Connect to `/api/events`.
  - On events (`connected`, `claim:*`, `memory:changed`), trigger debounced re-fetch of health metrics and current active view.
  - Handle disconnect/error state with visual indicator update.

### Task 3: Smoke Test Suite (`scripts/ui-smoke.mjs`)
- Add SSE test case to `scripts/ui-smoke.mjs`:
  - Connect to `http://localhost:<port>/api/events`.
  - Verify headers and initial `connected` event.
  - Perform a write or approve action via HTTP POST.
  - Verify that the SSE event stream receives the update event.

### Task 4: Documentation & Verification
- Update `README.md` and `SPEC.md` §15.
- Run all checks: `npm run build`, `npm run temporal:smoke`, `node scripts/ui-smoke.mjs`, `npm run smoke`, `npm run check:public`, `npm run docs:lint`.
- Commit, push, open PR with `Close #125`, and merge.
