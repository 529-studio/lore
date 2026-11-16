# Memory Authoring Templates & Entity Dossier Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Transform Lore's dashboard memory creation and inspection into an intuitive, human-centered experience: provide natural 2-field memory authoring with presets, autocomplete, and live agent prompt previews, and introduce an Entity Dossier view grouping fragmented 1-line claims into cohesive, readable entity profiles.

**Architecture:** 
1. In `src/ui/server.ts`, add `GET /api/entities` endpoint extracting distinct active entities (`file`, `env`, `rule`, `doc`, `adr`, `pkg`) with type tags and display labels.
2. Upgrade the "Record Fact" modal with memory type presets (`Rule / Guideline`, `Config / Env`, `Code Invariant`, `Custom Triple`), scope autocomplete (`<datalist id="entity-suggestions">`), and a live "What AI Agents Will See" prompt injection preview.
3. Introduce an **Entity Dossier** view (`dossier`) as the primary Knowledge Hub view mode: aggregates atomic claims under their entity subjects (`subject_id`), rendering structured cards with bulleted facts and a quick `[+ Add Fact to this Entity]` action.
4. Maintain full backward compatibility with existing `POST /api/claim`, `POST /api/supersede`, `cards`, `graph`, and `raw` views.

**Tech Stack:** TypeScript, Node.js (`node:http`), better-sqlite3, vanilla DOM/CSS (per ADR-004).

---

## Global Constraints

- Root cause, never convenient patch (AGENTS.md Rule 1).
- Passing unit tests are never sufficient: every claim verified with command outputs (AGENTS.md Rule 2).
- Merge commits only (`gh pr merge --merge`), no squash or rebase merge (AGENTS.md Rule 4).
- English, no emoji anywhere in code, commits, logs, or chat replies. Use `[OK]`, `[WARN]`, `[ERR]` (AGENTS.md Rule 5).
- Always-loaded docs (`README.md`, `AGENTS.md`, `CONTRIBUTING.md`) must stay under 16 KB each and 36 KB combined (AGENTS.md Rule 7).
- No external frontend frameworks or heavy dependencies; adhere to ADR-004 (vanilla JS/CSS in `src/ui/server.ts`).

---

### Task 1: Backend `GET /api/entities` Endpoint & Smoke Test

**Files:**
- Modify: `src/ui/server.ts:1680-1790`
- Modify: `scripts/ui-smoke.mjs:85-125`

**Interfaces:**
- Produces:
  - `GET /api/entities` -> `Array<{ id: string, type: 'file' | 'env' | 'rule' | 'doc' | 'adr' | 'pkg' | 'symbol', label: string, claimCount: number }>`

- [ ] **Step 1: Add `/api/entities` test in `scripts/ui-smoke.mjs`**

Add assertion to `scripts/ui-smoke.mjs`:
```javascript
const entities = await (await fetch(`${handle.url}/api/entities`)).json();
if (!Array.isArray(entities) || entities.length === 0) throw new Error('entities endpoint returned no entities');
const sampleEntity = entities[0];
if (!sampleEntity.id || !sampleEntity.type || !sampleEntity.label) throw new Error('entity object missing required fields');
```

- [ ] **Step 2: Run smoke test to verify it fails**

```sh
node scripts/ui-smoke.mjs
```
Expected: Fails because `/api/entities` returns 404 or unknown endpoint.

- [ ] **Step 3: Implement `GET /api/entities` in `src/ui/server.ts`**

Extract active entities from the current branch's active claims, categorize into type, label, and claim count:
```typescript
if (url.pathname === '/api/entities') {
  const active = activeAt(db, head(db, ref) ?? head(db, 'main'));
  const counts = new Map<string, number>();
  for (const id of active.keys()) {
    const row = db.prepare('SELECT subject_id FROM claim WHERE id = ?').get(id) as { subject_id: string } | undefined;
    if (row?.subject_id) {
      counts.set(row.subject_id, (counts.get(row.subject_id) ?? 0) + 1);
    }
  }
  const result = Array.from(counts.entries()).map(([id, claimCount]) => {
    let type = 'file';
    let label = id;
    if (id.startsWith('env:')) { type = 'env'; label = id.slice(4); }
    else if (id.startsWith('rule:')) { type = 'rule'; label = id.slice(5); }
    else if (id.startsWith('doc:')) { type = 'doc'; label = id.slice(4); }
    else if (id.startsWith('adr:')) { type = 'adr'; label = id.slice(4); }
    else if (id.startsWith('pkg:')) { type = 'pkg'; label = id.slice(4); }
    else if (id.startsWith('sym:')) { type = 'symbol'; label = id.slice(4); }
    else if (id.startsWith('file:')) { type = 'file'; label = id.slice(5); }
    return { id, type, label, claimCount };
  }).sort((a, b) => a.id.localeCompare(b.id));
  json(res, result);
  return;
}
```

- [ ] **Step 4: Re-run smoke test to confirm green**

```sh
npm run build && node scripts/ui-smoke.mjs
```
Expected: `[OK] ui: read endpoints, CSRF, origin check, ... entities` passes.

- [ ] **Step 5: Commit changes**

```sh
git add src/ui/server.ts scripts/ui-smoke.mjs
git commit -m "feat(ui): add /api/entities endpoint for subject autocomplete and scoping"
```

---

### Task 2: Smart 2-Field Memory Authoring Modal with Presets & Live Agent Preview

**Files:**
- Modify: `src/ui/server.ts:480-550` (Modal HTML & CSS)
- Modify: `src/ui/server.ts:1190-1250` (Modal event handlers & live preview)

