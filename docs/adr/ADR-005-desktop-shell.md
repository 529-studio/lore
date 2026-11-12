# ADR-005: Desktop shell — Tauri with a Node sidecar, macOS first

Status: accepted · 2026-11-12 · implemented in #66 (macOS)

## Context

Non-technical users need three screens — health, review, undo — without a terminal. The dashboard
(#18) already covers health. Review and undo are writes, so they need the policy and identity layers,
not just a page.

Constraints from the team:

- macOS first; Windows is planned but not now.
- An offline installer is required: the user must not install Node.
- Nobody reviews memory over SSH today, so a full TUI is not justified.
- The Apple Developer account exists (the maintainer holds it).

## Decision

1. **One actions layer** (`src/actions.ts`) owns approve, reject, revert and attest. CLI, web, MCP and
   any future surface call it; policy is enforced once.
2. **A local web app first**: extend `lore ui` with Review and Undo, guarded by a CSRF token and an
   Origin check, bound to loopback.
3. **Tauri v2 wraps the same UI** for the desktop build. The store and server ship as a **Node SEA
   sidecar** (single executable), so the installer needs no Node and works offline.
4. **macOS distribution without the paid Apple Developer Program**: an ad-hoc signed `.dmg` on GitHub
   Releases, plus the exact Gatekeeper workaround in the install docs. Notarization is deferred until
   a 99 USD/year membership is justified; the release pipeline is structured so enabling it later is a
   configuration change, not a rewrite.
5. **No full TUI.** A readline-based `lore review` covers the SSH/CI case at a fraction of the cost.
   Revisit a TUI only if remote review becomes a real workflow.

## Consequences

- The UI work is incremental and testable in a browser before packaging exists.
- Tauri adds a Rust build toolchain to the release machine and a sidecar to sign; the installer stays
  small compared with Electron.
- An unsigned app triggers Gatekeeper: the first launch needs right-click → Open, or
  `xattr -dr com.apple.quarantine /Applications/Lore.app`. That is documented, not hidden.
- The sidecar still needs an ad-hoc signature (`codesign -s -`) or Apple Silicon refuses to execute it.
- Windows later needs its own signing (Authenticode) and installer (MSI/NSIS); the UI and actions
  layer are reused unchanged.
- A TUI can be added later as another thin client over `actions.ts` without touching the model.

## Alternatives considered

- **Electron**: faster to package, but 100 MB+ and it duplicates Node that the sidecar already carries.
- **Pure web app only**: cheapest, but no installer, no dock presence, and non-technical users treat a
  localhost URL as a website, not an app.
- **Paid notarization now**: the right long-term answer for non-technical users, but 99 USD/year before
  the app has users is the wrong order. Ship, measure, then pay.
- **Native Swift**: best macOS feel, but a second implementation of every screen and no Windows path.
- **Full TUI**: cheap to build, expensive to maintain, and it serves the wrong audience for #21.
