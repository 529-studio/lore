import pc from 'picocolors';
import { findStateRoot, requireRoot } from '../db.js';
import { issueToken, resolvePrincipal, teamMode, type Role } from '../identity.js';
import { describePolicy, isTokenRevoked, listRevocations, requireAction, revokeToken } from '../policy.js';

export interface IdentityOptions {
  action?: string;
  target?: string;
  user?: string;
  role?: string;
  days?: string;
  jti?: string;
  reason?: string;
  json?: boolean;
}

export function identityCommand(opts: IdentityOptions): void {
  if (opts.action === 'issue') {
    const secret = process.env.LORE_TEAM_SECRET;
    if (!secret) throw new Error('set LORE_TEAM_SECRET before issuing a token');
    if (!opts.user) throw new Error('identity issue requires --user <email>');
    // Holders of the signing secret can bootstrap the first token. Once a
    // caller presents an identity, issuing another role is an admin action.
    const authenticated = Boolean(
      process.env.LORE_TOKEN || process.env.LORE_OIDC_EMAIL || process.env.LORE_MACHINE === '1',
    );
    const stateRoot = findStateRoot();
    if (stateRoot && authenticated) requireAction(stateRoot, 'admin');
    const role: Role = opts.role === 'contributor' ? 'contributor' : 'maintainer';
    const token = issueToken(opts.user, role, secret, Number(opts.days ?? 30), opts.jti);
    console.log(token);
    return;
  }

  if (opts.action === 'revoke') {
    const root = requireRoot();
    const target = opts.target ?? opts.user;
    if (!target) throw new Error('identity revoke requires a token, JTI, or user email');
    const admin = requireAction(root, 'admin');
    const record = revokeToken(root, target, {
      reason: opts.reason ?? 'administrative revocation',
      revokedBy: admin.id,
    });
    if (opts.json) {
      console.log(JSON.stringify(record, null, 2));
    } else {
      console.log(`[OK] revoked token ${pc.bold(record.jti)} (${record.sub}): ${record.reason}`);
    }
    return;
  }

  if (opts.action === 'revoked' || opts.action === 'list-revoked') {
    const root = requireRoot();
    const revocations = listRevocations(root);
    if (opts.json) {
      console.log(JSON.stringify(revocations, null, 2));
      return;
    }
    if (revocations.length === 0) {
      console.log('no revoked tokens');
      return;
    }
    console.log(`${revocations.length} revoked token(s):`);
    for (const r of revocations) {
      console.log(`  ${pc.bold(r.jti)}  ${r.sub}  ${pc.dim(r.revoked_at)}  by ${r.revoked_by}  (${r.reason ?? 'no reason'})`);
    }
    return;
  }

  const root = findStateRoot() ?? process.cwd();
  const principal = resolvePrincipal();
  let statusText = pc.green('active');

  if (principal.source === 'token') {
    const check = isTokenRevoked(root, { jti: principal.jti, sub: principal.id });
    if (check.revoked) {
      statusText = pc.red(`revoked (${check.record?.reason ?? 'revoked'})`);
    }
  }

  if (opts.json) {
    console.log(JSON.stringify({
      id: principal.id,
      role: principal.role,
      source: principal.source,
      jti: principal.jti ?? null,
      status: statusText.includes('revoked') ? 'revoked' : 'active',
      teamMode: teamMode(),
    }, null, 2));
    return;
  }

  console.log(`identity   ${pc.bold(principal.id)} ${pc.dim(`(${principal.role}, ${principal.source}${principal.jti ? `, jti: ${principal.jti}` : ''})`)}`);
  console.log(`status     ${statusText}`);
  console.log(`team mode  ${teamMode() ? pc.yellow('on') : pc.green('off')}`);
  console.log(`policy     ${describePolicy(root)}`);
  if (!teamMode()) {
    console.log(pc.dim('  enable team mode with LORE_TEAM_SECRET, then issue tokens per person'));
  }
}
