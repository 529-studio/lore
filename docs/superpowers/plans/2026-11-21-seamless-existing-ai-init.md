# Seamless Existing-Agent Initialization and Onboarding Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Enable Lore to automatically detect pre-existing AI agents, instructions, and codebase stacks upon `lore init`, providing intelligent guidance and a non-destructive one-step setup (`lore init --full`) that configures memory rules, ingests code facts, and connects MCP tools in seconds.

**Architecture:** 
1. Build a centralized workspace agent and stack detector `detectWorkspaceAgents(root)` that inspects rule files (`AGENTS.md`, `CLAUDE.md`, `.cursorrules`, `.github/copilot-instructions.md`) and agent configs (`.cursor/`, `.mcp.json`, `.agents/mcp_config.json`, `opencode.json`, `.gemini/settings.json`, `.codex/config.toml`).
2. Extend `lore init` with `--full`, `--setup [agent|all]`, `--rules`, and `--ingest` flags, running the full initialization pipeline (init store -> inject rules -> ingest code AST -> configure MCP servers) while preserving all existing rules, prompts, and MCP entries.
3. Enhance `lore init` default output to display detected agents with clear, context-aware next steps when run without flags.
4. Align `lore onboard` with `setupCommand` to eliminate hardcoded Claude CLI snippets in favor of automated multi-agent configuration.

**Tech Stack:** Node.js (>=22), TypeScript (strict), Commander.js, Picocolors, SQLite.

**Spec:** `SPEC.md` §15 (deviation log & agent onboarding extensions)

## Global Constraints

- Root cause, never convenient patches (Rule 1).
- Evidence before assertions with reproducible smoke commands (Rule 2).
- Conventional commits: `feat(init): ...`, `feat(onboard): ...`, `docs: ...` (Rule 4).
- English only, absolutely no emoji anywhere (use `[OK]`, `[WARN]`, `[NOTE]`, `[TIP]`) (Rule 5).
- Always-loaded docs (`README.md`, `AGENTS.md`, `CONTRIBUTING.md`) stay strictly under 16 KB each (Rule 7).
- Update living documentation in the same PR (`SPEC.md` §15, `README.md`) (Rule 8).

## Review Focus

1. **Pre-existing agent instructions**: A project with a carefully crafted `AGENTS.md` or `CLAUDE.md` must have its original contents 100% preserved; the Lore memory protocol block is only appended between markers.
2. **Pre-existing MCP configurations**: A developer with pre-configured MCP tools (e.g., GitHub MCP, Postgres MCP in `.cursor/mcp.json`) must never lose their existing tools when `setup` runs.
3. **Non-destructive idempotent re-runs**: Running `lore init --full` multiple times in a row must not duplicate `.gitignore` lines, rule blocks, or config entries.
4. **Solo mode synergy**: Running `lore init --full --solo` must configure `trust_mode: permissive` so newly written memories are immediately searchable without manual approval.
5. **Interactive vs Non-interactive TTY**: Commands must run cleanly in CI environments without hanging on stdin prompts.

---

## Tasks

### Task 1: Centralized Workspace Agent & Stack Detector

**Files:**
- Modify: `src/commands/setup.ts`
- Test: `scripts/setup-smoke.mjs`

**Interfaces:**
- Produces:
  ```ts
  export interface WorkspaceAgentDetection {
    installedAgents: AgentName[];
    configuredAgents: AgentName[];
    ruleFiles: string[];
    hasCode: boolean;
    codeSignals: string[];
  }
  export function detectWorkspaceAgents(root: string): WorkspaceAgentDetection;
  ```

- [ ] **Step 1: Write test case in smoke test for workspace agent detection**
  Update `scripts/setup-smoke.mjs` to test detection against a mock directory with `.cursor/mcp.json` and `CLAUDE.md`.
- [ ] **Step 2: Run test to verify it fails before implementation**
  Run: `node scripts/setup-smoke.mjs`
  Expected: FAIL (detectWorkspaceAgents not exported).
- [ ] **Step 3: Implement `detectWorkspaceAgents` in `src/commands/setup.ts`**
  Scan workspace root for agent rule files, config files, and code signals (`package.json`, `Cargo.toml`, `pyproject.toml`, etc.).
