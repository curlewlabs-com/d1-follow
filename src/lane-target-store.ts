// Where a lane can hand off to: slots looked up across the registry and the
// spare table together (schema/creator.sql's follow_slot and follow_spare).
//
// A lane reads the spares as well as the base slots because the object it must
// leave can be the colo's base slot: an object Cloudflare moved keeps its row
// until the creator's next pass (README sec."Spare slots in a table of their
// own"). A handoff goes ahead only while its target is verified
// (Slot.verifiedAtMs), which the caller judges.
import type { Colo } from "./colo";
import { slotFromRow, type Slot, type SqlDatabase } from "./creator-store";

// Every statement this module runs, so the store's tests check each one's
// query plan the same way as the store's own.
export const LANE_TARGET_SQL = {
  readSlotsIn:
    "SELECT class_code, colo, name, object_id, registered_at_ms, verified_at_ms FROM (SELECT class_code, colo, name, object_id, registered_at_ms, verified_at_ms, 0 AS spare FROM follow_slot UNION ALL SELECT class_code, colo, name, object_id, registered_at_ms, verified_at_ms, 1 FROM follow_spare) WHERE class_code = ? AND colo = ? ORDER BY spare, registered_at_ms, name",
  // A name is held once across the tables (follow_slot_name), so this answers
  // at most one row.
  readSlotNamed:
    "SELECT class_code, colo, name, object_id, registered_at_ms, verified_at_ms FROM (SELECT class_code, colo, name, object_id, registered_at_ms, verified_at_ms FROM follow_slot UNION ALL SELECT class_code, colo, name, object_id, registered_at_ms, verified_at_ms FROM follow_spare) WHERE name = ?",
} as const;

// A class's slots in one colo, the base slot before its spares.
export async function readSlotsIn(
  db: SqlDatabase,
  classCode: number,
  colo: Colo,
): Promise<Slot[]> {
  const { results } = await db
    .prepare(LANE_TARGET_SQL.readSlotsIn)
    .bind(classCode, colo)
    .all();
  return results.map(slotFromRow);
}

// The slot `name` holds, base or spare, or null when it holds none: where an
// operator hands a lane to.
export async function readSlotNamed(
  db: SqlDatabase,
  name: string,
): Promise<Slot | null> {
  const { results } = await db
    .prepare(LANE_TARGET_SQL.readSlotNamed)
    .bind(name)
    .all();
  const [row] = results;
  return row === undefined ? null : slotFromRow(row);
}
