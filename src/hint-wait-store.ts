// The region hints' waits (schema/creator.sql's follow_hint_wait): for each
// hint whose last round of probes taught nothing, how long it waits and when
// its next round is due. creator-hints.ts decides what a wait makes due; the
// batch that adds a candidate colo deletes every wait (candidate-store.ts).
import {
  integerField,
  returnedRows,
  stringField,
  type SqlDatabase,
} from "./creator-store";
import { HOLDS_PASS_LEASE } from "./pass-lease";

// Every statement this module runs, and the one candidate-store.ts runs in its
// own batch, for the store's query-plan test beside CREATOR_SQL's. The table
// holds at most a row per region hint, so a full read is a handful of rows.
// Each write carries the lease guard, so a pass that lost its lease cannot put
// back a wait the next pass deleted.
export const HINT_WAIT_SQL = {
  readWaits:
    "SELECT region_hint, wait_ms, due_at_ms FROM follow_hint_wait ORDER BY region_hint",
  writeWait: `INSERT INTO follow_hint_wait (region_hint, wait_ms, due_at_ms) SELECT ?, ?, ? WHERE ${HOLDS_PASS_LEASE} ON CONFLICT (region_hint) DO UPDATE SET wait_ms = excluded.wait_ms, due_at_ms = excluded.due_at_ms RETURNING region_hint`,
  deleteWait: `DELETE FROM follow_hint_wait WHERE region_hint = ? AND ${HOLDS_PASS_LEASE}`,
  deleteEveryWait: `DELETE FROM follow_hint_wait WHERE ${HOLDS_PASS_LEASE}`,
  // Read in a delete's own batch, so it answers for the same moment.
  holdsLease: `SELECT 1 AS held WHERE ${HOLDS_PASS_LEASE}`,
} as const;

export interface HintWait {
  readonly regionHint: string;
  readonly waitMs: number;
  // The start of the pass that set the wait, plus the wait.
  readonly dueAtMs: number;
}

export async function readHintWaits(db: SqlDatabase): Promise<HintWait[]> {
  const { results } = await db.prepare(HINT_WAIT_SQL.readWaits).all();
  return results.map((row) => ({
    regionHint: stringField(row, "region_hint"),
    waitMs: integerField(row, "wait_ms"),
    dueAtMs: integerField(row, "due_at_ms"),
  }));
}

// Writes a hint's wait while `holder` holds the pass lease; false when it does
// not, and nothing was written.
export async function writeHintWait(
  db: SqlDatabase,
  wait: HintWait,
  holder: string,
): Promise<boolean> {
  const { results } = await db
    .prepare(HINT_WAIT_SQL.writeWait)
    .bind(wait.regionHint, wait.waitMs, wait.dueAtMs, holder)
    .all();
  return results.length > 0;
}

// Deletes a hint's wait while `holder` holds the pass lease; false when it does
// not, and the wait is left to the pass that holds it. A wait already gone
// reads as deleted.
export async function deleteHintWait(
  db: SqlDatabase,
  regionHint: string,
  holder: string,
): Promise<boolean> {
  const results = await db.batch([
    db.prepare(HINT_WAIT_SQL.deleteWait).bind(regionHint, holder),
    db.prepare(HINT_WAIT_SQL.holdsLease).bind(holder),
  ]);
  return returnedRows(results[1], "hint wait delete's lease check").length > 0;
}
