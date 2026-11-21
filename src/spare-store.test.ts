// The spare table's statements (schema/creator.sql's follow_spare), run against
// real SQLite with the schema applied, as creator-store.test.ts runs the
// registry's. These own the spares' rows and the identity a base slot and a
// spare share (follow_slot_name); the base registry's own behavior is
// creator-store.test.ts's.
import { Database } from "bun:sqlite";
import { beforeEach, describe, expect, test } from "bun:test";
import type { Colo } from "./colo";
import { sqliteHandle } from "./sqlite-test-handle";
import {
  beginCreation,
  readOpenIntents,
  readReleasePending,
  readSlots,
  registerSlot,
  stampVerified,
  unregisterSlot,
  type SqlDatabase,
} from "./creator-store";
import {
  promoteSpare,
  readSpares,
  registerSpare,
  stampSpareVerified,
  unregisterSpare,
} from "./spare-store";
import {
  readPlacementClaim,
  registeredClassOf,
  SLOT_IDENTITY_SQL,
} from "./slot-identity";

const ORD = "ORD" as Colo;
const MIA = "MIA" as Colo;
const AT_MS = Date.UTC(2026, 9, 5, 23, 0, 0);
// The id a test's namespace computes from a name, as the slot helper's.
const idOf = (name: string): string => `id-${name}`;
const STATELESS_CLASS = 1;

let schema: string;
let sqlite: Database;
let db: SqlDatabase;

beforeEach(async () => {
  schema = await Bun.file(
    new URL("../schema/creator.sql", import.meta.url),
  ).text();
  sqlite = new Database(":memory:");
  sqlite.run(schema);
  db = sqliteHandle(sqlite);
});

function ledger(): Record<string, unknown>[] {
  return sqlite
    .query(
      "SELECT op_id, at_ms, kind, class_code, name, object_id, colo, lane_code, lane_seq, from_name, changed_by, mode, detail FROM follow_ledger ORDER BY id",
    )
    .all() as Record<string, unknown>[];
}

function identities(): [unknown, unknown][] {
  return sqlite
    .query("SELECT name, object_id FROM follow_slot_name ORDER BY name")
    .values() as [unknown, unknown][];
}

function slot(classCode: number, colo: Colo, name: string) {
  return {
    classCode,
    colo,
    name,
    objectId: `id-${name}`,
    registeredAtMs: AT_MS,
    verifiedAtMs: null,
  };
}

