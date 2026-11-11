# ADR-002: Hand-rolled MCP over stdio, no SDK

Status: accepted · 2026-11-11

## Context

Lore exposes memory to Claude Code, Codex, Gemini CLI and anything else that speaks MCP. The official
SDK is available, but the server needs a small, stable surface: initialize, tools/list, tools/call.

## Decision

Implement the JSON-RPC loop directly in `src/mcp/server.ts`, with per-tool JSON schemas and explicit
protocol negotiation.

## Consequences

- No runtime dependency, no version churn from the SDK, and full control over error envelopes.
- stdout stays pure JSON-RPC; logs go to stderr.
- We own protocol correctness: supported versions are listed explicitly and unknown versions
  negotiate down to the newest one.
- We do not get SDK conveniences (reconnect, listChanged, batching). If those become necessary, the
  transport is isolated enough to swap.

## Alternatives considered

- **Official SDK**: faster to start, but it adds a dependency to the one surface every client depends
  on, and the SDK's transport assumptions change between releases.
- **HTTP server**: MCP over stdio is what every coding agent launches; a port would need lifecycle
  management and auth.
