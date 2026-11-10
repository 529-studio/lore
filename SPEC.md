# Lore — SPEC v0.1

> **Git for what your agents know.**
> Versioned, verifiable, mergeable memory cho nhiều agent/model cùng làm một dự án.

Trạng thái: draft, chưa implement. Mọi mục đánh dấu `[?]` là chưa chốt.

---

## 1. Vấn đề

Memory của coding agent hiện nay là **append-only log + vector search**. Nó lưu được, nhưng không ai tin được. Năm triệu chứng, theo thứ tự nghiêm trọng:

| # | Triệu chứng | Hệ quả |
|---|---|---|
| F1 | Fact chết vẫn sống (file đã đổi, memory vẫn nói cách cũ) | Agent sửa sai, tốn token, mất niềm tin |
| F2 | Hai fact mâu thuẫn cùng "đúng" | Retrieval trả cả hai, model chọn bừa |
| F3 | Không revert được một phiên học sai | Memory bẩn vĩnh viễn; prompt injection thành persistent |
| F4 | Không blame được | "Ai dạy agent điều này?" → không trả lời được → không ai dám dùng |
| F5 | Agent B không tin A nên làm lại từ đầu | Multi-model không cộng được lực |

**Điều Lore không làm:** không phải note-taking app, không phải chatbot memory, không phải vector DB.

---

## 2. Non-goals (v0)

- Không universal. v0 chỉ hỗ trợ **code repo** (nơi entity resolution là free nhờ symbol ID).
- Không realtime sync giữa các agent đang chạy. Merge theo mô hình **branch per session → merge khi xong** (như PR).
- Không UI web. CLI + MCP + markdown projection.
- Không tự viết embedding/vector store. Vector chỉ là một tín hiệu xếp hạng phụ, optional.
- Không multi-tenant / cloud ở v0.

---

## 3. Nguyên lý thiết kế (bất biến)

1. **Claim immutable.** Sửa = commit mới. Không có UPDATE trên nội dung claim.
2. **Không xoá cứng.** Retract/supersede/GC đều là trạng thái, dữ liệu gốc còn nguyên. Audit phải trả lời được "tháng 9 agent tin gì".
3. **Mọi claim có evidence.** Claim không evidence chỉ được tồn tại ở trạng thái `draft`, tối đa `gc.ttl_sessions` phiên.
4. **Conflict không tự chọn phe.** Giải bằng thang thẩm quyền tất định (§7), mọi quyết định ghi vào `merge_decision`. Không rõ → abort merge, không đoán.
5. **Đọc thì verify.** Memory là cache của thực tại, không phải chân lý. Mỗi lần đọc đều kiểm tra evidence hash (§8).

---

## 4. Mô hình khái niệm

```
Entity   ── subject của claim. Deterministic ID, không do LLM đặt.
Claim    ── (subject, predicate, object) + thời gian + evidence + authority.
Commit   ── snapshot bất biến của tập claim active. DAG như git.
Branch   ── con trỏ tới commit. main + agent/<session>.
Merge    ── 3-way trên semantic key (subject, predicate).
```

### 4.1 Entity

Entity ID **phải deterministic** để hai agent độc lập sinh ra cùng ID.

| Kind | Format | Nguồn |
|---|---|---|
| `symbol` | `sym:<path>#<qualified_name>` | tree-sitter / LSP |
| `file` | `file:<path>` | filesystem |
| `test` | `test:<path>#<test_name>` | test runner parse |
| `issue` | `issue:<provider>:<id>` | tracker |
| `person` | `person:<email>` | git author |
| `concept` | `concept:<slug>` | human/agent, yếu nhất |

Quy tắc: **không bao giờ** dùng embedding để resolve entity trong code repo. `path#symbol` là duy nhất và ổn định; đổi tên file = entity mới + claim `supersedes` cũ.

### 4.2 Claim

