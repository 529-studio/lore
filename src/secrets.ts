// Secret detection for the write path and the pre-commit guard.
// The goal is never silently and never persistently, not "never".

export interface SecretFinding {
  kind: string;
  match: string;
  masked: string;
  index: number;
}

const PATTERNS: Array<{ kind: string; re: RegExp }> = [
  { kind: 'github-token', re: /\bgh[pousr]_[A-Za-z0-9]{20,}\b/g },
  { kind: 'github-pat', re: /\bgithub_pat_[A-Za-z0-9_]{20,}\b/g },
  { kind: 'gitlab-token', re: /\bglpat-[A-Za-z0-9_-]{20,}\b/g },
  { kind: 'slack-token', re: /\bxox[baprs]-[A-Za-z0-9-]{10,}\b/g },
  { kind: 'aws-key', re: /\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/g },
  { kind: 'openai-key', re: /\bsk-[A-Za-z0-9]{20,}\b/g },
  { kind: 'npm-token', re: /\bnpm_[A-Za-z0-9]{36}\b/g },
  { kind: 'outline-token', re: /\bol_api_[A-Za-z0-9]{10,}\b/g },
  { kind: 'google-key', re: /\bAIza[0-9A-Za-z_-]{35}\b/g },
  { kind: 'private-key', re: /-----BEGIN [A-Z ]*PRIVATE KEY-----/g },
  { kind: 'jwt', re: /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b/g },
  {
    kind: 'credential-assignment',
    re: /\b(?:api[_-]?key|secret|token|password|passwd|access[_-]?key)\b\s*[:=]\s*['"][^'"\s]{12,}['"]/gi,
  },
];

const ENTROPY_RE = /[A-Za-z0-9+/=_-]{32,}/g;
const SAFE_TOKEN_RE = /^(?:sha256:|c_|k_)[0-9a-f]+$/i;
const HEX_RE = /^[0-9a-f]{32,}$/i;
const ENTROPY_THRESHOLD = 4.3;

export function mask(value: string): string {
  if (value.length <= 8) return '***';
  return `${value.slice(0, 4)}...${value.slice(-2)}`;
}

function shannon(value: string): number {
  const counts = new Map<string, number>();
  for (const char of value) counts.set(char, (counts.get(char) ?? 0) + 1);
  let entropy = 0;
  for (const count of counts.values()) {
    const p = count / value.length;
    entropy -= p * Math.log2(p);
  }
  return entropy;
}

function looksRandom(token: string): boolean {
  if (SAFE_TOKEN_RE.test(token) || HEX_RE.test(token)) return false;
  const classes = [/[a-z]/, /[A-Z]/, /[0-9]/, /[^A-Za-z0-9]/].filter((re) => re.test(token)).length;
  return classes >= 3 && shannon(token) >= ENTROPY_THRESHOLD;
}

/** Scan a string. Matches are returned masked; the caller must never log the raw value. */
export function scanText(text: string): SecretFinding[] {
  const findings: SecretFinding[] = [];
  const seen = new Set<string>();

  for (const { kind, re } of PATTERNS) {
    re.lastIndex = 0;
    for (const match of text.matchAll(re)) {
      const value = match[0];
      const key = `${kind}:${value}`;
      if (seen.has(key)) continue;
      seen.add(key);
      findings.push({ kind, match: value, masked: mask(value), index: match.index ?? 0 });
    }
  }

  for (const match of text.matchAll(ENTROPY_RE)) {
    const value = match[0];
    if (!looksRandom(value)) continue;
    const key = `high-entropy:${value}`;
    if (seen.has(key)) continue;
    seen.add(key);
    findings.push({ kind: 'high-entropy', match: value, masked: mask(value), index: match.index ?? 0 });
  }

  return findings.sort((a, b) => a.index - b.index);
}

export class SecretDetected extends Error {
  constructor(
    readonly field: string,
    readonly findings: SecretFinding[],
  ) {
    super(
      `secret detected in ${field}: ${findings.map((f) => `${f.kind} (${f.masked})`).join(', ')}`,
    );
    this.name = 'SecretDetected';
  }
}

/** Throw if any of the given fields contains a secret. */
export function assertNoSecrets(fields: Record<string, string | null | undefined>): void {
  for (const [field, value] of Object.entries(fields)) {
    if (!value) continue;
    const findings = scanText(value);
    if (findings.length) throw new SecretDetected(field, findings);
  }
}
