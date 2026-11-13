import { stateRootFor } from '../db.js';
import { registerClaimEligibilityHook, registerClaimWriteHook } from '../model.js';
import { detectTier1Conflicts } from './conflicts.js';
import { evaluateDecay } from './decay.js';

export { detectTier1Conflicts, type Tier1Conflict } from './conflicts.js';
export { evaluateDecay, markDecay, restoreAfterReverify, sweepDecay, type DecayResult, type DecayTrigger } from './decay.js';

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
  registerClaimEligibilityHook((db, claim) => {
    const root = stateRootFor(db);
    if (!root) return true;
    return evaluateDecay(db, root, claim, { checkHash: false }) === null;
  });
}
