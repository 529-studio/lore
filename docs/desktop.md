# Desktop app

`desktop/` is a Tauri v2 shell around the same local dashboard. It bundles everything it needs:

```
Lore.app/Contents/Resources/
  node                      the Node runtime (105 MB)
  app/dist/cli.js           the CLI and UI server
  app/node_modules/better-sqlite3
```

No Node installation is required on the user's Mac, and the app works offline.

## Build

Prerequisites: macOS with Xcode Command Line Tools and a Rust toolchain (`rustup`).

```bash
npm ci && npm run build          # from the repository root
cd desktop
npm ci
npm run build                    # stages the runtime, compiles Rust, bundles .app and .dmg
```

Outputs:

```
desktop/src-tauri/target/release/bundle/macos/Lore.app          (~142 MB)
desktop/src-tauri/target/release/bundle/dmg/Lore_0.3.0_aarch64.dmg  (~48 MB)
```

`desktop/scripts/stage.mjs` copies `dist/`, `package.json`, `better-sqlite3` and the Node binary into
`desktop/stage/`, which Tauri bundles as resources.

## Run

Open the app. On first launch it asks for a repository; the choice is stored in
`~/.config/lore/desktop.json`. If the folder has no `.lore`, the app runs `lore init` once.

For testing without the dialog:

```bash
LORE_REPO=/path/to/repo LORE_UI_PORT=4190 \
  "desktop/src-tauri/target/release/bundle/macos/Lore.app/Contents/MacOS/lore-desktop"
curl http://127.0.0.1:4190/api/health
```

## Signing

The app is **ad-hoc signed**, not notarized: there is no Apple Developer Program membership. macOS
Gatekeeper will block the first launch. Document this to users:

- Right-click the app → **Open** → **Open** again, or
- `xattr -dr com.apple.quarantine /Applications/Lore.app`

Notarization is a configuration change (certificate + `APPLE_ID`/`APPLE_TEAM_ID`/`APPLE_APP_PASSWORD`
or an API key) once a membership exists; the bundle and pipeline do not need to change.

## Architecture

The Rust binary picks a free loopback port, spawns the bundled `node app/dist/cli.js ui --port N`,
waits for the port to accept connections, then opens a window pointing at it. The child is killed when
the app exits. Writes from the window go through the dashboard's CSRF token and the same
`src/actions.ts` policy layer as the CLI.

## Limits

- No tray icon, no auto-update, no menu bar extra.
- macOS only for now; Windows is #67.
- The .app carries its own Node runtime, so the download is larger than a native app.
