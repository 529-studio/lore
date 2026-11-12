import pc from 'picocolors';
import { findStateRoot } from '../db.js';
import { issueToken, resolvePrincipal, teamMode, type Role } from '../identity.js';
import { describePolicy } from '../policy.js';

export interface IdentityOptions {
  action?: string;
  user?: string;
  role?: string;
  days?: string;
}

export function identityCommand(opts: IdentityOptions): void {
  if (opts.action === 'issue') {
    const secret = process.env.LORE_TEAM_SECRET;
    if (!secret) throw new Error('set LORE_TEAM_SECRET before issuing a token');
    if (!opts.user) throw new Error('identity issue requires --user <email>');
    const role: Role = opts.role === 'contributor' ? 'contributor' : 'maintainer';
    const token = issueToken(opts.user, role, secret, Number(opts.days ?? 30));
    console.log(token);
    return;
  }

  const principal = resolvePrincipal();
  const root = findStateRoot() ?? process.cwd();
  console.log(`identity   ${pc.bold(principal.id)} ${pc.dim(`(${principal.role}, ${principal.source})`)}`);
  console.log(`team mode  ${teamMode() ? pc.yellow('on') : pc.green('off')}`);
  console.log(`policy     ${describePolicy(root)}`);
  if (!teamMode()) {
    console.log(pc.dim('  enable team mode with LORE_TEAM_SECRET, then issue tokens per person'));
  }
}
