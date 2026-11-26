# Plugins: personal hosts and repository extractors

Lore ships six agent hosts and one deterministic extractor set. Everything else is an extension,
not core code. A plugin is an ESM module with a default export; two strict scopes keep it safe for
mixed teams.

## Scopes

| Scope | Where it lives | May register |
|---|---|---|
| Personal | `~/.config/lore/config.yml` (never committed) | `resolveContext`, `agentHosts`, `hooks` |
| Repository | `.lore.yml` `plugins:` (committed) | `extractors` |

A capability used in the wrong scope is dropped with a warning, not silently honoured. A personal
plugin therefore cannot change what teammates extract from a checkout, and a repository plugin
cannot rewrite your host config or execution context.

Personal config:

```yaml
plugins:
  - ./orca-host.mjs
  - ~/code/lore-hooks.mjs
```

Repository manifest:

```yaml
plugins:
  - tools/lore-domain-extractors.mjs
```

Repository plugin paths must stay inside the checkout and are committed to git. Postgres credentials
still never live in `.lore.yml`.

## Interface

```ts
import type { LorePlugin } from '@529studio/lore/dist/plugins/types.js';

export default {
  name: 'my-host',
  resolveContext(cwd) {
    return { session: 'my-agent', stateDir: '.lore' };
  },
  agentHosts: [
    {
      name: 'myhost',
      displayName: 'My Host',
      defaultSession: 'myhost',
      getConfigFile(root, scope) {
        return scope === 'global' ? '~/.myhost/config.json' : `${root}/.myhost/mcp.json`;
      },
      isInstalled(root) {
        return true;
      },
      applyConfig(file, cmd, session) {
        // write an MCP server entry that runs `cmd.command cmd.args`
        // with LORE_SESSION=session
      },
    },
  ],
  hooks: {
    beforeSession(ctx) {},
    afterWrapup(ctx) {},
  },
} satisfies LorePlugin;
```

`resolveContext` overrides `workspaceRoot`, `stateDir`, and `session`; explicit environment variables
(`LORE_WORKSPACE_ROOT`, `LORE_STATE_DIR`, `LORE_SESSION`) still win. Hooks are synchronous, run at
most once per session, and a throwing hook warns without blocking the command.

Repository extractors:

```ts
export default {
  name: 'domain-extractor',
  extractors: [
    {
      name: 'refund-flow',
      extract(root) {
        return [
          {
            subject: 'doc:docs/refund.md#idempotency',
            predicate: 'enforces_invariant',
            object: 'refunds require an idempotency key',
            evidenceRef: 'docs/refund.md',
          },
        ];
      },
    },
  ],
};
```

`extract(root)` must be deterministic: no network, clock, or random data. The claim is read through
the normal ingest pipeline, including hash-based evidence, the secret firewall, and permission gates.

## Commands

```bash
lore plugins list          # scopes, capabilities, and dropped-capability warnings
lore plugins list --json   # same for tooling
lore setup myhost          # any personal agentHosts adapter by name
```

`lore setup <custom-host>` requires the personal plugin to be loaded, so the adapter is available to
every teammate who installs the same personal config; it never has to land in core.
