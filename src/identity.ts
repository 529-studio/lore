import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import os from 'node:os';
import { declaresTeamMode } from './config.js';
import { findWorkspaceRoot } from './scope.js';

export type Role = 'maintainer' | 'contributor' | 'machine' | 'auditor';

export interface Principal {
  id: string;
  role: Role;
  source: 'local' | 'token' | 'assertion';
  jti?: string;
}

interface TokenPayload {
  sub: string;
  role: Role;
  exp: number;
  jti?: string;
}

function b64url(input: string): string {
  return Buffer.from(input, 'utf8').toString('base64url');
}

function sign(payload: string, secret: string): string {
  return createHmac('sha256', secret).update(payload).digest('base64url');
}

export function issueToken(sub: string, role: Role, secret: string, days = 30, jti?: string): string {
  const tokenId = jti ?? randomBytes(12).toString('hex');
  const payload: TokenPayload = { sub, role, exp: Date.now() + days * 86_400_000, jti: tokenId };
  const encoded = b64url(JSON.stringify(payload));
  return `${encoded}.${sign(encoded, secret)}`;
}

export function verifyToken(token: string, secret: string): TokenPayload {
  const [encoded, signature] = token.split('.');
  if (!encoded || !signature) throw new Error('malformed token');
  const expected = sign(encoded, secret);
  const a = Buffer.from(signature);
  const b = Buffer.from(expected);
  if (a.length !== b.length || !timingSafeEqual(a, b)) throw new Error('token signature does not match');
  const payload = JSON.parse(Buffer.from(encoded, 'base64url').toString('utf8')) as TokenPayload;
  if (!payload.sub || !payload.role || !payload.exp) throw new Error('token payload is incomplete');
  if (payload.exp < Date.now()) throw new Error('token expired');
  return payload;
}

function gitEmail(): string | null {
  try {
    const email = execFileSync('git', ['config', 'user.email'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
    return email || null;
  } catch {
    return null;
  }
}

/**
 * Team mode is on when the environment carries the signing secret or the
 * repository declares it in `.lore.yml`. A declaring repository fails closed:
 * policy gates apply even if a teammate forgets to export LORE_TEAM_SECRET.
 */
export function teamMode(root = findWorkspaceRoot()): boolean {
  return Boolean(process.env.LORE_TEAM_SECRET) || declaresTeamMode(root);
}

/**
 * Identity resolution order:
 * 1. LORE_TOKEN signed with LORE_TEAM_SECRET (self-hosted teams).
 * 2. LORE_OIDC_EMAIL + LORE_OIDC_ROLE asserted by a trusted launcher (SSO wrapper).
 * 3. Local: git email or OS user, maintainer on a single-user machine.
 */
export function resolvePrincipal(root = findWorkspaceRoot()): Principal {
  const secret = process.env.LORE_TEAM_SECRET;
  const token = process.env.LORE_TOKEN;

  if (token) {
    if (!secret) throw new Error('LORE_TOKEN is set but LORE_TEAM_SECRET is missing; cannot verify it');
    const payload = verifyToken(token, secret);
    return { id: payload.sub, role: payload.role, source: 'token', jti: payload.jti };
  }

  const asserted = process.env.LORE_OIDC_EMAIL;
  if (asserted) {
    const role: Role = process.env.LORE_OIDC_ROLE === 'maintainer' ? 'maintainer' : 'contributor';
    return { id: asserted, role, source: 'assertion' };
  }

  if (declaresTeamMode(root) && !secret) {
    throw new Error(
      '.lore.yml declares team_mode but LORE_TEAM_SECRET is missing; set LORE_TEAM_SECRET and LORE_TOKEN (or LORE_OIDC_EMAIL) before writing',
    );
  }

  if (process.env.LORE_MACHINE === '1') {
    // A local machine principal is accepted only with the team signing secret,
    // which is checked above for a declaring repository. A machine token is the
    // per-host alternative for teams that do not export the shared secret.
    return { id: 'machine:local', role: 'machine', source: 'local' };
  }

  if (teamMode(root)) {
    throw new Error(
      'team mode is enabled (LORE_TEAM_SECRET) but no identity is present; set LORE_TOKEN or LORE_OIDC_EMAIL',
    );
  }

  return {
    id: gitEmail() ?? os.userInfo().username,
    role: 'maintainer',
    source: 'local',
  };
}
