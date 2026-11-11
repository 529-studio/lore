# Wiring Lore into coding agents — MCP config

Lore ships an MCP server over **stdio**: `lore mcp` (JSON-RPC 2.0, protocol on stdout, logs on stderr).
It exposes 5 tools: `memory_search`, `memory_write`, `memory_blame`, `memory_status`, `memory_diff`.

> Build first: `npm run build` in your Lore checkout → `dist/cli.js`.
> Everywhere below, replace `/ABS/PATH/TO/lore` with the absolute path of **your** Lore checkout.
> If `lore` is on your `PATH` (`npm link` / `npm i -g`), you can use `"command": "lore", "args": ["mcp"]`.

## Key facts

- **cwd matters.** The server resolves the Lore store from its working directory (`lore init` must have been run in the project). Launch the agent from the project root, or set `cwd` in the config.
- **One branch per agent session.** Writes always go to `agent/<session>`, never `main`. Set a **different `LORE_SESSION` env var per agent** (e.g. `claude`, `codex`, `gemini-1`) so agents don't overwrite each other's drafts. Merge them with `lore merge agent/<session>` when a session proved itself.
- `kind: agent|human` claims are written as **draft** and stay out of retrieval until `lore approve`.

---

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
