// The spare table's statements (schema/creator.sql's follow_spare). A spare is
// an object of a class kept beside its base slot in the primary's colo (README
// sec."Spare slots in a table of their own"), which a verified spare can
// become.
import {
  CREATOR_SQL,
  LEDGER_KIND,
  ledgerStatement,
  returnedRows,
  slotFromRow,
  type Slot,
  type SqlDatabase,
} from "./creator-store";
import { holdIdentity, releaseIdentity } from "./slot-identity";

// Every statement this module runs, beside the store's CREATOR_SQL, so the
// store's tests check each one's query plan the same way.
export const SPARE_SQL = {
  // The spares (schema/creator.sql's follow_spare), in the registry's own
  // order: registration time, then name.
  readSpares:
    "SELECT class_code, colo, name, object_id, registered_at_ms, verified_at_ms FROM follow_spare ORDER BY class_code, colo, registered_at_ms, name",
  insertSpare:
    "INSERT INTO follow_spare (class_code, colo, name, object_id, registered_at_ms, verified_at_ms) VALUES (?, ?, ?, ?, ?, ?)",
  recordFirstSpareVerification:
    "INSERT INTO follow_ledger (op_id, at_ms, kind, class_code, name, object_id, colo) SELECT ?, ?, ?, class_code, name, object_id, colo FROM follow_spare WHERE name = ? AND verified_at_ms IS NULL",
  stampSpareVerified:
    "UPDATE follow_spare SET verified_at_ms = max(ifnull(verified_at_ms, 0), ?) WHERE name = ?",
  // As the registry's unregister: each statement matches the spare only while
  // its verification is the one the pass decided on.
  recordSpareUnregistered:
    "INSERT INTO follow_ledger (op_id, at_ms, kind, class_code, name, object_id, colo, detail) SELECT ?, ?, ?, class_code, name, object_id, colo, ? FROM follow_spare WHERE name = ? AND verified_at_ms IS ?",
  holdSpareForRelease:
    "INSERT INTO follow_release_pending (name, class_code, object_id, unregistered_at_ms) SELECT name, class_code, object_id, ? FROM follow_spare WHERE name = ? AND verified_at_ms IS ?",
  deleteSpare:
    "DELETE FROM follow_spare WHERE name = ? AND verified_at_ms IS ? RETURNING name",
  // A spare becomes its colo's base slot: copied into follow_slot while still a
  // spare, with the ledger row taken from it, then removed from follow_spare.
  recordPromoted:
    "INSERT INTO follow_ledger (op_id, at_ms, kind, class_code, name, object_id, colo, detail) SELECT ?, ?, ?, class_code, name, object_id, colo, ? FROM follow_spare WHERE name = ? AND verified_at_ms IS NOT NULL",
  promoteSpare:
    "INSERT INTO follow_slot (class_code, colo, name, object_id, registered_at_ms, verified_at_ms) SELECT class_code, colo, name, object_id, registered_at_ms, verified_at_ms FROM follow_spare WHERE name = ? AND verified_at_ms IS NOT NULL",
  deletePromotedSpare:
    "DELETE FROM follow_spare WHERE name = ? AND verified_at_ms IS NOT NULL RETURNING name",
} as const;

// The spares, in registry order within each class and colo.
export async function readSpares(db: SqlDatabase): Promise<Slot[]> {
  const { results } = await db.prepare(SPARE_SQL.readSpares).all();
  return results.map(slotFromRow);
}

// Registers a spare with its identity and the ledger row that records why, in
// one batch: a name or object id another registered slot holds fails the
// batch whole, so no record claims it.
export async function registerSpare(
  db: SqlDatabase,
  spare: Slot,
  record: { readonly opId: string; readonly kind: "created" | "seeded" },
): Promise<void> {
  await db.batch([
    holdIdentity(db, spare),
    db
      .prepare(SPARE_SQL.insertSpare)
      .bind(
        spare.classCode,
        spare.colo,
        spare.name,
        spare.objectId,
        spare.registeredAtMs,
        spare.verifiedAtMs,
      ),
    ledgerStatement(db, {
      opId: record.opId,
      atMs: spare.registeredAtMs,
      kind: record.kind,
      classCode: spare.classCode,
      name: spare.name,
      objectId: spare.objectId,
      colo: spare.colo,
    }),
    ...(record.kind === "created"
      ? [db.prepare(CREATOR_SQL.closeIntent).bind(record.opId)]
      : []),
  ]);
}

// A spare's latest verification (creator-spares.ts decides what verifies one),
// recorded as stampVerified records a base slot's: only the first stamp writes
// a ledger row.
export async function stampSpareVerified(
  db: SqlDatabase,
  stamp: {
    readonly name: string;
    readonly opId: string;
    readonly atMs: number;
  },
): Promise<void> {
  await db.batch([
    db
      .prepare(SPARE_SQL.recordFirstSpareVerification)
      .bind(stamp.opId, stamp.atMs, LEDGER_KIND.verified, stamp.name),
    db.prepare(SPARE_SQL.stampSpareVerified).bind(stamp.atMs, stamp.name),
  ]);
}

// Takes a spare out of the spare table into the release queue, as
// unregisterSlot does a base slot, and true when it did.
export async function unregisterSpare(
  db: SqlDatabase,
  spare: Pick<Slot, "name" | "verifiedAtMs">,
  record: {
    readonly opId: string;
    readonly atMs: number;
    readonly detail: string;
  },
): Promise<boolean> {
  const results = await db.batch([
    db
      .prepare(SPARE_SQL.recordSpareUnregistered)
      .bind(
        record.opId,
        record.atMs,
        LEDGER_KIND.unregistered,
        record.detail,
        spare.name,
        spare.verifiedAtMs,
      ),
    db
      .prepare(SPARE_SQL.holdSpareForRelease)
      .bind(record.atMs, spare.name, spare.verifiedAtMs),
    releaseIdentity(db, "spare", spare),
    db.prepare(SPARE_SQL.deleteSpare).bind(spare.name, spare.verifiedAtMs),
  ]);
  return returnedRows(results[3], "spare unregister's delete").length > 0;
}

// Makes a verified spare its colo's base slot, in one batch with its ledger
// record (kind seeded: an object already placed, newly the registry's), so the
// colo keeps a base slot with no creation. Its identity stays as it is. True when it moved; false when the
// spare is gone or not verified, which moves nothing. The caller promotes only
// into a colo whose base slot has left the registry: follow_slot's key refuses
// a second base slot there, failing the batch whole.
export async function promoteSpare(
  db: SqlDatabase,
  name: string,
  record: { readonly opId: string; readonly atMs: number },
): Promise<boolean> {
  const results = await db.batch([
    db
      .prepare(SPARE_SQL.recordPromoted)
      .bind(
        record.opId,
        record.atMs,
        LEDGER_KIND.seeded,
        "promoted from spare",
        name,
      ),
    db.prepare(SPARE_SQL.promoteSpare).bind(name),
    db.prepare(SPARE_SQL.deletePromotedSpare).bind(name),
  ]);
  return returnedRows(results[2], "promotion's delete").length > 0;
}