```yaml
id:          c_9f2a1b   # hash canonical của nội dung (xem §5.1)
subject:     sym:src/payments/refund.ts#refundOrder
predicate:   requires_idempotency_key
object:      "Stripe idempotencyKey bắt buộc khi retry"
valid_from:  2026-09-02        # thế giới: từ khi nào điều này đúng
valid_to:    null
tx_from:     2026-11-10T03:11Z # ta biết điều này từ khi nào
authority:   0                 # 0..4, xem §7
confidence:  0.9
author:      agent:codex/ses_01J8...
supersedes:  c_7a1b2c
state:       active            # draft | active | retracted
evidence:
  - kind: test
    ref:  tests/refund.test.ts#L42
    hash: sha256:9c1e...
    verified_at: 2026-11-10T03:11Z
    status: valid              # valid | stale | unverifiable
```

**Bi-temporal là bắt buộc.** `valid_from/to` = thời gian trong thế giới; `tx_from` = thời gian ta biết. Thiếu nó thì không revert sạch và không trả lời được câu hỏi kiểu "tuần trước agent nghĩ gì".

### 4.3 Evidence

| kind | Ý nghĩa | Hash gì |
|---|---|---|
| `test` | test/CI đã pass/fail | hash của test file + commit SHA |
| `file` | nội dung file quan sát được | hash nội dung file |
| `command` | output của command | hash (command + output) |
| `human` | người nói/approve | hash message + author |
| `agent` | agent tự suy luận | hash prompt + model id |

`evidence` **không** phải bằng chứng tuyệt đối — nó là **neo để phát hiện drift**.

---

## 5. Lưu trữ

### 5.1 Canonical hash

`claim_id = sha256(JCS(canonical))` trong đó canonical là object đã sort key, bỏ các field không thuộc nội dung (`verified_at`, `status`). Dùng **RFC 8785 (JCS)** để hai ngôn ngữ khác nhau ra cùng hash. Dedupe miễn phí: cùng fact → cùng id.

### 5.2 Schema (SQLite v0)

```sql
CREATE TABLE entity (
  id         TEXT PRIMARY KEY,
  kind       TEXT NOT NULL,
  canonical  TEXT NOT NULL,
  created_at TEXT NOT NULL
);

CREATE TABLE claim (
  id          TEXT PRIMARY KEY,               -- content hash
  subject_id  TEXT NOT NULL REFERENCES entity(id),
  predicate   TEXT NOT NULL,
  object_json TEXT NOT NULL,
  valid_from  TEXT,
  valid_to    TEXT,
  tx_from     TEXT NOT NULL,
  authority   INTEGER NOT NULL CHECK (authority BETWEEN 0 AND 4),
  confidence  REAL NOT NULL,
  author      TEXT NOT NULL,
  supersedes  TEXT REFERENCES claim(id),
  state       TEXT NOT NULL DEFAULT 'draft'
);
CREATE INDEX claim_key ON claim(subject_id, predicate);
CREATE INDEX claim_state ON claim(state);
CREATE INDEX claim_author ON claim(author);

CREATE TABLE evidence (
  claim_id    TEXT NOT NULL REFERENCES claim(id),
  kind        TEXT NOT NULL,
  ref         TEXT NOT NULL,
  hash        TEXT,
  verified_at TEXT,
  status      TEXT NOT NULL DEFAULT 'valid',
  PRIMARY KEY (claim_id, kind, ref)
);

CREATE TABLE commit (
  id        TEXT PRIMARY KEY,   -- sha256(parent_id || tree_hash || message || author || ts)
  parent_id TEXT REFERENCES commit(id),
  tree_hash TEXT NOT NULL,
  message   TEXT NOT NULL,
  author    TEXT NOT NULL,
  ts        TEXT NOT NULL,
  kind      TEXT NOT NULL       -- write | merge | revert | gc | import
);

CREATE TABLE commit_entry (
  commit_id TEXT NOT NULL REFERENCES commit(id),
  claim_id  TEXT NOT NULL REFERENCES claim(id),
  op        TEXT NOT NULL,      -- add | supersede | retract | restore
  PRIMARY KEY (commit_id, claim_id, op)
);

CREATE TABLE ref (
  name      TEXT PRIMARY KEY,   -- main | agent/<session> | tag/<name>
  commit_id TEXT NOT NULL REFERENCES commit(id)
);

CREATE TABLE merge_decision (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  commit_id  TEXT NOT NULL REFERENCES commit(id),
  subject_id TEXT NOT NULL,
  predicate  TEXT NOT NULL,
  winner     TEXT,
  loser      TEXT,
  rule       TEXT NOT NULL,     -- authority | evidence_valid | cardinality_many | human
  reason     TEXT,
  ts         TEXT NOT NULL
);
```

