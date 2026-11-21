// A registered slot's identity, across the base slots and the spares
// (schema/creator.sql's follow_slot_name): its name and its object id, each
// held by one registered slot at a time. A registration's batch writes the
// identity first, so a name or id already held fails the batch whole; an
// unregistration's batch removes it under the same condition its slot row is
// removed by.
import {
  CreatorStoreError,
  integerField,
  type SqlDatabase,
  type SqlStatement,
} from "./creator-store";

const registeredByName =
  "SELECT class_code FROM (SELECT name, class_code FROM follow_slot UNION ALL SELECT name, class_code FROM follow_spare) WHERE name = ?1";

// Every statement this module runs, so the store's tests check each one's
// query plan beside the rest.
export const SLOT_IDENTITY_SQL = {
  // Each arm searches its table's name index: SQLite pushes the outer
  // predicate into a UNION ALL subquery.
  readRegisteredClass: registeredByName,
  // Unregistration moves the name to the release queue in a transaction.
  // Read either side in the same snapshot so an outstanding hold stays visible.
  readPlacementClaim: `SELECT class_code, NULL AS unregistered_at_ms FROM (${registeredByName})
    UNION ALL SELECT class_code, unregistered_at_ms FROM follow_release_pending WHERE name = ?1`,
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

// Reports current registration only. A removed registration can still have a
// release hold; a mutation receiver needs readPlacementClaim.
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

export type PlacementClaim =
  | { readonly kind: "registered"; readonly classCode: number }
  | {
      readonly kind: "pending_release";
      readonly classCode: number;
      readonly unregisteredAtMs: number;
    };

// A pending name is still owned by the releaser. The timestamp lets cleanup
// honor the scheduled hold. A missing row is a snapshot, not a reservation.
export async function readPlacementClaim(
  db: SqlDatabase,
  name: string,
): Promise<PlacementClaim | null> {
  const { results } = await db
    .prepare(SLOT_IDENTITY_SQL.readPlacementClaim)
    .bind(name)
    .all();
  const [row] = results;
  if (row === undefined) return null;
  if (results.length !== 1)
    throw new CreatorStoreError("conflicting placement claims for " + name);
  const classCode = integerField(row, "class_code");
  if ((row as Record<string, unknown>)["unregistered_at_ms"] === null)
    return { kind: "registered", classCode };
  return {
    kind: "pending_release",
    classCode,
    unregisteredAtMs: integerField(row, "unregistered_at_ms"),
  };
}
