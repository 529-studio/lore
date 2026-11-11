# L04 — The path guard was applied to one call site

**What happened.** `hashFile` was hardened against path traversal, but the write command and the MCP
server kept using an older unguarded helper. `lore write --ref ../../etc/passwd` happily hashed the
file. The audit that found it only found it because it ran the command instead of reading the diff.

**Guardrail.** When a shared helper is the fix, delete the unsafe variant and grep every caller. Then
prove it with a command that attempts the escape.
