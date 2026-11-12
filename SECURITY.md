# Security policy

## Supported versions

`0.1.x` receives security fixes. Older versions are not maintained.

## Reporting a vulnerability

Do **not** open a public issue. Use GitHub's private advisory flow:

https://github.com/529-studio/lore/security/advisories/new

Include the version (`lore --version`), the command or MCP call that triggers it, and the impact.
You will get an acknowledgement within 72 hours and a fix or a mitigation plan within 14 days.

## What counts as a vulnerability

- Reading files outside the repository (evidence paths, MCP `memory_write` refs).
- Executing code or shell commands from claim content.
- Leaking memory content to an unintended MCP client or process.
- Authentication/authorization bypass in `approve`, `resolve`, or `promote` (once auth exists).

## Secret firewall

An agent that can read a secret can write it. Lore therefore treats every write as an exfiltration
path:

- `upsertClaim` scans the subject, predicate and object. A match is rejected and never stored; the CLI
  and MCP return an error with the value masked.
- `lore ingest` skips blocked candidates, reports them masked, and exits non-zero.
- `lore guard [--staged] [--path <dir>]` scans files or the staged diff and exits 1 on a finding.
- `lore guard --install` adds a pre-commit hook that runs `lore guard --staged`.
- `.loresecretignore` holds regexes for justified false positives. It is a last resort, reviewed like
  code.

This is a gate, not a guarantee: provider patterns and entropy checks have false negatives. Assume a
secret can leak, keep credentials short-lived and scoped, and rotate.

If a secret reaches memory:

- `lore redact <claim> --reason "..."` replaces the object with `[redacted]`, keeps the claim id and
  records who redacted it and why. The claim stays visible in `blame`, and nothing can resurrect it.
- `lore purge <claim> --yes --reason "..."` removes the row and its evidence permanently, leaving an
  audit entry with id, actor, reason and time.
- Rotate the credential regardless. Redaction removes it from the store, not from backups you already
  took.

## Hardening already in place

- `hashFile` resolves real paths, rejects anything outside the repository, rejects non-regular files,
  and refuses files above 4 MB.
- MCP runs over stdio only; it opens no port.
- The store is a local SQLite file; no network calls are made by the CLI.
- `npm run check:public` fails the build if a token-like string or absolute home path is committed.
