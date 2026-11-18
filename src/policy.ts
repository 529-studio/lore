import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { parse } from 'yaml';
import { teamMode, type Principal } from './identity.js';
import {
  checkAuthorization,
  policyPath,
  type Action as AuthAction,
  type GranularPolicyFile,
  type TokenRevocationRecord,
} from './policy/auth.js';

export type Action = AuthAction;
export type PolicyFile = GranularPolicyFile;
export type { TokenRevocationRecord, GranularPolicyFile };
export { revokeToken, isTokenRevoked, listRevocations, matchSubject, policyPath } from './policy/auth.js';

export function loadPolicy(root: string): GranularPolicyFile | null {
  const file = policyPath(root);
  if (!existsSync(file)) return null;
  try {
    return parse(readFileSync(file, 'utf8')) as GranularPolicyFile;
  } catch {
    return null;
  }
}

/**
 * Gate an authority action. Local single-user mode allows everything; team mode
 * requires an identity and a role from lore.policy.yml (default: maintainers).
 * Rejects revoked tokens immediately.
 */
export function requireAction(
  root: string,
  action: Action,
  ctx: { tier?: number; subject?: string } = {},
): Principal {
  return checkAuthorization(root, action, ctx);
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
