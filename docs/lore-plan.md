# Lore — kế hoạch & painpoint

**Trạng thái:** M0 xong (chạy thật trên `mcp-scan`: 77 claim, drift detection hoạt động)
**Repo:** https://github.com/529-studio/lore (private)
**Ngày:** 2026-11-10

---

## 1. Painpoint

Khi dev một dự án bằng nhiều agent/model (Claude Code, Codex, Gemini CLI, Cursor), memory hiện tại — `AGENTS.md`, MCP memory server, vector store — đều là **append-only log**. Nó lưu được, nhưng không ai tin được.

Năm triệu chứng, xếp theo mức nghiêm trọng:

| # | Triệu chứng | Hệ quả thực tế |
|---|---|---|
| F1 | Fact chết vẫn sống — file đã đổi, memory vẫn nói cách cũ | Agent sửa sai, đốt token, mất niềm tin |
| F2 | Hai fact mâu thuẫn cùng "đúng" | Retrieval trả cả hai, model chọn bừa |
| F3 | Không revert được một phiên học sai | Memory bẩn vĩnh viễn; prompt injection thành persistent |
| F4 | Không blame được — "ai dạy agent điều này?" | Không ai dám dùng memory cho việc quan trọng |
| F5 | Agent B không tin A nên làm lại từ đầu | Multi-model không cộng được lực, chỉ chia sẻ chi phí |

Gốc rễ: **memory hiện tại là log, không phải lịch sử có thể kiểm chứng.** Log thì append; lịch sử thì có diff, revert, blame, merge.

---

## 2. Giải pháp: memory như git

Không bán "versioned memory". Bán **"undo những gì agent đã học"**.

| Git | Lore | Giá trị |
|---|---|---|
| `diff` | agent biết gì hôm nay mà hôm qua chưa biết | review trước khi tin |
| `revert` | rollback một phiên học sai | tính năng bán được |
| `blame` | fact này do ai/cái gì sinh ra | tin cậy |
| `merge` | hai agent làm song song, gộp không mâu thuẫn | multi-model thật |

### Ba trụ cột kỹ thuật

1. **Claim + evidence hash.** Mỗi fact là một claim `(subject, predicate, object)` + bi-temporal + authority tier + evidence có hash nội dung. Đọc thì verify lại hash → phát hiện drift thay vì tin mù.
2. **Immutable, content-addressed.** Claim id = hash nội dung, nên hai agent quan sát cùng một fact sinh cùng id. Merge trở thành bài toán set, không phải text.
3. **Thang thẩm quyền tất định.** `T0 test/CI` → `T1 tool-observed` → `T2 human approve` → `T3 human chat` → `T4 agent suy luận`. Conflict giải bằng tier, không bằng "cái mới hơn thắng". Không quyết được thì abort, không đoán.

### Vì sao bắt đầu từ code repo

Entity resolution là thứ giết mọi memory system. Trong code repo nó **miễn phí**: `sym:path#function` từ tree-sitter/LSP là deterministic. Không cần LLM đặt tên, không bao giờ mơ hồ. Đây là lợi thế phi đối xứng — và cũng là ranh giới cố ý của v0.

---

## 3. Kiến trúc

```
store (SQLite, source of truth)  →  CLI  →  MCP  →  projection (.md / AGENTS.md)
```

- `entity` / `claim` / `evidence` / `memory_commit` / `commit_entry` / `ref` / `merge_decision`
- Mỗi session ghi vào branch `agent/<session>`, merge vào `main` khi xong (mô hình PR)
- Không xoá cứng: retract / supersede / GC đều là trạng thái

Chi tiết schema + thuật toán merge (R1–R6): `SPEC.md` trong repo.

---

## 4. Roadmap

| Mốc | Nội dung | Trạng thái |
|---|---|---|
| **M0** | `init`, schema, `write` (draft), `ingest`, `log`, `blame`, `status` | ✅ xong |
| **M1** | commit DAG đầy đủ, `diff`, `revert` | kế tiếp |
| **M2** | 3-way merge trên `(subject, predicate)`, thang R1–R6, `resolve` | |
| **M3** | staleness nâng cao: `verify`, lọc trong retrieval, incremental rehash | |
| **M4** | MCP server + `export --md` (projection sang `AGENTS.md`) | |
| **M5** | eval harness: replay 20 session, đo 6 metric | |

### Kết quả M0 (số thật, không phải demo)

Trên `mcp-scan` (77k file loại trừ, 152 file tracked):

- **77 claim** sinh từ extractor tất định: 39 doc section, 25 rule registry, 6 keyword, 2 script, 2 env var, 1 package name, 1 bin, 1 runtime requirement
- **Idempotent:** chạy `ingest` lần hai → 0 claim mới (content-addressed)
- **Draft gating:** agent ghi claim suy luận → `draft`, không vào retrieval; `approve` mới active
- **Drift detection:** sửa `src/rules.js` → 10 claim thành `stale`; restore file → `stale` về 0, không claim nào bị xoá

---

## 5. Đo lường (M5, không dùng LLM judge)

| Metric | Ngưỡng v0 |
|---|---|
| `stale_rate` | < 15% |
| `false_claim_rate` | < 5% |
| `conflict_rate` | < 10% |
| `revert_correctness` | 100% |
| `token_savings` | > 30% |
| `time_to_first_useful` | < 10 phút |

Hai số quyết định sản phẩm sống hay chết: **revert_correctness** và **token_savings**.

---

## 6. Rủi ro

| Rủi ro | Xác suất | Đối phó |
|---|---|---|
| Vendor ship memory branches native | Cao | Cross-vendor là lợi thế duy nhất; họ không làm memory chung cho đối thủ |
| Merge conflict quá nhiều → người dùng bỏ | Trung bình | Branch per session, merge theo PR; ontology `many` để giảm conflict giả |
| Write path quá chặt → agent không ghi gì | Trung bình | Auto-promote T0/T1; chỉ chặn suy luận |
| Rehash chậm trên repo lớn | Trung bình | Cache mtime, verify lazy |
| Người dùng không hiểu "authority tier" | Cao | Ẩn mặc định, chỉ hiện khi conflict |

---

## 7. Việc cần chốt

- [ ] Entity resolution ngoài code (issue, ADR, quyết định kiến trúc): dùng gì thay symbol ID?
- [ ] Ontology viết tay hay bootstrap từ claim đã có?
- [ ] Cross-repo: share memory giữa monorepo A và B, hay chỉ `import`?
- [ ] Có cần MCP trước M1 không (để test với Claude Code + Codex sớm)?