- [ ] **Step 4: Run test to verify it passes**
  Run: `node scripts/setup-smoke.mjs`
  Expected: PASS [OK].
- [ ] **Step 5: Commit**
  `git commit -m "feat(setup): add centralized workspace agent and stack detector"`

---

### Task 2: Seamless All-In-One Onboarding Flags for `lore init`

**Files:**
- Modify: `src/commands/init.ts`
- Modify: `src/cli.ts`
- Test: `scripts/init-existing-repo-smoke.mjs`

**Interfaces:**
- Consumes: `detectWorkspaceAgents` from `src/commands/setup.ts`, `installAgentRules` from `src/commands/rules.ts`, `ingestCommand` from `src/commands/ingest.ts`, `setupCommand` from `src/commands/setup.ts`.
- Extends:
  ```ts
  export interface InitOptions {
    root?: string;
    gitignore?: boolean;
    trustMode?: 'strict' | 'permissive';
    solo?: boolean;
    full?: boolean;
    setup?: string | boolean;
    rules?: boolean;
    ingest?: boolean;
    yes?: boolean;
  }
  ```

- [ ] **Step 1: Write failing smoke test `scripts/init-existing-repo-smoke.mjs`**
  Create simulated pre-existing repo with `package.json`, custom `AGENTS.md` instructions, and `.cursor/mcp.json`. Run `lore init --full --solo`.
- [ ] **Step 2: Run test to verify it fails**
  Run: `node scripts/init-existing-repo-smoke.mjs`
  Expected: FAIL (`--full` unknown / not executed).
- [ ] **Step 3: Implement `--full`, `--setup`, `--rules`, `--ingest` and smart detection banner in `src/commands/init.ts`**
  - When `--full`: sequentially runs init, rules injection, codebase ingestion, and setup for detected agents.
  - When bare `init`: outputs `[NOTE]` banner listing detected agents and rule files with exact next-step guidance.
  - Register options in `src/cli.ts`.
- [ ] **Step 4: Run smoke test to verify all assertions pass**
  Verify:
  1. Original `AGENTS.md` custom prompt is preserved + Lore protocol appended.
  2. Existing MCP servers in `.cursor/mcp.json` are retained + `lore` entry merged.
  3. `package.json` dependencies are ingested into active memory.
  4. Permissive trust mode is active.
- [ ] **Step 5: Commit**
  `git commit -m "feat(init): support --full onboarding and smart agent detection"`

---

### Task 3: Modernize `lore onboard` with Multi-Agent Setup Integration

**Files:**
- Modify: `src/commands/onboard.ts`
- Test: `scripts/setup-smoke.mjs`

**Interfaces:**
- Consumes: `detectWorkspaceAgents` and `setupCommand` from `src/commands/setup.ts`.

- [ ] **Step 1: Write test case for onboard multi-agent detection**
  Verify `onboardCommand` configures detected agents without hardcoding Claude.
- [ ] **Step 2: Run test to verify failure/missing integration**
  Run: `node scripts/setup-smoke.mjs`
- [ ] **Step 3: Update `src/commands/onboard.ts`**
  Use `detectWorkspaceAgents(root)`. Automatically invoke `setupCommand` or print tailored connection instructions for all detected agents.
- [ ] **Step 4: Verify test passes**
  Run: `node scripts/setup-smoke.mjs`
- [ ] **Step 5: Commit**
  `git commit -m "feat(onboard): modernize multi-agent detection and setup integration"`

---

### Task 4: Living Documentation and Verification

**Files:**
- Modify: `SPEC.md`
- Modify: `README.md`
- Modify: `package.json`

- [ ] **Step 1: Add `init:smoke` to `package.json` scripts**
- [ ] **Step 2: Update `SPEC.md` §15 with deviation log for `lore init --full` and detection**
- [ ] **Step 3: Update `README.md` CLI reference table**
- [ ] **Step 4: Run full verification suite**
  Run: `npm run typecheck && npm run smoke && npm run mcp:smoke && npm run setup:smoke && npm run rules:smoke && npm run trust:smoke && node scripts/init-existing-repo-smoke.mjs && npm run docs:lint && npm run check:public`
- [ ] **Step 5: Commit**
  `git commit -m "docs: document --full init and workspace agent detection"`
