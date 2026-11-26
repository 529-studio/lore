# lore doctor

`lore doctor` is the single readiness check for a repository. It answers "why is my agent not
getting memory?" without reading logs or opening SQLite.

```bash
lore doctor            # human-readable checks
lore doctor --json     # machine-readable { ok, checks }
lore doctor --fix      # apply safe remediations, then report
```

Exit code is `0` when no check is `[ERR]`, `1` otherwise. `[WARN]` entries never change the exit
code; they describe a working repo with something unconfigured.

## Checks

| id | What it verifies | Status when wrong |
|---|---|---|
| `store.path` | `.lore/lore.db` exists and opens | `[ERR]`, remediation `lore init` |
| `store.wal` | `PRAGMA journal_mode` is `wal` | `[WARN]` |
| `store.integrity` | one cheap `PRAGMA quick_check` | `[ERR]` |
| `store.schema` | every table and migrated column the running code needs exists | `[ERR]` |
| `parity` | `main` is non-empty, or no `agent/*` branch holds the ingested baseline | `[WARN]` |
| `mcp:<agent>` | syntax of `.mcp.json`, `.agents/mcp_config.json`, `.codex/config.toml`, `.cursor/mcp.json`, `.gemini/settings.json`, `opencode.json`, and whether the `lore` server is registered | `[ERR]` for malformed syntax, `[WARN]` for missing/unregistered |
| `mcp.binary` | `lore` resolves on `PATH` | `[WARN]` |
| `ontology` | `lore.ontology.yml` defines the extractor predicates shipped in the template | `[WARN]` |
| `health.stale` | active claims persisted as `trust = stale` | `[WARN]` |
| `health.conflicts` | unresolved `merge_conflict` and `claim_conflict` rows | `[WARN]` |

The store has no version counter; `store.schema` compares the actual table and column shape with
the schema the running binary creates, so drift is detected rather than assumed away.

TOML validation is a narrow parser for the shapes Codex configs use (tables, dotted keys, strings,
numbers, booleans, arrays, inline tables, multiline strings). A malformed file yields `[ERR]` with a
line number; duplicate keys and duplicate tables are rejected. OpenCode's JSONC comments and trailing
commas are accepted. No TOML dependency is added.

## --json output

```json
{
  "ok": false,
  "checks": [
    {
      "id": "mcp:codex",
      "status": "err",
      "message": ".codex/config.toml is not valid TOML: unterminated table header (line 1)",
      "remediation": "fix .codex/config.toml or rerun lore setup codex"
    }
  ]
}
```

`status` is one of `ok`, `warn`, `err`. `remediation` is present only when there is an action to take.
Token order and ids are stable so CI jobs can assert on a single check.

## Branch parity and --fix

A common failure: the ingest ran on `agent/onboard_*` (or a session branch) and was never promoted,
so `main` has zero claims and every new session starts empty. Doctor reports:

```text
[WARN] parity  main has 0 claims while agent/onboard_1a2b3c4d (214 claims) holds the ingested baseline
       remediation: lore promote from that session, or lore doctor --fix
```

`lore doctor --fix` is deliberately narrow:

- it only runs when `main` is empty and an `agent/*` branch holds claims;
- it promotes only a single candidate, or the `agent/onboard*` branch when several compete;
- it aborts if the merge would report a conflict or retract any claim, and reports why;
- it respects the policy `promote` action, so team mode still needs an authorized identity.

Nothing else is mutated. Malformed MCP configs, missing PATH entries, stale claims and conflicts are
reported with remediation text and left for the user.

## CI

`npm run doctor:smoke` covers three scenarios: a healthy repo exiting `0`, a malformed
`.codex/config.toml` exiting non-zero with `[ERR]`, and an empty `main` with an `agent/*` baseline
that `--fix` promotes.