**Interfaces:**
- Modal features:
  - Preset Type Pills: `[ Rule / Guideline ]`, `[ Config / Env ]`, `[ Code Invariant ]`, `[ Custom Triple ]`.
  - Target / Scope field: `<input id="modal-scope" list="entity-suggestions">` with `<datalist id="entity-suggestions">`.
  - Content Textarea: `<textarea id="modal-obj">` (placeholder: "What Lore should remember (rule, constraint, or factual note)").
  - Live Preview container: `#modal-preview` showing how `memory_search` projects the memory into agent prompts.
  - Save action: automatically formats subject prefix and predicate, dispatches to `POST /api/claim`.

- [ ] **Step 1: Update modal HTML and CSS in `src/ui/server.ts`**

Replace raw triple form with Type pills, Scope input with datalist, statement textarea, and preview card.

- [ ] **Step 2: Implement modal client-side logic in `src/ui/server.ts`**

1. `loadEntitySuggestions()` fetches `/api/entities` and populates `<datalist id="entity-suggestions">`.
2. `updateModalPreview()` updates the live prompt preview box on every keystroke in Scope or Statement.
3. Type pill clicks toggle presets:
   - `Rule`: default prefix `rule:`, predicate `enforces_invariant`.
   - `Config`: default prefix `env:`, predicate `notes`.
   - `Code Invariant`: default prefix `file:`, predicate `has_guardrail`.
   - `Custom`: displays predicate dropdown and raw inputs.
4. Modal save formats final `subject`, `predicate`, and `object` and posts to `/api/claim`.

- [ ] **Step 3: Test modal interactions in `scripts/ui-smoke.mjs`**

Verify that `POST /api/claim` accepts rule and invariant claims created through the normalized flow.

- [ ] **Step 4: Build and verify smoke tests**

```sh
npm run build && node scripts/ui-smoke.mjs
```

- [ ] **Step 5: Commit changes**

```sh
git add src/ui/server.ts scripts/ui-smoke.mjs
git commit -m "feat(ui): implement smart memory authoring modal with presets, autocomplete, and live agent preview"
```

---

### Task 3: Entity Dossier View in Knowledge Hub

**Files:**
- Modify: `src/ui/server.ts:250-290` (View switcher buttons & containers)
- Modify: `src/ui/server.ts:690-770` (Render views: `renderDossierView`)
- Modify: `src/ui/server.ts:1230-1270` (View switching logic)

**Interfaces:**
- Switcher segmented control: `[ Dossier | Cards | Graph | Raw Table ]`.
- `renderDossierView(claims)`:
  - Aggregates claims by `subject_id`.
  - Card per Entity with:
    - Entity Type Badge (`file`, `env`, `rule`, `doc`, `adr`) and Subject ID.
    - Active claim counter badge.
    - Bulleted list of facts/claims with predicate tags (`imports_module`, `exposes_route`, `enforces_invariant`).
    - Quick actions: `[+ Add Fact to this Entity]` (opens modal with Scope pre-filled) and `[Inspect]`.

- [ ] **Step 1: Add Dossier container and switch button in `src/ui/server.ts`**

Add `#view-dossier` button and `#dossier-view` container. Set `dossier` as default view.

- [ ] **Step 2: Implement `renderDossierView(claims)` in `src/ui/server.ts`**

Group `claims` by `subject_id`. Generate structured cards with clean predicate badges and statement text.

- [ ] **Step 3: Connect quick actions**

Clicking `[+ Add Fact to this Entity]` calls `openNewModal({ scope: entity.id })`, pre-filling the scope and opening the modal.

- [ ] **Step 4: Update `scripts/ui-smoke.mjs` to verify HTML contains Dossier markup**

Add assertion in `scripts/ui-smoke.mjs` ensuring `#view-dossier` and `#dossier-view` exist in the served page.

- [ ] **Step 5: Build and test**

```sh
npm run build && node scripts/ui-smoke.mjs
```

- [ ] **Step 6: Commit changes**

```sh
git add src/ui/server.ts scripts/ui-smoke.mjs
git commit -m "feat(ui): add entity dossier view to knowledge hub with entity grouping and quick fact authoring"
```

---

### Task 4: Full Verification, Documentation, and Sprint PR

**Files:**
- Modify: `README.md`
- Modify: `docs/dashboard.md`
- Modify: `SPEC.md:440-457` (Deviation log update if needed)

- [ ] **Step 1: Update documentation**

Document the Entity Dossier view and memory authoring presets in `docs/dashboard.md` and `README.md`.

- [ ] **Step 2: Run all validation suites**

```sh
npm run build
npm run smoke
npm run mcp:smoke
node scripts/ui-smoke.mjs
npm run check:public
npm run docs:lint
```
All commands must pass with zero errors.

- [ ] **Step 3: Commit documentation**

```sh
git add README.md docs/dashboard.md SPEC.md
git commit -m "docs(ui): document entity dossier view and memory authoring templates"
```

- [ ] **Step 4: Push branch and create Pull Request**

```sh
git push origin feat/ui-memory-templates-and-entity-view
gh pr create --title "feat(ui): memory authoring templates, entity dossier view, and agent preview" \
  --body "Close #117

## Summary
- Introduces natural 2-field memory authoring with presets (Rule, Config, Invariant, Custom) and live agent prompt injection preview.
- Adds /api/entities endpoint providing instant entity autocomplete.
- Introduces Entity Dossier view as the primary Knowledge Hub display mode, grouping atomic claims into clean entity cards with quick-add actions.

## Evidence
- node scripts/ui-smoke.mjs [OK]
- npm run smoke [OK]
- npm run mcp:smoke [OK]
- npm run check:public [OK]
- npm run docs:lint [OK]"
```
