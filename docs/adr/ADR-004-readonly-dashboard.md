# ADR-004: Read-only dashboard with no framework

Status: accepted · 2026-11-12

## Context

Teams need to see what the agent knows without reading a terminal. The obvious move is a React or
Svelte SPA, which brings a build pipeline, a bundler, and a runtime dependency into a CLI that
otherwise installs with four packages and no build step for users.

## Decision

`lore ui` serves one HTML page from `node:http`, with vanilla JavaScript and JSON endpoints. The page
is a template string in `src/ui/server.ts`. It reads the existing SQLite store; there is no separate
backend.

## Consequences

- No new runtime dependency and no build step for the dashboard; `npm i -g` stays small.
- The page reflects the live store, unlike a static export.
- Interactivity is limited to filtering and refresh; that is the v1 scope.
- UI code lives in one file, which is fine at this size and will need splitting when editing lands.
- The server binds `127.0.0.1` by default and has no authentication; binding elsewhere prints a warning.

## Alternatives considered

- **Static export** (`lore export --html`): no server, but it is a snapshot and goes stale immediately.
- **React/Svelte SPA**: better for a product, but a build pipeline for one read-only page.
- **TUI**: fast, but not shareable and not a path to the desktop shell (#21).
