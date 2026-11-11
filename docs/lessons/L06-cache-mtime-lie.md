# L06 — The cache served a hash for content it never read

**What happened.** The file hash cache keyed on size and mtime. Editing a file while preserving both
(trivially: write new bytes of the same length, then `touch -r` the original) produced a cache hit for
the old hash. `status` reported zero stale claims, `verify` said valid, and the next `ingest`
re-blessed the old hash as the current one.

**Why it was expensive.** It turned the core promise — "we re-hash evidence to detect drift" — into a
lie, and the failure mode is silent by construction.

**Guardrail.** A content cache keyed on stat data must include `ctime_ns`: any write changes ctime,
including when mtime is restored. Keep a bypass (`--no-cache`, `LORE_NO_CACHE=1`) and test the
mtime-preserving edit explicitly.
