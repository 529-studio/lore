import { stateRootFor } from '../db.js';
import { registerClaimWriteHook } from '../model.js';
import { detectTier1Conflicts } from './conflicts.js';

export { detectTier1Conflicts, type Tier1Conflict } from './conflicts.js';

let installed = false;

/**
 * Attach Canon to the Lore write path. Core does not import canon; it calls the
 * hooks registered here. Idempotent, so every entry point can call it.
 */
export function installCanon(): void {
  if (installed) return;
  installed = true;
  registerClaimWriteHook((db, claimId) => {
    const root = stateRootFor(db);
    if (!root) return;
    detectTier1Conflicts(db, root, claimId);
  });
}