describe("the spares", () => {
  test("a registered spare reads back with its record, in registry order", async () => {
    await registerSpare(
      db,
      { ...slot(STATELESS_CLASS, ORD, "spare-02"), registeredAtMs: AT_MS + 1 },
      {
        opId: "b",
        kind: "created",
      },
    );
    await registerSpare(db, slot(STATELESS_CLASS, ORD, "spare-01"), {
      opId: "a",
      kind: "created",
    });
    expect((await readSpares(db)).map((s) => s.name)).toEqual([
      "spare-01",
      "spare-02",
    ]);
    expect(await readSlots(db)).toEqual([]);
    expect(
      ledger().map((row) => [row["op_id"], row["kind"], row["name"]]),
    ).toEqual([
      ["b", 2, "spare-02"],
      ["a", 2, "spare-01"],
    ]);
  });

  // A name or object id is held by one registered slot, base or spare: one in
  // the registry and the spare table at once would be observed and released
  // twice, and a reader of either table could act on it as the other kind. The
  // refusal fails the batch whole, so no record claims the slot the tables do
  // not hold.
  test.each([
    ["a spare under a base slot's name", "base", { name: "dup" }],
    ["a base slot under a spare's name", "spare", { name: "dup" }],
    ["a spare under a base slot's object id", "base", { objectId: "id-dup" }],
    ["a base slot under a spare's object id", "spare", { objectId: "id-dup" }],
  ] as const)("%s is refused with no record", async (_, held, clash) => {
    const first = { ...slot(STATELESS_CLASS, ORD, "dup"), objectId: "id-dup" };
    const second = {
      ...slot(STATELESS_CLASS, MIA, "other"),
      objectId: "id-other",
      ...clash,
    };
    const record = (opId: string) => ({ opId, kind: "created" as const });
    if (held === "base") {
      await registerSlot(db, first, record("a"));
      await expect(registerSpare(db, second, record("b"))).rejects.toThrow(
        "UNIQUE constraint failed: follow_slot_name",
      );
    } else {
      await registerSpare(db, first, record("a"));
      await expect(registerSlot(db, second, record("b"))).rejects.toThrow(
        "UNIQUE constraint failed: follow_slot_name",
      );
    }
    expect(ledger().map((row) => row["op_id"])).toEqual(["a"]);
    expect(identities()).toEqual([["dup", "id-dup"]]);
  });

  // An unregistration gives its name and id back, so the identity table holds
  // only what the slot tables do.
  test("unregistering a base slot or a spare releases its identity", async () => {
    await registerSlot(db, slot(STATELESS_CLASS, MIA, "slot-01"), {
      opId: "a",
      kind: "created",
    });
    await registerSpare(db, slot(STATELESS_CLASS, ORD, "spare-01"), {
      opId: "b",
      kind: "created",
    });
    const reason = { atMs: AT_MS + 5, detail: "the primary moved" };
    await unregisterSlot(
      db,
      { name: "slot-01", verifiedAtMs: null },
      { opId: "u1", ...reason },
    );
    await unregisterSpare(
      db,
      { name: "spare-01", verifiedAtMs: null },
      { opId: "u2", ...reason },
    );
    expect(identities()).toEqual([]);
  });

  // The unregister matches on the verification the pass decided on; when the
  // slot was verified since, it stays registered and keeps its identity. An
  // unverified spare beside it gives the match a row it must not take for this
  // one's.
  test("an unregister that matches nothing keeps the identity", async () => {
    await registerSpare(db, slot(STATELESS_CLASS, ORD, "spare-01"), {
      opId: "a",
      kind: "created",
    });
    await registerSpare(db, slot(STATELESS_CLASS, ORD, "spare-02"), {
      opId: "b",
      kind: "created",
    });
    await stampSpareVerified(db, {
      name: "spare-01",
      colo: ORD,
      opId: "v",
      atMs: AT_MS + 10,
    });
    expect(
      await unregisterSpare(
        db,
        { name: "spare-01", verifiedAtMs: null },
        { opId: "u", atMs: AT_MS + 20, detail: "the primary moved" },
      ),
    ).toBe(false);
    expect(identities()).toEqual([
      ["spare-01", "id-spare-01"],
      ["spare-02", "id-spare-02"],
    ]);
  });

  // The identity is written first in a registration's batch, so a later
  // statement that fails must take it back with the rest: an identity left
  // behind would hold its name and object id against every later registration.
  test("a base registration refused after its identity leaves none", async () => {
    await registerSlot(db, slot(STATELESS_CLASS, ORD, "slot-01"), {
      opId: "a",
      kind: "created",
    });
    await expect(
      registerSlot(db, slot(STATELESS_CLASS, ORD, "slot-02"), {
        opId: "b",
        kind: "created",
      }),
    ).rejects.toThrow("UNIQUE constraint failed: follow_slot.class_code");
    expect((await readSlots(db)).map((s) => s.name)).toEqual(["slot-01"]);
    expect(ledger().map((row) => row["op_id"])).toEqual(["a"]);
    expect(identities()).toEqual([["slot-01", "id-slot-01"]]);
  });

  test("a spare registration refused after its identity leaves none", async () => {
    await expect(
      registerSpare(db, slot(0, ORD, "spare-01"), {
        opId: "a",
        kind: "created",
      }),
    ).rejects.toThrow("CHECK constraint failed");
    expect(await readSpares(db)).toEqual([]);
    expect(ledger()).toEqual([]);
    expect(identities()).toEqual([]);
  });

  // The codec refuses to place or release a registered name, and a spare is
  // held ready as a base slot is: a placement call on it would empty it while
  // the creator still counts on it. Its class reads back through registration,
  // promotion, and until it is unregistered.
  test("a spare's name reads as registered under its class until it leaves", async () => {
    await registerSpare(db, slot(STATELESS_CLASS, ORD, "spare-01"), {
      opId: "a",
      kind: "created",
    });
    await registerSpare(db, slot(STATELESS_CLASS, ORD, "spare-02"), {
      opId: "b",
      kind: "created",
    });
    expect(await registeredClassOf(db, "spare-01")).toBe(STATELESS_CLASS);
    expect(await registeredClassOf(db, "spare-03")).toBeNull();
    expect(await readPlacementClaim(db, "spare-03")).toBeNull();
    expect(await readPlacementClaim(db, "spare-02")).toEqual({
      kind: "registered",
      classCode: STATELESS_CLASS,
    });

    await stampSpareVerified(db, {
      name: "spare-01",
      colo: ORD,
      opId: "v",
      atMs: AT_MS,
    });
    await promoteSpare(db, "spare-01", { opId: "p", atMs: AT_MS + 1 });
    expect(await registeredClassOf(db, "spare-01")).toBe(STATELESS_CLASS);

    await unregisterSpare(
      db,
      { name: "spare-02", verifiedAtMs: null },
      { opId: "u", atMs: AT_MS + 2, detail: "the primary moved" },
    );
    expect(await registeredClassOf(db, "spare-02")).toBeNull();
    expect(await readPlacementClaim(db, "spare-01")).toEqual({
      kind: "registered",
      classCode: STATELESS_CLASS,
    });
    expect(await readPlacementClaim(db, "spare-02")).toEqual({
      kind: "pending_release",
      classCode: STATELESS_CLASS,
      unregisteredAtMs: AT_MS + 2,
    });
  });

  // A reseed can register a name whose previous release is still queued.
  // Returning only the pending row would let cleanup empty a live spare.
  test("cleanup refuses conflicting registered and pending claims", async () => {
    const spare = slot(STATELESS_CLASS, ORD, "spare-01");
    await registerSpare(db, spare, { opId: "first", kind: "created" });
    await unregisterSpare(
      db,
      { name: spare.name, verifiedAtMs: null },
      { opId: "removed", atMs: AT_MS + 1, detail: "the primary moved" },
    );
    await registerSpare(db, spare, { opId: "reseed", kind: "created" });
    await expect(readPlacementClaim(db, spare.name)).rejects.toThrow(
      "conflicting placement claims",
    );
  });

  // The lookup runs on every placement call, from the codec, against the
  // creator's database: each table must be searched by its name, never
  // scanned, so a name neither holds costs no row.
  test("the class lookup searches each table by name", () => {
    const plan = sqlite
      .query(`EXPLAIN QUERY PLAN ${SLOT_IDENTITY_SQL.readRegisteredClass}`)
      .all() as { detail: string }[];
    const steps = plan
      .map((step) => step.detail)
      .filter((detail) => /^(SEARCH|SCAN) /.test(detail));
    expect(steps).toEqual([
      expect.stringMatching(/^SEARCH follow_slot USING INDEX .*\(name=\?\)$/),
      expect.stringMatching(/^SEARCH follow_spare USING INDEX .*\(name=\?\)$/),
    ]);
  });

  // A backlog of failed releases must not turn a name lookup into a scan.
  test("placement claims use a name index in every arm", () => {
    const plan = sqlite
      .query(`EXPLAIN QUERY PLAN ${SLOT_IDENTITY_SQL.readPlacementClaim}`)
      .all() as { detail: string }[];
    expect(
      plan
        .map((step) => step.detail)
        .filter((detail) => /^(SEARCH|SCAN) /.test(detail)),
    ).toEqual([
      expect.stringMatching(/^SEARCH follow_slot USING INDEX .*\(name=\?\)$/),
      expect.stringMatching(/^SEARCH follow_spare USING INDEX .*\(name=\?\)$/),
      expect.stringMatching(
        /^SEARCH follow_release_pending USING INDEX .*\(name=\?\)$/,
      ),
    ]);
  });

  // The base-slot side of the stale-unregister match, run by its own
  // statement: a slot verified since the pass read it stays, with its identity,
  // beside an unverified one.
  test("a base unregister that matches nothing keeps the identity", async () => {
    const read = slot(STATELESS_CLASS, MIA, "slot-01");
    await registerSlot(db, read, { opId: "a", kind: "created" });
    await registerSlot(db, slot(STATELESS_CLASS, ORD, "slot-02"), {
      opId: "b",
      kind: "created",
    });
    await stampVerified(db, {
      name: "slot-01",
      colo: MIA,
      opId: "v",
      atMs: AT_MS + 10,
    });
    expect(
      await unregisterSlot(db, read, {
        opId: "u",
        atMs: AT_MS + 20,
        detail: "the primary moved",
      }),
    ).toBe(false);
    expect(identities()).toEqual([
      ["slot-01", "id-slot-01"],
      ["slot-02", "id-slot-02"],
    ]);
  });

  // A creator build without the identity table writes base slots alone. The
  // deploy applies the schema again, which must give each such slot its
  // identity, or a spare could take its object id unrefused.
  test("reapplying the schema gives a slot written without one its identity", async () => {
    sqlite
      .query(
        "INSERT INTO follow_slot (class_code, colo, name, object_id, registered_at_ms, verified_at_ms) VALUES (?, ?, ?, ?, ?, NULL)",
      )
      .run(STATELESS_CLASS, MIA, "legacy-01", "id-legacy-01", AT_MS);
    expect(identities()).toEqual([]);
    sqlite.run(schema);
    expect(identities()).toEqual([["legacy-01", "id-legacy-01"]]);
    await expect(
      registerSpare(
        db,
        { ...slot(STATELESS_CLASS, ORD, "spare-01"), objectId: "id-legacy-01" },
        { opId: "b", kind: "created" },
      ),
    ).rejects.toThrow("UNIQUE constraint failed: follow_slot_name");
    expect(await readSpares(db)).toEqual([]);
  });

  // A created spare is its attempt's outcome and closes it; a seeded one is an
  // object already serving, so it leaves an attempt under the same op id open.
  // A stranded intent would keep the class from creating again.
  test.each<["created" | "seeded", string[]]>([
    ["created", []],
    ["seeded", ["a"]],
  ])("a %s spare leaves the open intents %j", async (kind, open) => {
    await beginCreation(db, {
      classCode: STATELESS_CLASS,
      opId: "a",
      atMs: AT_MS,
      nameOf: (number) => `spare-${number}`,
      objectIdOf: idOf,
    });
    await registerSpare(db, slot(STATELESS_CLASS, ORD, "spare-1"), {
      opId: "a",
      kind,
    });
    expect((await readOpenIntents(db, AT_MS + 1)).map((i) => i.opId)).toEqual(
      open,
    );
  });

  // As for a base slot: a stamp carrying a colo the spare is not registered in
  // is an answer about another row, so it matches and records nothing.
  test("a spare stamp from another colo matches nothing", async () => {
    await registerSpare(db, slot(STATELESS_CLASS, ORD, "spare-01"), {
      opId: "a",
      kind: "created",
    });
    expect(
      await stampSpareVerified(db, {
        name: "spare-01",
        colo: MIA,
        opId: "stale",
        atMs: AT_MS + 10,
      }),
    ).toBe(false);
    expect((await readSpares(db))[0]?.verifiedAtMs).toBeNull();
    expect(ledger().map((row) => row["op_id"])).toEqual(["a"]);
  });

  test("only a spare's first verification stamp is recorded", async () => {
    await registerSpare(db, slot(STATELESS_CLASS, ORD, "spare-01"), {
      opId: "a",
      kind: "created",
    });
    await stampSpareVerified(db, {
      name: "spare-01",
      colo: ORD,
      opId: "v1",
      atMs: AT_MS + 10,
    });
    await stampSpareVerified(db, {
      name: "spare-01",
      colo: ORD,
      opId: "v2",
      atMs: AT_MS + 20,
    });
    expect((await readSpares(db))[0]?.verifiedAtMs).toBe(AT_MS + 20);
    expect(ledger().map((row) => [row["op_id"], row["kind"]])).toEqual([
      ["a", 2],
      ["v1", 4],
    ]);
  });

  test("an unregistered spare waits for release with its reason", async () => {
    await registerSpare(db, slot(STATELESS_CLASS, ORD, "spare-01"), {
      opId: "a",
      kind: "created",
    });
    expect(
      await unregisterSpare(
        db,
        { name: "spare-01", verifiedAtMs: null },
        {
          opId: "u",
          atMs: AT_MS + 5,
          detail: "the primary moved",
        },
      ),
    ).toBe(true);
    expect(await readSpares(db)).toEqual([]);
    expect((await readReleasePending(db)).map((p) => p.name)).toEqual([
      "spare-01",
    ]);
    expect(ledger().at(-1)).toMatchObject({
      op_id: "u",
      kind: 5,
      detail: "the primary moved",
    });
  });

  // When the primary colo's base slot leaves, a verified spare there becomes
  // its base slot in one batch, so the colo keeps a slot with no creation.
  test("a verified spare is promoted into its colo's base slot with a record", async () => {
    await registerSpare(db, slot(STATELESS_CLASS, ORD, "spare-01"), {
      opId: "a",
      kind: "created",
    });
    await stampSpareVerified(db, {
      name: "spare-01",
      colo: ORD,
      opId: "v",
      atMs: AT_MS + 10,
    });
    expect(
      await promoteSpare(db, "spare-01", { opId: "p", atMs: AT_MS + 20 }),
    ).toBe(true);
    expect(await readSpares(db)).toEqual([]);
    expect(await readSlots(db)).toEqual([
      { ...slot(STATELESS_CLASS, ORD, "spare-01"), verifiedAtMs: AT_MS + 10 },
    ]);
    expect(ledger().at(-1)).toMatchObject({
      op_id: "p",
      kind: 9,
      name: "spare-01",
      colo: "ORD",
      detail: "promoted from spare",
    });
    expect(identities()).toEqual([["spare-01", "id-spare-01"]]);
  });

  // A colo holds a single base slot of a class, so a promotion into one that
  // still has its base slot fails whole and leaves the spare where it was.
  test("a promotion into a colo that keeps its base slot moves nothing", async () => {
    await registerSlot(db, slot(STATELESS_CLASS, ORD, "slot-01"), {
      opId: "a",
      kind: "created",
    });
    await registerSpare(db, slot(STATELESS_CLASS, ORD, "spare-01"), {
      opId: "b",
      kind: "created",
    });
    await stampSpareVerified(db, {
      name: "spare-01",
      colo: ORD,
      opId: "v",
      atMs: AT_MS + 10,
    });
    await expect(
      promoteSpare(db, "spare-01", { opId: "p", atMs: AT_MS + 20 }),
    ).rejects.toThrow();
    expect((await readSpares(db)).map((s) => s.name)).toEqual(["spare-01"]);
    expect(ledger().map((row) => row["op_id"])).toEqual(["a", "b", "v"]);
  });

  // An unverified spare has not shown it sits in its colo, so it is not made
  // the colo's base slot.
  test("an unverified spare is not promoted", async () => {
    await registerSpare(db, slot(STATELESS_CLASS, ORD, "spare-01"), {
      opId: "a",
      kind: "created",
    });
    expect(
      await promoteSpare(db, "spare-01", { opId: "p", atMs: AT_MS + 20 }),
    ).toBe(false);
    expect((await readSpares(db)).map((s) => s.name)).toEqual(["spare-01"]);
    expect(await readSlots(db)).toEqual([]);
    expect(ledger().map((row) => row["op_id"])).toEqual(["a"]);
  });
});
