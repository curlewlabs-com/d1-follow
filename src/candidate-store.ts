// What the creator has learned about where Cloudflare places its objects
// (schema/creator.sql's follow_colo and follow_region_hint): the colos it keeps
// a slot of each class in, and the region hints it probes through beyond the
// app's own. Nothing else in the creator database reads or writes either
// table; adding a colo also deletes every hint's wait (hint-wait-store.ts), in
// the same batch.
import { parseColo, type Colo } from "./colo";
import {
  CreatorStoreError,
  field,
  returnedRows,
  stringField,
  type SqlDatabase,
} from "./creator-store";
import { HINT_WAIT_SQL } from "./hint-wait-store";
import { HOLDS_PASS_LEASE } from "./pass-lease";

// Every statement this module runs, for the store's query-plan test beside
// CREATOR_SQL's. Each table holds a row per colo or hint Cloudflare places
// objects in, so a full read is a handful of rows.
export const CANDIDATE_SQL = {
  readColos: "SELECT colo FROM follow_colo ORDER BY added_at_ms, colo",
  addColo: `INSERT INTO follow_colo (colo, added_at_ms) SELECT ?, ? WHERE ${HOLDS_PASS_LEASE} ON CONFLICT (colo) DO NOTHING`,
  readRegionHints:
    "SELECT region_hint FROM follow_region_hint ORDER BY added_at_ms, region_hint",
  addRegionHint:
    "INSERT INTO follow_region_hint (region_hint, added_at_ms) VALUES (?, ?) ON CONFLICT (region_hint) DO NOTHING",
} as const;

// The candidate colos, in the order they joined.
export async function readCandidateColos(db: SqlDatabase): Promise<Colo[]> {
  const { results } = await db.prepare(CANDIDATE_SQL.readColos).all();
  return results.map((row) => {
    const colo = parseColo(field(row, "colo"));
    if (colo === null) {
      throw new CreatorStoreError(
        `colo is not a colo: ${String(field(row, "colo"))}`,
      );
    }
    return colo;
  });
}

// Adds a candidate colo while `holder` holds the pass lease, and in the same
// batch deletes every hint's wait: a colo nobody knew Cloudflare places objects
// in says the hints have more to teach. Adding one already there changes
// nothing but the waits. False when `holder` does not hold the lease, and
// nothing was written: like every write of the pacing's state, it acts only
// for the pass that holds the lease.
export async function addCandidateColo(
  db: SqlDatabase,
  colo: Colo,
  atMs: number,
  holder: string,
): Promise<boolean> {
  const results = await db.batch([
    db.prepare(CANDIDATE_SQL.addColo).bind(colo, atMs, holder),
    db.prepare(HINT_WAIT_SQL.deleteEveryWait).bind(holder),
    db.prepare(HINT_WAIT_SQL.holdsLease).bind(holder),
  ]);
  return returnedRows(results[2], "colo add's lease check").length > 0;
}

// The hints added beyond the app's own, in the order they were added.
export async function readRegionHints(db: SqlDatabase): Promise<string[]> {
  const { results } = await db.prepare(CANDIDATE_SQL.readRegionHints).all();
  return results.map((row) => stringField(row, "region_hint"));
}

// Adds a region hint to probe through; as idempotent as addCandidateColo.
export async function addRegionHint(
  db: SqlDatabase,
  regionHint: string,
  atMs: number,
): Promise<void> {
  await db.prepare(CANDIDATE_SQL.addRegionHint).bind(regionHint, atMs).run();
}
