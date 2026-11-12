import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { parse } from 'yaml';
import { resolvePrincipal, teamMode, type Principal, type Role } from './identity.js';

export type Action = 'approve' | 'resolve' | 'redact' | 'purge' | 'promote' | 'attest';

interface PolicyFile {
  roles?: Record<string, string[]>;
  approve?: Record<string, string[]>;
  resolve?: string[] | Record<string, string[]>;
  redact?: string[];
  purge?: string[];
  promote?: string[];
  attest?: string[];
  protected?: Record<string, string[]>;
}

export function policyPath(root: string): string {
  return path.join(root, 'lore.policy.yml');
}

export function loadPolicy(root: string): PolicyFile | null {
  const file = policyPath(root);
  if (!existsSync(file)) return null;
  try {
    return parse(readFileSync(file, 'utf8')) as PolicyFile;
  } catch {
    return null;
  }
}

function isMember(policy: PolicyFile | null, role: string, principal: Principal): boolean {
  if (role === '*') return true;
  if (role === 'maintainers') return principal.role === 'maintainer';
  if (role === 'contributors') return true; // any authenticated identity
  if (role === 'machines') return principal.role === 'machine';
  if (role === 'auditors') return principal.role === 'auditor' || principal.role === 'maintainer';
  const members = policy?.roles?.[role];
  if (members?.includes('*')) return true;
  if (members?.includes(principal.id)) return true;
  return role === principal.role;
}

function protectedRoles(policy: PolicyFile | null, subject: string | undefined): string[] | null {
  if (!policy?.protected || !subject) return null;
  for (const [pattern, roles] of Object.entries(policy.protected)) {
    const prefix = pattern.endsWith('*') ? pattern.slice(0, -1) : pattern;
    if (subject === pattern || subject.startsWith(prefix)) return roles;
  }
  return null;
}

function requiredRoles(
  policy: PolicyFile | null,
  action: Action,
  ctx: { tier?: number; subject?: string },
): string[] {
  if (action === 'approve') {
    const key = `t${ctx.tier ?? 4}`;
    return policy?.approve?.[key] ?? policy?.approve?.t4 ?? ['maintainers'];
  }
  if (action === 'resolve') {
    const guarded = protectedRoles(policy, ctx.subject);
    if (guarded) return guarded;
    if (Array.isArray(policy?.resolve)) return policy.resolve;
    return (policy?.resolve as Record<string, string[]> | undefined)?.['*'] ?? ['maintainers'];
  }
  const direct = policy?.[action];
  return Array.isArray(direct) ? direct : ['maintainers'];
}

/**
 * Gate an authority action. Local single-user mode allows everything; team mode
 * requires an identity and a role from lore.policy.yml (default: maintainers).
 */
export function requireAction(
  root: string,
  action: Action,
  ctx: { tier?: number; subject?: string } = {},
): Principal {
  const principal = resolvePrincipal();
  if (principal.role === 'machine' && action === 'approve' && (ctx.tier ?? 4) > 1) {
    throw new Error('a machine approver may only approve T0/T1 evidence-backed claims');
  }
  if (!teamMode()) return principal;

  const policy = loadPolicy(root);
  const roles = requiredRoles(policy, action, ctx);
  if (roles.some((role) => isMember(policy, role, principal))) return principal;

  const label = action === 'approve' ? `approve t${ctx.tier ?? 4}` : action;
  throw new Error(
    `${label} requires role ${roles.join(' or ')}; ${principal.id} is ${principal.role} (policy: ${path.basename(policyPath(root))})`,
  );
}

/** True when the policy requires an explicit approval for this tier. */
export function gateTier(root: string, tier: number): boolean {
  if (!teamMode()) return false;
  const policy = loadPolicy(root);
  const roles = policy?.approve?.[`t${tier}`];
  return Boolean(roles && !roles.includes('*'));
}

export function describePolicy(root: string): string {
  const file = policyPath(root);
  return existsSync(file) ? file : '(no policy file: maintainers only in team mode)';
}
