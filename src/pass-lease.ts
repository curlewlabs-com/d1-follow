// The creator pass's lease (schema/creator.sql's follow_pass): one row naming
// the pass that holds it and until when, so invocations that overlap never fill
// the same gap twice. It owns that table alone, the condition other writes
// guard on included, and runs over the store's statement handle
// (creator-store.ts's SqlDatabase).
import type { SqlDatabase } from "./creator-store";

// True while the pass bound to its one parameter, the lease's holder, still
// holds the lease. A write that a pass which lost its lease must not make
// carries it in its own statement, so a pass that stalled cannot put back
// state the pass now holding the lease changed.
export const HOLDS_PASS_LEASE =
  "EXISTS (SELECT 1 FROM follow_pass WHERE id = 1 AND holder = ?)";

const PASS_LEASE_SQL = {
  // Takes the lease only when no claim stands; RETURNING is empty otherwise.
  claimPass:
    "INSERT INTO follow_pass (id, holder, claimed_until_ms) VALUES (1, ?, ?) ON CONFLICT (id) DO UPDATE SET holder = excluded.holder, claimed_until_ms = excluded.claimed_until_ms WHERE follow_pass.claimed_until_ms <= ? RETURNING holder",
  // Extends the lease only for the pass that still holds it.
  renewPass:
    "UPDATE follow_pass SET claimed_until_ms = ? WHERE id = 1 AND holder = ? RETURNING holder",
  releasePass:
    "UPDATE follow_pass SET claimed_until_ms = ? WHERE id = 1 AND holder = ?",
} as const;

// Claims the creator's pass lease for `holder` until `nowMs + leaseMs`, unless
// another claim stands; true when this pass holds it.
export async function claimPass(
  db: SqlDatabase,
  claim: {
    readonly holder: string;
    readonly nowMs: number;
    readonly leaseMs: number;
  },
): Promise<boolean> {
  const { results } = await db
    .prepare(PASS_LEASE_SQL.claimPass)
    .bind(claim.holder, claim.nowMs + claim.leaseMs, claim.nowMs)
    .all();
  return results.length > 0;
}

// Extends `holder`'s lease to `untilMs`; false when another pass has taken it.
export async function renewPass(
  db: SqlDatabase,
  renewal: { readonly holder: string; readonly untilMs: number },
): Promise<boolean> {
  const { results } = await db
    .prepare(PASS_LEASE_SQL.renewPass)
    .bind(renewal.untilMs, renewal.holder)
    .all();
  return results.length > 0;
}

// Gives the lease up at `nowMs`, if `holder` still holds it.
export async function releasePass(
  db: SqlDatabase,
  release: { readonly holder: string; readonly nowMs: number },
): Promise<void> {
  await db
    .prepare(PASS_LEASE_SQL.releasePass)
    .bind(release.nowMs, release.holder)
    .run();
}