`tree_hash` = merkle root trên tập `(claim_id, state)` active, sort theo claim_id. Cho phép so sánh snapshot O(1) và diff nhanh.

### 5.3 Active set

`active(ref)` = fold toàn bộ commit từ root theo `commit_entry`. Không cache ở v0 (repo nhỏ); thêm bảng materialized sau nếu > 100k claim.

---

## 6. Write path

Không có gate thì memory thành bãi rác trong 2 tuần — đây là lý do các sản phẩm memory hiện tại chết sau demo.

```
agent viết  →  claim state=draft  →  promote?  →  active
```

**Auto-promote** (không cần người) khi evidence thoả:
- `kind: test` và `status: valid`, hoặc
- `kind: file` với hash khớp tại thời điểm ghi, hoặc
- `kind: command` có output hash.

**Không auto-promote:**
- `kind: agent` (suy luận) → cần `lore approve` hoặc được đọc lại ≥ 2 lần ở 2 session khác nhau.
- `kind: human` qua chat → vẫn cần approve, vì chat là nguồn dễ nhiễm (prompt injection).

**GC draft:** draft không được đọc trong `gc.ttl_sessions` (default 3) → `state=retracted`, `reason=gc`. Không xoá.

**Rule chống nhiễm:** nội dung đọc từ nguồn không tin (issue comment, web, output của agent khác) **không bao giờ** được set authority ≥ 2. Bắt buộc hạ xuống `agent` + `confidence ≤ 0.5` cho tới khi verify.

---

## 7. Merge — thuật toán

### 7.1 Ba bước

```
1. base   = active(merge_base)        # LCA trong DAG
2. ours   = active(ours_ref)
3. theirs = active(theirs_ref)
```

Với mỗi `key = (subject_id, predicate)` trong hợp của 3 tập:

```ts
const b = base.get(key), o = ours.get(key), t = theirs.get(key)

if (o?.id === t?.id) return o              // giống nhau, không làm gì
if (o?.id === b?.id) return t              // chỉ theirs đổi → fast-forward
if (t?.id === b?.id) return o              // chỉ ours đổi

// cả hai đổi khác nhau → đây là chỗ 99% tool chết
return resolve(key, b, o, t)
```

### 7.2 Resolve

Thứ tự luật, dừng ở luật đầu tiên khớp. Mọi bước ghi `merge_decision`.

```
R1. cardinality_many?
    ontology nói predicate này nhận nhiều giá trị
    (vd: uses_library, has_known_bug) → giữ CẢ HAI, không conflict.

R2. authority khác tier?
    tier(o) !== tier(t) → bên cao thắng. Ghi loser vào merge_decision.

R3. một bên stale?
    evidence bên này valid, bên kia stale → bên valid thắng.

R4. một bên retracted?
    retract thắng add (an toàn hơn), trừ khi retract cũng stale.

R5. recency?
    Cùng tier, cùng validity → bên có tx_from mới hơn thắng.
    Luật này CHỈ dùng trong cùng tier. Không bao giờ để recency vượt authority.

R6. không quyết được → ABORT.
    merge dừng, exit code 2, in ra:
      lore resolve <subject> <predicate> --take ours|theirs|both --reason "..."
    Không đoán. Không im lặng.
```

Bên thua **không bị xoá**: set `superseded` + giữ row. `lore blame` vẫn thấy được.

### 7.3 Ontology

`lore.ontology.yml` ở root repo, versioned:

