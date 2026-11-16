// What the creator has learned about where Cloudflare places its objects
// (schema/creator.sql's follow_colo and follow_region_hint): the colos it keeps
// a slot of each class in, and the region hints it probes through beyond the
// app's own. Nothing else in the creator database reads or writes either
// table.
import { parseColo, type Colo } from "./colo";
import {
  CreatorStoreError,
  field,
  stringField,
  type SqlDatabase,
} from "./creator-store";

// Every statement this module runs, for the store's query-plan test beside
// CREATOR_SQL's. Each table holds a row per colo or hint Cloudflare places
// objects in, so a full read is a handful of rows.
export const CANDIDATE_SQL = {
  readColos: "SELECT colo FROM follow_colo ORDER BY added_at_ms, colo",
  addColo:
    "INSERT INTO follow_colo (colo, added_at_ms) VALUES (?, ?) ON CONFLICT (colo) DO NOTHING",
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

// Adds a candidate colo; adding one already there changes nothing, so a pass
// that lost its lease writing one leaves nothing another pass relies on.
export async function addCandidateColo(
  db: SqlDatabase,
  colo: Colo,
  atMs: number,
): Promise<void> {
  await db.prepare(CANDIDATE_SQL.addColo).bind(colo, atMs).run();
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
