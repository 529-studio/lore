# Onboarding

```bash
cd my-project
lore onboard
```

It takes a repository from nothing to a first useful claim, then prints the two commands that turn
memory on for an agent.

## What it does

1. **Detects the stack** from files: `package.json`, `pyproject.toml`, `go.mod`, `Cargo.toml`, `src/`,
   `docs/adr/`, `issues/`, `content/`.
2. **Suggests a template** and copies it to `lore.ontology.yml` if that file does not exist yet.
3. **Initialises** `.lore/` (and adds it to `.gitignore`).
4. **Ingests** the repository with the deterministic extractors.
5. **Prints next steps**: the MCP command for Claude Code, `lore ui`, `lore review`, `lore remote`.

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

Without `--yes` and with a TTY, it asks which template to use and whether to ingest.

## What it will not do

- It never overwrites an existing `lore.ontology.yml`.
- It does not create an MCP client configuration; it prints the command so you can review it.
- It does not commit anything.

## Desktop

The macOS app runs `lore init` on the folder you pick and starts the dashboard. For the template and
the agent command, run `lore onboard` once from a terminal; the app picks up the same store.
