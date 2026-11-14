# Wiring Lore into coding agents — MCP config

Lore ships an MCP server over **stdio**: `lore mcp` (JSON-RPC 2.0, protocol on stdout, logs on stderr).
It exposes 7 tools: `memory_search`, `memory_write`, `memory_approve`, `memory_commit`,
`memory_blame`, `memory_status`, `memory_diff`.

> Canon: `memory_search` injects only `active AND canonical` claims. A contested fact is withheld and
> returned as a `warnings` line plus a `contested` entry in `structuredContent`.

> Build first: `npm run build` in your Lore checkout → `dist/cli.js`.
> Everywhere below, replace `/ABS/PATH/TO/lore` with the absolute path of **your** Lore checkout.
> If `lore` is on your `PATH` (`npm link` / `npm i -g`), you can use `"command": "lore", "args": ["mcp"]`.

## Key facts

- **cwd matters.** The server resolves the Lore store from its working directory (`lore init` must have been run in the project). Launch the agent from the project root, or set `cwd` in the config.
- **One branch per agent session.** Writes always go to `agent/<session>`, never `main`. Set a **different `LORE_SESSION` env var per agent** (e.g. `claude`, `codex`, `gemini-1`) so agents don't overwrite each other's drafts. Merge them with `lore merge agent/<session>` when a session proved itself.
- `kind: agent|human` claims are written as **draft** and stay out of retrieval until `lore approve`.
- `memory_write` accepts `ttl_days`; `lore.ontology.yml` can set it per predicate. A claim past its TTL or pointing at a deleted evidence path is not injected, and `lore canon decay` persists it as stale.

---

## Automated setup (`lore setup`)

Instead of manual editing, configure your agents automatically:

```bash
lore setup agy       # Antigravity CLI (.agents/mcp_config.json or global ~/.gemini/config/mcp_config.json)
lore setup claude    # Claude Code (.mcp.json)
lore setup cursor    # Cursor (.cursor/mcp.json)
lore setup codex     # Codex CLI (~/.codex/config.toml)
lore setup gemini    # Gemini CLI (.gemini/settings.json)
lore setup --all     # Detect and configure all installed agents
```

---

## Antigravity CLI (`agy`)

Option A — Automated:

```bash
lore setup agy
```

Option B — Manual config in `.agents/mcp_config.json` (or global `~/.gemini/config/mcp_config.json`):

```json
{
  "mcpServers": {
    "lore": {
      "command": "lore",
      "args": ["mcp"],
      "env": { "LORE_SESSION": "antigravity" }
    }
  }
}
```

## Claude Code

Option A — CLI (run inside your project):

```bash
claude mcp add lore \
  --scope project \
  --env LORE_SESSION=claude \
  -- node /ABS/PATH/TO/lore/dist/cli.js mcp
```

Option B — `.mcp.json` in the project root (same file family as `claude mcp add` writes):

```json
{
  "mcpServers": {
    "lore": {
      "command": "node",
      "args": ["/ABS/PATH/TO/lore/dist/cli.js", "mcp"],
      "env": { "LORE_SESSION": "claude" }
    }
  }
}
```

Accept the server with `/mcp` (or restart Claude Code in the project root).

## Codex CLI

Edit `~/.codex/config.toml`:

```toml
[mcp_servers.lore]
command = "node"
args = ["/ABS/PATH/TO/lore/dist/cli.js", "mcp"]
env = { "LORE_SESSION" = "codex" }
```

Codex starts MCP servers with your current directory, so run `codex` from the project root.

## Gemini CLI

Edit `~/.gemini/settings.json`:

```json
{
  "mcpServers": {
    "lore": {
      "command": "node",
      "args": ["/ABS/PATH/TO/lore/dist/cli.js", "mcp"],
      "env": { "LORE_SESSION": "gemini" }
    }
  }
}
```

Gemini also supports a project-level `.gemini/settings.json` if you prefer not to touch the global one.
Run `gemini` from the project root.

---

## Shared workflow (multi-agent)

1. `lore init` once in the repo.
2. `lore ingest` to bootstrap deterministic claims from the repo itself.
3. Each agent reads with `memory_search` and writes with `memory_write` into its own `agent/<LORE_SESSION>`.
4. Review/hardening: `lore approve --all-drafts --session <ses>`, then merge:
   `lore merge agent/<ses>` → conflicts are resolved by the R1–R6 ladder or
   `lore resolve <subject> <predicate> --take ours|theirs|both --reason "..."`.
5. For tools without MCP, generate the read-only projection:
   `lore export --md --out AGENTS.md` (deterministic, timestamp-free — commit it so review happens in a PR).

## Smoke test

```bash
npm run mcp:smoke
```

Performs a real handshake (`initialize` → `notifications/initialized` → `tools/list` → `tools/call memory_search` / `memory_write`) against a throwaway repo and asserts the write landed as a draft on an `agent/<session>` branch.

## Deliberate omissions

Redaction and purge are CLI-only. An agent must never be able to erase the evidence of what it learned,
so there is no `memory_redact` or `memory_purge` tool. Conflict resolution (`lore canon resolve`) is
CLI-only for the same reason: an agent must not pick the winner of a contested fact.

## Protocol negotiation and result schemas

The server supports MCP protocol versions `2025-06-18`, `2025-03-26` and `2024-11-05`.

- A client that asks for a supported version gets that version echoed back.
- A client that asks for anything else is negotiated down to `2025-06-18`; the reason is written to
  stderr, never to stdout, so the JSON-RPC stream stays clean.
- Every tool in `tools/list` carries an `outputSchema` that describes exactly the
  `structuredContent` it returns, so a client can validate results instead of parsing the text block.

`npm run mcp:smoke` asserts both: each tool has an object schema, and an unknown protocol version
negotiates to `2025-06-18`.
