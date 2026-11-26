import type { GranularPolicyFile, LinksPolicy, PublishPolicy } from './auth.js';

export type { LinksPolicy, PublishPolicy };

/**
 * Glob match with `*` (one path segment), `**` (across segments) and `?`.
 * Anchored: the pattern must describe the whole value. Publish allow/deny
 * rules use this, so `file:secrets/*` cannot match `file:secrets/deep/key`.
 */
export function globMatch(pattern: string, value: string): boolean {
  let source = '^';
  for (let i = 0; i < pattern.length; i += 1) {
    const ch = pattern[i];
    if (ch === '*') {
      if (pattern[i + 1] === '*') {
        source += '.*';
        i += 1;
      } else {
        source += '[^/]*';
      }
    } else if (ch === '?') {
      source += '[^/]';
    } else {
      source += ch.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    }
  }
  source += '$';
  return new RegExp(source).test(value);
}

export interface PublishDecision {
  publishable: boolean;
  reason: string;
}

export interface PublishSubject {
  subject: string;
  trust?: string | null;
  state?: string | null;
  valid_to?: string | null;
}

const TRUST_RANK: Record<string, number> = {
  canonical: 3,
  candidate: 2,
  contested: 1,
  stale: 1,
  retracted: 0,
};

/**
 * The one publish decision: `lore-hub` filters every external payload with it
 * and `lore export --filter publish` projects with it, so the server and the
 * client can never disagree about what may leave the repository.
 */
export function publishDecision(policy: GranularPolicyFile | null, subject: PublishSubject): PublishDecision {
  const publish = policy?.publish;
  if (!publish) return { publishable: false, reason: 'no publish policy: default internal' };

  if (subject.state && subject.state !== 'active') {
    return { publishable: false, reason: `state ${subject.state} is not published` };
  }
  if (subject.valid_to) return { publishable: false, reason: 'superseded claims are not published' };

  if (publish.deny?.some((pattern) => globMatch(pattern, subject.subject))) {
    return { publishable: false, reason: `denied by publish.deny` };
  }

  const required = publish.require_trust ?? 'canonical';
  const trust = subject.trust ?? 'candidate';
  if ((TRUST_RANK[trust] ?? 0) < (TRUST_RANK[required] ?? 3)) {
    return { publishable: false, reason: `trust ${trust} is below require_trust ${required}` };
  }

  const scope = publish.default_scope ?? 'internal';
  if (scope === 'public') return { publishable: true, reason: 'publish.default_scope is public' };
  if (publish.allow?.some((pattern) => globMatch(pattern, subject.subject))) {
    return { publishable: true, reason: 'matched publish.allow' };
  }
  return { publishable: false, reason: 'not on publish.allow (default_scope internal)' };
}

/** True when `to_repos` names the subscriber; `*` opens the payload to any repo. */
export function subscriberAllowed(policy: GranularPolicyFile | null, subscriberRepoId: string): boolean {
  const to = policy?.publish?.to_repos;
  if (!to?.length) return false;
  return to.includes('*') || to.includes(subscriberRepoId);
}

export interface LinkTarget {
  /** Namespace segment: `ext:<slug>/...`. */
  slug: string;
  /** Hub repository id used for the external pull. */
  repoId: string;
}

/**
 * Resolve `links:` into slug/repo-id pairs. A bare list uses the same value for
 * both; a mapping may set `repo_id` when the hub identity is a UUID and the
 * human-readable slug differs.
 */
export function linkTargets(policy: GranularPolicyFile | null): LinkTarget[] {
  const links = policy?.links;
  if (!links) return [];
  const entries: Array<[string, LinkTarget]> = Array.isArray(links)
    ? links.map((name) => [name, { slug: name, repoId: name }])
    : Object.entries(links).map(([slug, value]) => {
        if (typeof value === 'string') return [slug, { slug, repoId: value }];
        if (value && !Array.isArray(value) && typeof value === 'object' && typeof value.repo_id === 'string') {
          return [slug, { slug, repoId: value.repo_id }];
        }
        return [slug, { slug, repoId: slug }];
      });
  const seen = new Set<string>();
  const out: LinkTarget[] = [];
  for (const [, target] of entries) {
    const slug = target.slug.trim();
    const repoId = target.repoId.trim();
    if (!slug || !repoId || seen.has(slug)) continue;
    seen.add(slug);
    out.push({ slug, repoId });
  }
  return out.sort((a, b) => a.slug.localeCompare(b.slug));
}

/** Slugs of the repositories this consumer subscribes to. */
export function linkedRepos(policy: GranularPolicyFile | null): string[] {
  return linkTargets(policy).map((target) => target.slug);
}