```yaml
predicates:
  requires_idempotency_key: { cardinality: one,  domain: symbol }
  uses_library:            { cardinality: many, domain: symbol }
  has_known_bug:           { cardinality: many, domain: symbol }
  entrypoint:              { cardinality: one,  domain: file }
```

Predicate lạ → mặc định `cardinality: one`, confidence merge thấp hơn, cảnh báo trong `lore status`.

### 7.4 Revert

`lore revert <commit>` = tạo commit mới đảo ngược `commit_entry` (không rewrite history). Đây là lý do dùng DAG: revert không phá audit trail.

Revert **không** revert evidence — evidence là quan sát, không phải quyết định.

---

## 8. Staleness (tính năng lõi)

Mỗi claim mang hash của thứ nó dựa vào. Khi đọc hoặc khi `lore status`:

```
for each claim.active:
  for each evidence with hash:
     if kind == file|test:  rehash path  → mismatch?
     if kind == command:     luôn stale sau 1 session (kết quả cũ)
     if kind == human:       không bao giờ stale
     if kind == agent:       stale nếu model id thay đổi
     mismatch → evidence.status = stale
                claim.status  = stale  (derived, không ghi vào claim)
```

**Hệ quả thiết kế:**

- Retrieval mặc định **loại** claim stale. `--include-stale` để xem.
- `lore status` in: `N stale, M conflicts, K draft sắp GC` — đây là "health" của memory.
- Stale không bị xoá; nó chờ được verify lại (`lore verify <claim>`).

Đây là thứ không tool nào làm tốt, và là lý do duy nhất để dùng Lore thay vì file `AGENTS.md`.

---

## 9. Retrieval

Không phải vector search. Vector chỉ là tiebreak.

```
score = 3.0 * anchor      # claim trỏ vào file/symbol nằm trong scope task
      + 2.0 * proximity   # 1–2 hop quanh entity đang sửa (import graph / call graph)
      + 1.5 * authority   # (4 - tier) / 4
      + 1.0 * verified    # verified_at càng mới càng cao
      + 0.5 * similarity  # optional, nếu có embedding
      - 10.0 * stale      # stale bị đẩy xuống gần như tuyệt đối
```

API:

```
memory_search(query, scope: {files[], symbols[], task}, budget_tokens: 2000)
```

Trả về claim + evidence **inline** để model tự đánh giá, không trả "câu trả lời đã tổng hợp" (tổng hợp = mất provenance).

Dedup theo `(subject, predicate)`: nếu nhiều version, trả bản active + danh sách `superseded` dạng 1 dòng.

---

## 10. Interfaces

### 10.1 CLI

```
lore init                                  # tạo .lore/, ontology mẫu
lore log [--graph] [--limit N]
lore status                                # stale / conflicts / draft sắp GC
lore diff <a>..<b>                         # claim nào thêm/sửa/xoá
lore merge <branch> [--strategy authority|recency]
lore resolve <subject> <predicate> --take ours|theirs|both --reason "..."
lore revert <commit>
lore blame <subject> [<predicate>]         # ai/cái gì dạy điều này
lore verify <claim|scope>                  # chạy lại evidence, cập nhật hash
lore approve <claim>...                    # draft → active
lore export --md > AGENTS.md               # projection read-only
```

Exit codes: `0` ok, `2` merge conflict chưa giải, `3` stale vượt ngưỡng.

### 10.2 MCP

```
memory_search({ query, scope, budget_tokens })
memory_write({ subject, predicate, object, evidence[], confidence })
memory_commit({ message })          # commit branch hiện tại
memory_diff({ from, to })
memory_status({})
```

`memory_write` **không bao giờ** ghi thẳng vào `main`. Luôn vào `agent/<session>`.

### 10.3 Markdown projection

`lore export --md` sinh file deterministic (sort ổn định, không timestamp) để `git diff` sạch:

```md
<!-- generated by lore v0.1 — do not edit, run `lore export --md` -->
## refundOrder (src/payments/refund.ts#refundOrder)
- **requires_idempotency_key**: Stripe idempotencyKey bắt buộc khi retry
  <!-- evidence: test:tests/refund.test.ts#L42 @ 2026-11-10 -->
```

