// The gap records' statements (schema/creator.sql's follow_gap): for each gap
// of a class a pass has made a creation for, when that first creation was
// made and when the gap was last attempted through the hint for the primary's
// region. creator-gaps.ts decides what a record makes due.
import { parseColo, type Colo } from "./colo";
import {
  CreatorStoreError,
  field,
  integerField,
  returnedRows,
  type SqlDatabase,
  type SqlStatement,
} from "./creator-store";
import { HOLDS_PASS_LEASE } from "./pass-lease";

// Every statement this module runs, for the store's query-plan test beside
// CREATOR_SQL's. The table holds at most a row per class and colo, so a full
// read is a handful of rows. Each write carries the lease guard, so a pass
// that lost its lease cannot put back a record the next pass deleted.
export const GAP_SQL = {
  readGaps:
    "SELECT class_code, colo, kind, begun_at_ms, attempted_at_ms FROM follow_gap ORDER BY class_code, colo",
  writeGap: `INSERT INTO follow_gap (class_code, colo, kind, begun_at_ms, attempted_at_ms) SELECT ?, ?, ?, ?, ? WHERE ${HOLDS_PASS_LEASE} ON CONFLICT (class_code, colo) DO UPDATE SET kind = excluded.kind, begun_at_ms = excluded.begun_at_ms, attempted_at_ms = excluded.attempted_at_ms RETURNING class_code`,
  deleteGap: `DELETE FROM follow_gap WHERE class_code = ? AND colo = ? AND ${HOLDS_PASS_LEASE}`,
  // Read in the delete's own batch, so it answers for the same moment.
  holdsLease: `SELECT 1 AS held WHERE ${HOLDS_PASS_LEASE}`,
} as const;

// What a class lacks in a colo: its slot there, or, with its slot there, the
// spares it keeps beside the primary.
export type GapKind = "slot" | "spares";

const GAP_KIND_CODE: Readonly<Record<GapKind, number>> = { slot: 1, spares: 2 };

export interface GapRecord {
  readonly classCode: number;
  readonly colo: Colo;
  readonly kind: GapKind;
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
    const code = integerField(row, "kind");
    const kind = (Object.keys(GAP_KIND_CODE) as GapKind[]).find(
      (k) => GAP_KIND_CODE[k] === code,
    );
    if (kind === undefined) {
      throw new CreatorStoreError(`kind is not a gap kind: ${String(code)}`);
    }
    return {
      classCode: integerField(row, "class_code"),
      colo,
      kind,
      begunAtMs: integerField(row, "begun_at_ms"),
      attemptedAtMs:
        attempted === null ? null : integerField(row, "attempted_at_ms"),
    };
  });
}

// The statements that write `records`, each guarded on `holder` holding the
// pass lease, then the lease check `leaseHeldIn` reads: for a batch another
// store commits, such as a creation's intent (beginCreation), so the records
// commit with it or not at all. Empty with no record.
export function gapWriteStatements(
  db: SqlDatabase,
  records: readonly GapRecord[],
  holder: string,
): SqlStatement[] {
  if (records.length === 0) return [];
  return [
    ...records.map((record) =>
      db
        .prepare(GAP_SQL.writeGap)
        .bind(
          record.classCode,
          record.colo,
          GAP_KIND_CODE[record.kind],
          record.begunAtMs,
          record.attemptedAtMs,
          holder,
        ),
    ),
    db.prepare(GAP_SQL.holdsLease).bind(holder),
  ];
}

// As gapWriteStatements, for the delete of a gap's record: for the batch
// that registers the slot or spare which fills the gap.
export function gapDeleteStatements(
  db: SqlDatabase,
  gap: { readonly classCode: number; readonly colo: Colo },
  holder: string,
): SqlStatement[] {
  return [
    db.prepare(GAP_SQL.deleteGap).bind(gap.classCode, gap.colo, holder),
    db.prepare(GAP_SQL.holdsLease).bind(holder),
  ];
}

// Whether the pass still held its lease when a batch carrying statements
// from gapWriteStatements or gapDeleteStatements committed, read from those
// statements' results; true when there were none.
export function leaseHeldIn(results: readonly unknown[]): boolean {
  if (results.length === 0) return true;
  return (
    returnedRows(results[results.length - 1], "gap lease check").length > 0
  );
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
      GAP_KIND_CODE[record.kind],
      record.begunAtMs,
      record.attemptedAtMs,
      holder,
    )
    .all();
  return results.length > 0;
}

// Deletes a gap's record while `holder` holds the pass lease; false when it
// does not, and the record is left to the pass that holds it. A record already
// gone reads as deleted.
export async function deleteGap(
  db: SqlDatabase,
  gap: { readonly classCode: number; readonly colo: Colo },
  holder: string,
): Promise<boolean> {
  const results = await db.batch([
    db.prepare(GAP_SQL.deleteGap).bind(gap.classCode, gap.colo, holder),
    db.prepare(GAP_SQL.holdsLease).bind(holder),
  ]);
  return returnedRows(results[1], "gap delete's lease check").length > 0;
}
