# Brand and onboarding

This note decides who Lore speaks to, how it sounds, and what the mark means. It exists so the
next contributor does not re-litigate these choices in a pull request.

## Audience

| Priority | Who | What they need | What they see |
|---|---|---|---|
| Primary (v0.1.x) | Developers running more than one coding agent on one repository | trust: provenance, staleness, undo | CLI + MCP |
| Secondary | Tech leads who must review what agents learned | audit: blame, diff, conflict decisions | CLI, `export --md`, PR review |
| Tertiary (v0.3+) | Non-developers on the same project | review and undo without a terminal | desktop app |
| Not targeted (2026) | Chatbot users with no project, teams wanting a hosted knowledge base | — | — |

**Positioning sentence.** "Git for what your AI agents know."

**What we are not.** Not a note-taking app, not a vector database, not a hosted knowledge base.
Every sentence in the README should survive that filter.

## Tone

- Technical and specific. Numbers beat adjectives.
- Restrained: no "magic", no "supercharge", no "10x".
- Honest about limits: the README has a Limitations section and it is not decorative.
- No emoji anywhere. Use `[OK]`, `[WARN]`, `[ERR]`.
- English only in the repository; a `README.vi.md` quickstart is a separate decision.

## The mark

Three stacked bars against a spine: a ledger of claims, each layer shorter than the one above,
read left to right as a history that narrows as it is verified. It also reads as an `L`.

Design constraints:

- **Legible at 16 px.** The spine and the first bar must survive a favicon. No hairline strokes.
- **Monochrome first.** It renders with `currentColor`, so it works on light and dark without a
  second asset. Opacity carries the layering, not colour.
- **No text inside the mark.** Wordmark lives beside it, never inside it.
- **No gradients.** They disappear in monochrome and in print.

Rejected: a brain (generic AI), a bookmark (note-taking), a chain (blockchain), a git branch
diagram (implies the storage is git, which it is not).

### Assets

| File | Use |
|---|---|
| `docs/assets/brand/lore-icon.svg` | source of truth, `currentColor` |
| `docs/assets/brand/lore-icon-dark.svg` | dark tile, 512 px |
| `docs/assets/brand/lore-icon-{16,32,128,512}.png` | favicon, README, npm avatar |
| `docs/assets/brand/lore-social.svg` / `.png` | GitHub social preview, 1280x640 |

### Regenerating the PNGs

```bash
npx sharp-cli -i docs/assets/brand/lore-icon-dark.svg -o docs/assets/brand/lore-icon-512.png
for s in 128 32 16; do
  sips -z $s $s docs/assets/brand/lore-icon-512.png --out docs/assets/brand/lore-icon-$s.png
done
npx sharp-cli -i docs/assets/brand/lore-social.svg -o docs/assets/brand/lore-social.png
```

Two steps are manual because GitHub and npm do not expose an API for them:

1. Repository **Settings → Social preview** → upload `lore-social.png`.
2. npm package avatar → upload `lore-icon-512.png` on the package settings page after the first
   publish.

## Demo assets

| Asset | Shows | Budget | Regenerate |
|---|---|---|---|
| `docs/assets/demo-cli.gif` | init → ingest → search → drift → status → verify --accept | < 4 MB | `npm run demo:cli` |

The CLI recording is generated from a real run in a throwaway repository, not a mock terminal.
`scripts/demo/record-cli.mjs` executes the commands, captures stdout with colour disabled, renders
frames, and assembles the GIF with ffmpeg.

Requirements: Node 22, `ffmpeg`, and a monospace font (`Menlo` on macOS, `DejaVu Sans Mono` on
Linux). The script needs `sharp` (dev dependency).

### GUI recording

Blocked on the app shell ([#21](https://github.com/529-studio/lore/issues/21)). When it exists,
record with Playwright video and convert to GIF:

```bash
node scripts/demo/record-gui.mjs   # to be added with #21
```

Until then the README shows an explicit placeholder. A mock-up must never be presented as a real
recording.

## Colour

| Token | Value | Use |
|---|---|---|
| ink | `#e6edf3` | text on dark |
| surface | `#0d1117` | terminal and social background |
| muted | `#8b949e` | secondary text |
| accent | `#58a6ff` | prompts, links, the one highlighted value |

Monochrome is the default; the accent is the only colour and it never carries meaning on its own.