Mục đích: tool chưa có MCP vẫn đọc được, và người review được bằng PR.

---

## 11. Eval

Không dùng LLM judge. Đo bằng outcome.

Bộ đo trên 20 session replay từ repo thật:

| Metric | Định nghĩa | Ngưỡng v0 |
|---|---|---|
| `stale_rate` | % claim active trỏ vào file đã đổi | < 15% |
| `false_claim_rate` | claim bị test trong repo bác | < 5% |
| `conflict_rate` | conflict / tổng merge | < 10% |
| `revert_correctness` | sau revert, test suite pass lại | 100% |
| `token_savings` | token context tiết kiệm vs đọc lại repo | > 30% |
| `time_to_first_useful` | phiên đầu, claim được dùng lại | < 10 phút |

`revert_correctness` và `token_savings` là hai số quyết định sản phẩm có sống không.

---

## 12. Milestones

**M0 — skeleton (tuần 1)**
`init`, schema, `write` (draft), `log`, `blame`. Acceptance: ghi 50 claim qua 2 session, blame trả đúng author + evidence.

**M1 — commit & diff (tuần 1–2)**
DAG, ref, `commit`, `diff`, `revert`. Acceptance: revert 1 commit, active set trở về đúng snapshot trước.

**M2 — merge (tuần 2–3)**
LCA, 3-way, thang R1–R6, `resolve`. Acceptance: 20 kịch bản conflict (2 agent sửa cùng symbol) ra kết quả đúng theo ontology.

**M3 — staleness (tuần 3)**
Hash verify, `status`, `verify`, filter trong search. Acceptance: sửa 10 file, 100% claim liên quan thành stale, không claim nào bị xoá.

**M4 — MCP + projection (tuần 4)**
MCP server, `export --md`. Acceptance: Claude Code và Codex cùng đọc/ghi 1 store, merge sạch.

**M5 — eval harness**
Replay 20 session, in bảng metric.

---

## 13. Câu hỏi mở

- `[?]` Entity resolution ngoài code (issue, doc, quyết định kiến trúc) — dùng gì thay symbol ID?
- `[?]` Ontology: để người viết tay, hay bootstrap từ chính claim đã có (predicate xuất hiện ≥ N lần)?
- `[?]` Cross-repo: memory của monorepo A có share sang B không, hay phải `import`?
- `[?]` Khi `main` bị force-push/rewrite (hiếm), ref của agent xử lý thế nào?
- `[?]` Chi phí rehash toàn bộ mỗi lần `status` — cần incremental inode/mtime cache?
- `[?]` Có cần mã hoá at-rest không, hay để OS/disk lo?

---

## 14. Rủi ro

| Rủi ro | Xác suất | Đối phó |
|---|---|---|
| Vendor ship memory branches native | Cao | Cross-vendor là lợi thế duy nhất; họ không làm memory chung cho đối thủ |
| Merge conflict quá nhiều → bỏ | Trung bình | Branch per session, merge theo PR; ontology `many` để giảm conflict giả |
| Write path quá chặt → agent không ghi gì | Trung bình | Auto-promote T0/T1; chỉ chặn `agent` inference |
| Rehash chậm trên repo lớn | Trung bình | Cache mtime, verify lazy |
| Người dùng không hiểu "authority tier" | Cao | Ẩn mặc định, chỉ hiện khi conflict |

---

## Phụ lục: từ vựng

- **Claim** — một khẳng định có nguồn: "refundOrder bắt buộc idempotency key".
- **Evidence** — quan sát chống đỡ claim, có hash để phát hiện drift.
- **Authority tier** — mức tin cậy của nguồn, 0 (test pass) → 4 (agent suy luận).
- **Stale** — claim trỏ vào thứ đã thay đổi kể từ lúc quan sát.
- **Merge base** — tổ tiên chung gần nhất, dùng cho 3-way merge.
