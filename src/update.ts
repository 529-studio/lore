export interface Semver {
  major: number;
  minor: number;
  patch: number;
  prerelease: string | null;
}

export interface UpdateCheckResult {
  current: string;
  latest: string | null;
  updateAvailable: boolean;
  error?: string;
}

export function parseSemver(v: string): Semver | null {
  const clean = v.trim().replace(/^v/, '');
  const [core, ...preParts] = clean.split('-');
  const prerelease = preParts.length ? preParts.join('-') : null;
  const parts = core.split('.').map((p) => Number(p));
  if (parts.length < 3 || parts.some((n) => Number.isNaN(n))) return null;
  return {
    major: parts[0] ?? 0,
    minor: parts[1] ?? 0,
    patch: parts[2] ?? 0,
    prerelease,
  };
}

/**
 * Returns true if `latest` is strictly newer than `current` according to SemVer.
 */
export function isNewerVersion(current: string, latest: string): boolean {
  const c = parseSemver(current);
  const l = parseSemver(latest);
  if (!c || !l) return false;

  if (l.major !== c.major) return l.major > c.major;
  if (l.minor !== c.minor) return l.minor > c.minor;
  if (l.patch !== c.patch) return l.patch > c.patch;

  // Numbers are equal: a version with a prerelease is older than one without.
  if (c.prerelease && !l.prerelease) return true;
  if (!c.prerelease && l.prerelease) return false;
  if (c.prerelease && l.prerelease) return l.prerelease.localeCompare(c.prerelease) > 0;

  return false;
}

/**
 * Check the latest version of a package on the npm registry.
 * Non-blocking, fails gracefully on timeout or network error.
 */
export async function checkNpmUpdate(
  packageName: string,
  currentVersion: string,
  opts?: { timeoutMs?: number },
): Promise<UpdateCheckResult> {
  const timeoutMs = opts?.timeoutMs ?? 2000;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const url = `https://registry.npmjs.org/${encodeURIComponent(packageName)}/latest`;
    const res = await fetch(url, {
      signal: controller.signal,
      headers: {
        Accept: 'application/json',
        'User-Agent': `lore/${currentVersion}`,
      },
    });

    if (!res.ok) {
      return {
        current: currentVersion,
        latest: null,
        updateAvailable: false,
        error: `registry returned HTTP ${res.status}`,
      };
    }

    const data = (await res.json()) as { version?: unknown };
    if (typeof data?.version !== 'string') {
      return {
        current: currentVersion,
        latest: null,
        updateAvailable: false,
        error: 'invalid version in registry response',
      };
    }

    const latest = data.version;
    const updateAvailable = isNewerVersion(currentVersion, latest);
    return {
      current: currentVersion,
      latest,
      updateAvailable,
    };
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    return {
      current: currentVersion,
      latest: null,
      updateAvailable: false,
      error: msg,
    };
  } finally {
    clearTimeout(timer);
  }
}
