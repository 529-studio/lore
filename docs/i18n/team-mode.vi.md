# Lore team mode: tài liệu để bàn (v2)

**Trạng thái:** đã chốt hướng, sẵn sàng cắt sprint · #15, #16, #49, #50, #51, #52
**Cập nhật:** 2026-11-12 · bản canonical: `docs/team-mode.md`

---

## Thay đổi lớn so với v1

**Memory tách khỏi git host.** Team dùng GitLab nội bộ, Azure DevOps, hoặc không có remote nào —
memory vẫn chia sẻ được. Đây là điều 5 câu trả lời của team làm rõ.

## Kiến trúc

```
Postgres (team, tuỳ chọn)      self-host hoặc managed của tập đoàn
      ↑ push / fetch commit
SQLite .lore (cache + outbox)  luôn có, chạy offline
      ↑ MCP / CLI
Claude, Codex, Gemini
```

- **Repo identity không phải git remote**: UUID sinh một lần trong `.lore/config.json`.
- **Sync = commit DAG**, không phải CRDT: `lore fetch` / `lore push`, merge bằng ladder có sẵn.
- **Offline là queue**: ghi local trước, push sau.
- **Air-gapped**: `lore bundle export/import` — gửi commit còn thiếu; mã hoá bằng `LORE_BUNDLE_PASSPHRASE` nếu đặt. Không copy AGENTS.md.

### Hai loại "mới"

| Trục | Câu hỏi | Xử lý |
|---|---|---|
| Memory | Store có commit mới hơn local? | `lore fetch`, status báo "memory ahead N" |
| Code | Evidence hash có khớp file trên máy? | nếu không: **ahead of checkout**, không phải stale |

Claim "ahead of checkout" bị loại khỏi retrieval mặc định, vẫn hiện trong `blame` kèm cảnh báo.

## Quyền và tự động hoá

`lore.policy.yml` versioned trong repo: ai được approve T3/T4, ai resolve, subject nào cần 2 approval.

Ba loại approver:
- **Human** theo role;
- **Machine** chỉ cho T0/T1, phải kèm policy version + rule;
- **N-of-M**: 1 human + 1 audit attestation cho subject bảo vệ.

Audit agent là principal riêng, read-only, ký attestation, **không được approve việc của chính nó**.

Khi con người chỉ check UI: review **policy + digest** (số claim thêm, conflict, auto-approve,
audit disagreement, rollback), không review từng claim.

## Redact và purge

| Thao tác | Tác dụng | Ai |
|---|---|---|
| `retract` | đổi state, nội dung còn | author/maintainer |
| `redact` | nội dung → `[redacted]`, **giữ id**, ghi audit | maintainer |
| `purge` | xoá row, audit giữ id + lý do, không giữ nội dung | maintainer, 2 approval |

Dùng cho PII, secret lỡ ghi, yêu cầu pháp lý.

## Secrets

Không thể "không bao giờ"; mục tiêu là **không âm thầm, không tồn tại lâu**.

| Lớp | Kiểm soát |
|---|---|
| Không lộ | `.env` ngoài sandbox agent; inject runtime; context chỉ chứa tên biến |
| Không lưu | Lore quét mọi claim write; match → từ chối, không lưu; MCP redact docs |
| Không commit | `lore guard --staged` + pre-commit hook; CI; push protection; pre-receive hook |
| Giảm thiệt hại | canary token, credential ngắn hạn, least privilege, rotation |

## Sprint

| Bước | Nội dung | Ước lượng |
|---|---|---|
| 0 | Secret firewall + `lore guard` (#51) | 10h |
| 1 | Repo identity, fetch/push, bundle (#49) | 24h |
| 2 | Store interface → Postgres + migrate (#15) | 36h |
| 3 | Identity + policy enforcement (#16) | 20h |
| 4 | Redact/purge (#50) | 12h |
| 5 | Policy engine + audit attestation (#52) | 24h |
| 6 | Docs | 8h |

Tổng ~134h. Bước 0 làm trước vì nó bảo vệ các bước sau.

## Còn mở

1. IdP của tập đoàn là gì (Azure AD, Keycloak…)? → quyết định OIDC hay token.
2. Có yêu cầu compliance bắt purge trong bao lâu? → bước 4 có thể phải lên trước.
3. Ai vận hành Postgres — team hay platform group?
4. Một database hay một schema mỗi repo? Đề xuất: một schema mỗi repo, một database mỗi team.
