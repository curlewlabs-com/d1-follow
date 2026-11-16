// A registered slot's identity, across the base slots and the spares
// (schema/creator.sql's follow_slot_name): its name and its object id, each
// held by one registered slot at a time. A registration's batch writes the
// identity first, so a name or id already held fails the batch whole; an
// unregistration's batch removes it under the same condition its slot row is
// removed by.
import {
  integerField,
  type SqlDatabase,
  type SqlStatement,
} from "./creator-store";

// Every statement this module runs, so the store's tests check each one's
// query plan beside the rest.
export const SLOT_IDENTITY_SQL = {
  // Each arm searches its table's name index: SQLite pushes the outer
  // predicate into a UNION ALL subquery.
  readRegisteredClass:
    "SELECT class_code FROM (SELECT name, class_code FROM follow_slot UNION ALL SELECT name, class_code FROM follow_spare) WHERE name = ?",
  holdIdentity: "INSERT INTO follow_slot_name (name, object_id) VALUES (?, ?)",
  releaseBaseIdentity:
    "DELETE FROM follow_slot_name WHERE name = ? AND EXISTS (SELECT 1 FROM follow_slot WHERE follow_slot.name = follow_slot_name.name AND verified_at_ms IS ?)",
  releaseSpareIdentity:
    "DELETE FROM follow_slot_name WHERE name = ? AND EXISTS (SELECT 1 FROM follow_spare WHERE follow_spare.name = follow_slot_name.name AND verified_at_ms IS ?)",
} as const;

export function holdIdentity(
  db: SqlDatabase,
  slot: { readonly name: string; readonly objectId: string },
): SqlStatement {
  return db
    .prepare(SLOT_IDENTITY_SQL.holdIdentity)
    .bind(slot.name, slot.objectId);
}

// Placed ahead of the delete it pairs with, while the slot row it checks is
// still there.
export function releaseIdentity(
  db: SqlDatabase,
  table: "base" | "spare",
  slot: { readonly name: string; readonly verifiedAtMs: number | null },
): SqlStatement {
  return db
    .prepare(
      table === "base"
        ? SLOT_IDENTITY_SQL.releaseBaseIdentity
        : SLOT_IDENTITY_SQL.releaseSpareIdentity,
    )
    .bind(slot.name, slot.verifiedAtMs);
}

// The class a registered slot, base slot or spare, holds `name` under, or null
// when none does. An app's placement method refuses a registered name: placing
// or releasing a slot from outside the creator would take it from its colo
// while the creator still holds it ready, and the creator unregisters a slot
// before releasing it.
export async function registeredClassOf(
  db: SqlDatabase,
  name: string,
): Promise<number | null> {
  const { results } = await db
    .prepare(SLOT_IDENTITY_SQL.readRegisteredClass)
    .bind(name)
    .all();
  const [row] = results;
  return row === undefined ? null : integerField(row, "class_code");
}
