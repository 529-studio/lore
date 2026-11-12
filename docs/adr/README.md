# Architecture decision records

One file per decision that is expensive to reverse. Format: context, decision, consequences,
alternatives. A superseded ADR stays in place and says so at the top.

| # | Decision | Status |
|---|---|---|
| [001](ADR-001-sqlite-content-addressed-claims.md) | SQLite with content-addressed claims | accepted |
| [002](ADR-002-hand-rolled-mcp.md) | Hand-rolled MCP over stdio, no SDK | accepted |
| [003](ADR-003-promote-instead-of-auto-main.md) | Session branches plus explicit promote | accepted |
| [004](ADR-004-readonly-dashboard.md) | Read-only dashboard with no framework | accepted |
| [005](ADR-005-desktop-shell.md) | Desktop shell: Tauri + Node sidecar, macOS first | accepted |

New records use `ADR-<NNN>-<slug>.md` and are added to this table in the same pull request.
