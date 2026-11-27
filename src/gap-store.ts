// The gap records' statements (schema/creator.sql's follow_gap): for each gap
// of a class a pass has made a creation for, when that first creation was
// made and when the gap was last attempted through the hint for the primary's
// region. creator-gaps.ts decides what a record makes due.
import { parseColo, type Colo } from "./colo";
import {
  CreatorStoreError,
  field,
  integerField,
  type SqlDatabase,
} from "./creator-store";
import { HOLDS_PASS_LEASE } from "./pass-lease";

// Every statement this module runs, for the store's query-plan test beside
// CREATOR_SQL's. The table holds at most a row per class and colo, so a full
// read is a handful of rows. Each write carries the lease guard, so a pass
// that lost its lease cannot put back a record the next pass deleted.
export const GAP_SQL = {
  readGaps:
    "SELECT class_code, colo, begun_at_ms, attempted_at_ms FROM follow_gap ORDER BY class_code, colo",
  writeGap: `INSERT INTO follow_gap (class_code, colo, begun_at_ms, attempted_at_ms) SELECT ?, ?, ?, ? WHERE ${HOLDS_PASS_LEASE} ON CONFLICT (class_code, colo) DO UPDATE SET begun_at_ms = excluded.begun_at_ms, attempted_at_ms = excluded.attempted_at_ms RETURNING class_code`,
  deleteGap: `DELETE FROM follow_gap WHERE class_code = ? AND colo = ? AND ${HOLDS_PASS_LEASE}`,
} as const;

export interface GapRecord {
  readonly classCode: number;
  readonly colo: Colo;
  readonly begunAtMs: number;
  // Null while no attempt through the primary's hint has been made since the
  // record began.
  readonly attemptedAtMs: number | null;
}

export async function readGaps(db: SqlDatabase): Promise<GapRecord[]> {
  const { results } = await db.prepare(GAP_SQL.readGaps).all();
  return results.map((row) => {
    const colo = parseColo(field(row, "colo"));
    if (colo === null) {
      throw new CreatorStoreError(
        `colo is not a colo: ${String(field(row, "colo"))}`,
      );
    }
    const attempted = field(row, "attempted_at_ms");
    return {
      classCode: integerField(row, "class_code"),
      colo,
      begunAtMs: integerField(row, "begun_at_ms"),
      attemptedAtMs:
        attempted === null ? null : integerField(row, "attempted_at_ms"),
    };
  });
}

// Writes a gap's record while `holder` holds the pass lease; false when it
// does not, and nothing was written.
export async function writeGap(
  db: SqlDatabase,
  record: GapRecord,
  holder: string,
): Promise<boolean> {
  const { results } = await db
    .prepare(GAP_SQL.writeGap)
    .bind(
      record.classCode,
      record.colo,
      record.begunAtMs,
      record.attemptedAtMs,
      holder,
    )
    .all();
  return results.length > 0;
}

// Deletes a gap's record while `holder` holds the pass lease. A pass that has
// lost the lease leaves the record to the pass that holds it, and learns of
// the loss when it next renews.
export async function deleteGap(
  db: SqlDatabase,
  gap: { readonly classCode: number; readonly colo: Colo },
  holder: string,
): Promise<void> {
  await db
    .prepare(GAP_SQL.deleteGap)
    .bind(gap.classCode, gap.colo, holder)
    .run();
}
