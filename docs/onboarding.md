# Onboarding

```bash
cd my-project
lore onboard
```

It takes a repository from nothing to a first useful claim, then prints the two commands that turn
memory on for an agent.

## What it does

1. **Detects the stack** from root manifests (`package.json`, `pyproject.toml`, `go.mod`, `Cargo.toml`,
   `Makefile`, workspace files), containers (`Dockerfile`, `docker-compose*.yml`), nested manifests
   (`frontend/package.json`, `backend/requirements.txt`), `src/`, `app/`, `scripts/`, `docs/adr/`,
   `issues/`, `content/`.
2. **Suggests a template** and copies it to `lore.ontology.yml` if that file does not exist yet.
3. **Initialises** `.lore/` (and adds it to `.gitignore`).
4. **Ingests** on a fresh `agent/onboard_<id>` branch, then promotes that baseline to `main`, so
   every agent session forked from `main` sees the claims immediately.
5. **Configures MCP** for detected agents (unless `--no-setup`) and prints next steps: `lore ui`,
   `lore review`, `lore remote`.

## Templates

| Template | Use when | Predicates include |
|---|---|---|
| `code` | source files present | `declared_dependency`, `imports_module`, `read_by`, `exposes_route` |
| `product` | decisions and ownership | `decides`, `owned_by`, `targets_customer`, `success_metric` |
| `content` | articles and docs | `covers_topic`, `published_at`, `targets_audience` |
| `support` | tickets and answers | `answers`, `escalates_to`, `affects_customer`, `workaround` |

`lore onboard --template product` picks one explicitly. Files live in `templates/<name>/lore.ontology.yml`
and are versioned with the repository.

## Flags

| Flag | Meaning |
|---|---|
| `--path <dir>` | onboard another directory |
| `--template <name>` | skip detection |
| `--yes` | no prompts, suitable for CI or a script |
| `--setup [agent]` | configure MCP for detected agents (or one named agent) |
| `--no-setup` | skip MCP configuration |

Without `--yes` and with a TTY, it asks which template to use and whether to ingest.

## What it will not do

- It never overwrites an existing `lore.ontology.yml`.
- It merges `lore` into existing MCP client configs; other servers are preserved.
- It does not promote the baseline when team policy denies `promote`: the claims stay on the
  onboarding branch for a maintainer to review.
- It never promotes a pre-existing `agent/onboard` ref; every run uses a fresh branch id.

## Desktop

The macOS app runs `lore init` on the folder you pick and starts the dashboard. For the template and
the agent command, run `lore onboard` once from a terminal; the app picks up the same store.
