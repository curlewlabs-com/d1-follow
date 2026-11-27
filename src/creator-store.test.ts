// The creator database's statements, run against real SQLite with
// schema/creator.sql applied: the same SQL, constraints and batch semantics
// D1 gives them, so a statement that does not parse, a constraint the schema
// does not have, or a batch that is not atomic fails here.
import { Database } from "bun:sqlite";
import { beforeEach, describe, expect, test } from "bun:test";
import type { Colo } from "./colo";
import { CREATOR_APP_SQL } from "./app-lane-reads";
import { takeCensus } from "./census";
import { sqliteHandle } from "./sqlite-test-handle";
import { CANDIDATE_SQL } from "./candidate-store";
import { GAP_SQL } from "./gap-store";
import {
  LANE_TARGET_SQL,
  readSlotNamed,
  readSlotsIn,
} from "./lane-target-store";
import { registeredClassOf, SLOT_IDENTITY_SQL } from "./slot-identity";
import { registerSpare, SPARE_SQL } from "./spare-store";
import {
  beginCreation,
  beginRelease,
  clearBackoff,
  readBackoff,
  readLedgerKinds,
  readOpenIntents,
  readReleasePending,
  recordReleased,
  setBackoff,
  CREATOR_SQL,
  lastCopiedLaneSeq,
  ledgerStatement,
  moveSlot,
  readSlots,
  recordLaneChange,
  recordSpentName,
  registerSlot,
  stampVerified,
  unregisterSlot,
  type SqlDatabase,
} from "./creator-store";

const ORD = "ORD" as Colo;
const MIA = "MIA" as Colo;
const IAD = "IAD" as Colo;
const AT_MS = Date.UTC(2026, 9, 5, 23, 0, 0);
// The id a test's namespace computes from a name, as the slot helper's.
const idOf = (name: string): string => `id-${name}`;
const STATELESS_CLASS = 1;
const LANE_CLASS = 2;

let sqlite: Database;
let db: SqlDatabase;

beforeEach(async () => {
  sqlite = new Database(":memory:");
  sqlite.run(
    await Bun.file(new URL("../schema/creator.sql", import.meta.url)).text(),
  );
  db = sqliteHandle(sqlite);
});

function ledger(): Record<string, unknown>[] {
  return sqlite
    .query(
      "SELECT op_id, at_ms, kind, class_code, name, object_id, colo, lane_code, lane_seq, from_name, changed_by, mode, detail FROM follow_ledger ORDER BY id",
    )
    .all() as Record<string, unknown>[];
}

// A full ledger row as read back, so every column is asserted: a writer that
// stopped filling one fails rather than passing on the columns a test named.
function ledgerRow(fields: Record<string, unknown>): Record<string, unknown> {
  return {
    op_id: null,
    at_ms: AT_MS,
    kind: null,
    class_code: null,
    name: null,
    object_id: null,
    colo: null,
    lane_code: null,
    lane_seq: null,
    from_name: null,
    changed_by: null,
    mode: null,
    detail: null,
    ...fields,
  };
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

// The creator's deploy applies the whole schema to a database that already
// holds it, every time. A statement that is not IF NOT EXISTS fails that
// deploy; one that rebuilt a table would lose the registry and the ledger.
test("the schema applies again over itself, keeping every row", async () => {
  const taken = await beginCreation(db, {
    classCode: STATELESS_CLASS,
    opId: "before",
    atMs: AT_MS,
    nameOf: (n) => `slot-${n}`,
    objectIdOf: idOf,
  });
  sqlite.run(
    await Bun.file(new URL("../schema/creator.sql", import.meta.url)).text(),
  );
  expect(ledger()).toHaveLength(1);
  expect(
    await beginCreation(db, {
      classCode: STATELESS_CLASS,
      opId: "after",
      atMs: AT_MS,
      nameOf: (n) => `slot-${n}`,
      objectIdOf: idOf,
    }),
  ).toEqual({ number: taken.number + 1, name: `slot-${taken.number + 1}` });
});

describe("beginCreation", () => {
  const nameOf = (number: number) => `slot-${String(number).padStart(2, "0")}`;

  // A name addressed once may still resolve where it was first placed, so a
  // reused number would hand a new slot an object that already exists. Each
  // class names its objects with its own prefix, as an adopter must.
  test("takes each class's numbers in turn and never reuses one", async () => {
    const take = (
      classCode: number,
      opId: string,
      named: (number: number) => string,
    ) =>
      beginCreation(db, {
        classCode,
        opId,
        atMs: AT_MS,
        nameOf: named,
        objectIdOf: idOf,
      });
    expect(await take(STATELESS_CLASS, "a", nameOf)).toEqual({
      number: 1,
      name: "slot-01",
    });
    expect(await take(STATELESS_CLASS, "b", nameOf)).toEqual({
      number: 2,
      name: "slot-02",
    });
    expect(await take(LANE_CLASS, "c", (n) => `lane-slot-${n}`)).toEqual({
      number: 1,
      name: "lane-slot-1",
    });
  });

  // Intent before act: the exact name is on record before anything addresses
  // it, so an answer lost on the way back can be resolved by observing that
  // name.
  // The intent carries the name's object id, which is what the census finds
  // the ledger's account of an object by: without it, an object an interrupted
  // creation left holding data reads as one nothing accounts for.
  test("records the attempt's intent under the exact name it hands back, with its id", async () => {
    const { name } = await beginCreation(db, {
      classCode: STATELESS_CLASS,
      opId: "a",
      atMs: AT_MS,
      nameOf,
      objectIdOf: idOf,
    });
    expect(ledger()).toEqual([
      ledgerRow({
        op_id: "a",
        kind: 1,
        class_code: STATELESS_CLASS,
        name,
        object_id: idOf(name),
      }),
    ]);
  });
});

describe("the registry", () => {
  test("a registered slot reads back with its record", async () => {
    await registerSlot(db, slot(STATELESS_CLASS, ORD, "slot-01"), {
      opId: "a",
      kind: "created",
    });
    expect(await readSlots(db)).toEqual([
      slot(STATELESS_CLASS, ORD, "slot-01"),
    ]);
    expect(ledger()).toEqual([
      ledgerRow({
        op_id: "a",
        kind: 2,
        class_code: STATELESS_CLASS,
        name: "slot-01",
        object_id: "id-slot-01",
        colo: "ORD",
      }),
    ]);
  });

  // At most one slot per class and colo. A second registration fails as a
  // whole, so no ledger row claims a slot the registry does not hold.
  test("a second slot for a class and colo is refused with no record", async () => {
    await registerSlot(db, slot(STATELESS_CLASS, ORD, "slot-01"), {
      opId: "a",
      kind: "created",
    });
    await expect(
      registerSlot(db, slot(STATELESS_CLASS, ORD, "slot-02"), {
        opId: "b",
        kind: "created",
      }),
    ).rejects.toThrow();
    expect(ledger().map((row) => row["op_id"])).toEqual(["a"]);
  });

  // Hourly stamps refresh the time; only the first is a change worth a row.
  test("only the first verification stamp is recorded", async () => {
    await registerSlot(db, slot(STATELESS_CLASS, ORD, "slot-01"), {
      opId: "a",
      kind: "seeded",
    });
    await stampVerified(db, {
      name: "slot-01",
      colo: ORD,
      opId: "b",
      atMs: AT_MS + 1,
    });
    await stampVerified(db, {
      name: "slot-01",
      colo: ORD,
      opId: "c",
      atMs: AT_MS + 2,
    });
    expect((await readSlots(db))[0]?.verifiedAtMs).toBe(AT_MS + 2);
    const seeded = {
      class_code: STATELESS_CLASS,
      name: "slot-01",
      object_id: "id-slot-01",
      colo: "ORD",
    };
    expect(ledger()).toEqual([
      ledgerRow({ op_id: "a", kind: 9, ...seeded }),
      ledgerRow({ op_id: "b", at_ms: AT_MS + 1, kind: 4, ...seeded }),
    ]);
  });

  // A pass stamps without holding its lease, so a stamp from a pass that lost
  // it can land after a newer one. The slot keeps its latest answer: moved
  // back, it could age out of the verified window early and leave the
  // registry while still answering.
  test("a stamp older than the slot's latest answer leaves it alone", async () => {
    await registerSlot(db, slot(STATELESS_CLASS, ORD, "slot-01"), {
      opId: "a",
      kind: "seeded",
    });
    await stampVerified(db, {
      name: "slot-01",
      colo: ORD,
      opId: "b",
      atMs: AT_MS + 5,
    });
    await stampVerified(db, {
      name: "slot-01",
      colo: ORD,
      opId: "c",
      atMs: AT_MS + 2,
    });
    expect((await readSlots(db))[0]?.verifiedAtMs).toBe(AT_MS + 5);
  });

  // A pass that lost its lease can stamp from an answer it got before another
  // pass moved the slot's row to a new colo. That answer says nothing about the
  // new colo, so the stamp must match nothing there, record nothing, and say so.
  test("a stamp from the colo a slot moved out of matches nothing", async () => {
    const read = slot(LANE_CLASS, MIA, "lane-slot-03");
    await registerSlot(db, read, { opId: "a", kind: "created" });
    expect(
      await moveSlot(db, read, { colo: ORD, atMs: AT_MS + 5, opId: "m" }),
    ).toBe(true);
    expect(
      await stampVerified(db, {
        name: "lane-slot-03",
        colo: MIA,
        opId: "stale",
        atMs: AT_MS + 6,
      }),
    ).toBe(false);
    expect(await readSlotNamed(db, "lane-slot-03")).toMatchObject({
      colo: ORD,
      verifiedAtMs: AT_MS + 5,
    });
    expect(ledger().map((row) => row["op_id"])).not.toContain("stale");
    expect(
      await stampVerified(db, {
        name: "lane-slot-03",
        colo: ORD,
        opId: "fresh",
        atMs: AT_MS + 7,
      }),
    ).toBe(true);
  });

  // A lane hands off to its class's slot in the colo its run points at; a
  // slot of another class there, or of its class elsewhere, is no target.
  test("a slot is found by its class and colo, and by nothing else", async () => {
    await registerSlot(db, slot(LANE_CLASS, MIA, "lane-slot-03"), {
      opId: "a",
      kind: "created",
    });
    expect(await readSlotsIn(db, LANE_CLASS, MIA)).toEqual([
      slot(LANE_CLASS, MIA, "lane-slot-03"),
    ]);
    expect(await readSlotsIn(db, STATELESS_CLASS, MIA)).toEqual([]);
    expect(await readSlotsIn(db, LANE_CLASS, ORD)).toEqual([]);
  });

  // The base row can name the lane's own holder, an object that moved, until
  // the creator's next pass. A spare is then the only target, and one earlier
  // than the base slot must still come after it.
  test("a colo's spares follow its base slot, and a spare is found by name", async () => {
    const spare = {
      ...slot(LANE_CLASS, MIA, "lane-spare-01"),
      registeredAtMs: 0,
    };
    await registerSlot(db, slot(LANE_CLASS, MIA, "lane-slot-03"), {
      opId: "a",
      kind: "created",
    });
    await registerSpare(db, spare, { opId: "b", kind: "created" });
    expect(
      (await readSlotsIn(db, LANE_CLASS, MIA)).map((found) => found.name),
    ).toEqual(["lane-slot-03", "lane-spare-01"]);
    expect(await readSlotNamed(db, "lane-spare-01")).toEqual(spare);
  });

  // An operator names the slot to hand a lane to, and the handoff goes ahead
  // only while that name is a registered slot: one that left the registry
  // must read as no slot, whatever it held before.
  test("a slot is found by its name until it leaves the registry", async () => {
    const lane = slot(LANE_CLASS, MIA, "lane-slot-03");
    await registerSlot(db, lane, { opId: "a", kind: "created" });
    expect(await readSlotNamed(db, "lane-slot-03")).toEqual(lane);
    expect(await readSlotNamed(db, "lane-slot-04")).toBeNull();

    await unregisterSlot(db, lane, {
      opId: "b",
      atMs: AT_MS + 1,
      detail: "moved",
    });
    expect(await readSlotNamed(db, "lane-slot-03")).toBeNull();
  });

  // The app's placement method refuses by this read, so a name that left the
  // registry has to stop reading as registered, or the creator could never
  // release it.
  test("a name reads as registered under its class until it is unregistered", async () => {
    const lane = slot(LANE_CLASS, MIA, "lane-slot-03");
    await registerSlot(db, lane, { opId: "a", kind: "created" });
    expect(await registeredClassOf(db, "lane-slot-03")).toBe(LANE_CLASS);
    expect(await registeredClassOf(db, "lane-slot-04")).toBeNull();

    await unregisterSlot(db, lane, { opId: "b", atMs: AT_MS, detail: "gone" });
    expect(await registeredClassOf(db, "lane-slot-03")).toBeNull();
  });

  // A pass stamps without its lease, so a slot can be verified again after
  // the pass holding the lease read it and before it unregisters on that
  // older answer. The newer verification wins: no unregister, no record, and
  // nothing queued for release.
  test("an unregister leaves a slot verified since it was read alone", async () => {
    const read = slot(LANE_CLASS, MIA, "lane-slot-03");
    await registerSlot(db, read, { opId: "a", kind: "created" });
    await stampVerified(db, {
      name: "lane-slot-03",
      colo: MIA,
      opId: "b",
      atMs: AT_MS + 5,
    });

    expect(
      await unregisterSlot(db, read, {
        opId: "c",
        atMs: AT_MS + 6,
        detail: "gone",
      }),
    ).toBe(false);
    expect((await readSlots(db)).map((s) => s.name)).toEqual(["lane-slot-03"]);
    expect(ledger().map((row) => row["op_id"])).toEqual(["a", "b"]);
    expect(await readReleasePending(db)).toEqual([]);

    const [now] = await readSlots(db);
    expect(
      now === undefined
        ? null
        : await unregisterSlot(db, now, {
            opId: "d",
            atMs: AT_MS + 7,
            detail: "gone",
          }),
    ).toBe(true);
    expect(await readSlots(db)).toEqual([]);
  });

  // A move is a decision on the pass's reading, so it matches the
  // verification the pass read, as an unregister does; and a colo keeps a
  // single slot of a class, so a move into one that has it fails whole.
  test("a move goes ahead only on the verification read, into a free colo", async () => {
    const read = slot(LANE_CLASS, MIA, "lane-slot-03");
    await registerSlot(db, read, { opId: "a", kind: "created" });
    await registerSlot(db, slot(LANE_CLASS, ORD, "lane-slot-04"), {
      opId: "b",
      kind: "created",
    });
    await expect(
      moveSlot(db, read, { colo: ORD, atMs: AT_MS + 5, opId: "m1" }),
    ).rejects.toThrow();
    await stampVerified(db, {
      name: "lane-slot-03",
      colo: MIA,
      opId: "v",
      atMs: AT_MS + 6,
    });
    expect(
      await moveSlot(db, read, { colo: IAD, atMs: AT_MS + 7, opId: "m2" }),
    ).toBe(false);
    expect(ledger().map((row) => row["op_id"])).toEqual(["a", "b", "v"]);
    expect((await readSlotNamed(db, "lane-slot-03"))?.colo).toBe(MIA);
  });

  test("an unregistered slot leaves the registry with its reason", async () => {
    await registerSlot(db, slot(LANE_CLASS, MIA, "lane-slot-03"), {
      opId: "a",
      kind: "created",
    });
    await unregisterSlot(db, slot(LANE_CLASS, MIA, "lane-slot-03"), {
      opId: "b",
      atMs: AT_MS,
      detail: "answered from IAD",
    });
    expect(await readSlots(db)).toEqual([]);
    expect(ledger()[1]).toEqual(
      ledgerRow({
        op_id: "b",
        kind: 5,
        class_code: LANE_CLASS,
        name: "lane-slot-03",
        object_id: "id-lane-slot-03",
        colo: "MIA",
        detail: "answered from IAD",
      }),
    );
  });

  test("a spent name is recorded with where it landed", async () => {
    await recordSpentName(db, {
      opId: "a",
      atMs: AT_MS,
      classCode: STATELESS_CLASS,
      name: "slot-04",
      objectId: "id-4",
      colo: ORD,
    });
    expect(ledger()).toEqual([
      ledgerRow({
        op_id: "a",
        kind: 3,
        class_code: STATELESS_CLASS,
        name: "slot-04",
        object_id: "id-4",
        colo: "ORD",
      }),
    ]);
  });
});

describe("lane changes", () => {
  const seeded = {
    laneCode: 1,
    seq: 1,
    fromHolder: null,
    toHolder: "lane-ord",
    changedAtMs: AT_MS,
    changedBy: "seeded",
  } as const;

  test("a copied lane change reads back under its lane and sequence", async () => {
    expect(await lastCopiedLaneSeq(db, 1)).toBeNull();
    await recordLaneChange(db, { opId: "a", ...seeded });
    await recordLaneChange(db, {
      opId: "a",
      laneCode: 1,
      seq: 2,
      fromHolder: "lane-ord",
      toHolder: "lane-mia",
      changedAtMs: AT_MS + 1,
      changedBy: "handed_off",
    });
    expect(await lastCopiedLaneSeq(db, 1)).toBe(2);
    expect(await lastCopiedLaneSeq(db, 2)).toBeNull();
    expect(ledger()).toEqual([
      ledgerRow({
        op_id: "a",
        kind: 8,
        name: "lane-ord",
        lane_code: 1,
        lane_seq: 1,
        changed_by: 1,
      }),
      ledgerRow({
        op_id: "a",
        at_ms: AT_MS + 1,
        kind: 8,
        name: "lane-mia",
        lane_code: 1,
        lane_seq: 2,
        from_name: "lane-ord",
        changed_by: 2,
      }),
    ]);
  });

  // A pass whose answer was lost copies again; the ledger must still hold one
  // row per change, or the account of moves would double-count them.
  test("copying a change twice records it once", async () => {
    await recordLaneChange(db, { opId: "a", ...seeded });
    await recordLaneChange(db, { opId: "b", ...seeded });
    expect(ledger().map((row) => row["op_id"])).toEqual(["a"]);
  });

  // The per-kind CHECK is what keeps a kind's identity out of free text: a row
  // without it is refused rather than written.
  test("a ledger row without its kind's identity is refused", async () => {
    await expect(
      ledgerStatement(db, {
        opId: "a",
        atMs: AT_MS,
        kind: "lane_changed",
        name: "lane-ord",
        detail: "lane=1 seq=1",
      }).run(),
    ).rejects.toThrow();
    expect(ledger()).toEqual([]);
  });
});

describe("ledger identity", () => {
  // A ledger row's identity comes from the registry or the lane change log, and
  // a value either source would refuse is a writer's bug, not a record.
  const created = {
    opId: "a",
    atMs: AT_MS,
    kind: "created",
    classCode: STATELESS_CLASS,
    name: "slot-01",
    objectId: "id-slot-01",
    colo: ORD,
  } as const;
  const laneChanged = {
    opId: "a",
    atMs: AT_MS,
    kind: "lane_changed",
    name: "lane-mia",
    laneCode: 1,
    laneSeq: 2,
    fromName: "lane-ord",
    changedBy: "handed_off",
  } as const;
  test.each([
    ["a class code below one", { ...created, classCode: 0 }],
    ["an empty name", { ...created, name: "" }],
    ["an empty object id", { ...created, objectId: "" }],
    ["a lowercase colo", { ...created, colo: "ord" as Colo }],
    ["a colo of the wrong length", { ...created, colo: "ORDX" as Colo }],
    ["a colo that is not letters", { ...created, colo: "123" as Colo }],
    ["a lane code below one", { ...laneChanged, laneCode: 0 }],
    ["a lane sequence below one", { ...laneChanged, laneSeq: 0 }],
    ["an empty previous holder", { ...laneChanged, fromName: "" }],
  ] as const)("refuses %s", async (_, entry) => {
    await expect(ledgerStatement(db, entry).run()).rejects.toThrow(
      /CHECK constraint failed/,
    );
    expect(ledger()).toEqual([]);
  });

  test("accepts the same rows with valid identity", async () => {
    await ledgerStatement(db, created).run();
    await ledgerStatement(db, laneChanged).run();
    expect(ledger()).toHaveLength(2);
  });
});

describe("open intents", () => {
  const nameOf = (number: number) => `slot-${number}`;
  const begin = (opId: string, atMs = AT_MS) =>
    beginCreation(db, {
      classCode: STATELESS_CLASS,
      opId,
      atMs,
      nameOf,
      objectIdOf: idOf,
    });

  // A pass that loses an attempt's answer must still find it, without reading
  // the ledger, so the attempt can be resolved by observing its name.
  test("an attempt stays open until its outcome is recorded", async () => {
    await begin("a");
    await begin("b");
    await recordSpentName(db, {
      opId: "a",
      atMs: AT_MS,
      classCode: STATELESS_CLASS,
      name: "slot-1",
      objectId: "id-1",
      colo: ORD,
    });
    await registerSlot(
      db,
      { ...slot(STATELESS_CLASS, MIA, "slot-2"), objectId: "id-2" },
      { opId: "b", kind: "created" },
    );
    expect(await readOpenIntents(db, AT_MS + 1)).toEqual([]);
  });

  // Seeding registers an object that was already serving; it is no attempt's
  // outcome, so it must not close one, even under an op id an attempt used.
  test("a seeded registration leaves an open attempt open", async () => {
    await begin("a");
    await registerSlot(db, slot(STATELESS_CLASS, MIA, "serving-1"), {
      opId: "a",
      kind: "seeded",
    });
    expect((await readOpenIntents(db, AT_MS + 1)).map((i) => i.opId)).toEqual([
      "a",
    ]);
  });

  // A pass resolves only attempts from before it began, never its own.
  test("lists only the attempts begun before the given time", async () => {
    await begin("a", AT_MS);
    await begin("b", AT_MS + 10);
    expect(await readOpenIntents(db, AT_MS + 10)).toEqual([
      { opId: "a", classCode: STATELESS_CLASS, name: "slot-1", atMs: AT_MS },
    ]);
  });

  // An outcome that cannot be written leaves the attempt open, to be resolved
  // later, rather than closed with no record of what happened.
  test("an outcome that fails to write leaves its attempt open", async () => {
    await begin("a");
    await expect(
      recordSpentName(db, {
        opId: "a",
        atMs: AT_MS,
        classCode: STATELESS_CLASS,
        name: "slot-1",
        objectId: "",
        colo: ORD,
      }),
    ).rejects.toThrow(/CHECK constraint failed/);
    expect((await readOpenIntents(db, AT_MS + 1)).map((i) => i.opId)).toEqual([
      "a",
    ]);
  });
});

describe("release", () => {
  const out = slot(LANE_CLASS, MIA, "lane-slot-03");

  // Leaving the registry is not a release: the object stays until the release
  // rule allows it, and the creator has to know it is there.
  test("an unregistered slot waits for release, and leaves with its record", async () => {
    await registerSlot(db, out, { opId: "a", kind: "created" });
    await unregisterSlot(db, out, {
      opId: "b",
      atMs: AT_MS + 5,
      detail: "answered from IAD",
    });
    const [pending] = await readReleasePending(db);
    expect(pending).toEqual({
      name: "lane-slot-03",
      classCode: LANE_CLASS,
      objectId: "id-lane-slot-03",
      unregisteredAtMs: AT_MS + 5,
    });
    if (pending === undefined) throw new Error("no pending release");

    await beginRelease(db, { ...pending, opId: "c", atMs: AT_MS + 9 });
    await recordReleased(db, { ...pending, opId: "c", atMs: AT_MS + 10 });

    expect(await readReleasePending(db)).toEqual([]);
    expect(
      ledger()
        .slice(-2)
        .map((row) => [row["op_id"], row["kind"], row["object_id"]]),
    ).toEqual([
      ["c", 6, "id-lane-slot-03"],
      ["c", 7, "id-lane-slot-03"],
    ]);
  });
});

describe("the ledger by object", () => {
  // The census asks what the ledger last said of each object holding data; a
  // later release must win over the creation before it, or a released object
  // that still holds data would read as alive.
  test("answers the latest kind for each object it names, and nothing for the rest", async () => {
    const out = slot(STATELESS_CLASS, ORD, "slot-01");
    await registerSlot(db, out, { opId: "a", kind: "created" });
    await unregisterSlot(db, out, { opId: "b", atMs: AT_MS, detail: "moved" });
    const kinds = await readLedgerKinds(db, ["id-slot-01", "id-unknown"]);
    expect(kinds).toEqual(new Map([["id-slot-01", "unregistered"]]));
  });
  // An attempt interrupted after its object took data leaves only the intent.
  // The census must find that intent through the object's id and report the
  // object as unresolved; reported as unnamed, it would send an operator after
  // a foreign object when it is the creator's own unfinished attempt.
  test("an interrupted creation's object reaches the census as unresolved", async () => {
    const { name } = await beginCreation(db, {
      classCode: STATELESS_CLASS,
      opId: "a",
      atMs: AT_MS,
      nameOf: (n) => `slot-${n}`,
      objectIdOf: idOf,
    });
    const report = takeCensus({
      objects: [{ classLabel: "Handler", id: idOf(name), hasStoredData: true }],
      slots: [],
      spares: [],
      pending: [],
      ledgerKinds: await readLedgerKinds(db, [idOf(name)]),
      names: new Map(),
      recognized: () => false,
    });
    expect(report.unresolved).toEqual([
      { classLabel: "Handler", id: idOf(name), name: null },
    ]);
    expect(report.unnamed).toEqual([]);
  });

  // A release that keeps failing appends an intent on every retry, for the
  // life of the environment. The read must cost one indexed seek per object it
  // asks about, not a walk of each object's history: the plan has to search
  // the object index from a per-object subquery, with no grouping or sort (a
  // grouped max(id) returns one row too, but reads every row behind it).
  test("seeks each object's latest row instead of reading its history", async () => {
    const out = slot(STATELESS_CLASS, ORD, "slot-01");
    await registerSlot(db, out, { opId: "a", kind: "created" });
    await unregisterSlot(db, out, { opId: "b", atMs: AT_MS, detail: "moved" });
    for (let retry = 0; retry < 20; retry++) {
      await beginRelease(db, {
        name: "slot-01",
        classCode: STATELESS_CLASS,
        objectId: "id-slot-01",
        unregisteredAtMs: AT_MS,
        opId: `r${retry}`,
        atMs: AT_MS + 1 + retry,
      });
    }
    const rows = sqlite
      .query(CREATOR_SQL.readLedgerByObjects)
      .all(JSON.stringify(["id-slot-01"]));
    expect(rows).toEqual([{ object_id: "id-slot-01", kind: 6 }]);
    const plan = (
      sqlite
        .query(`EXPLAIN QUERY PLAN ${CREATOR_SQL.readLedgerByObjects}`)
        .all() as { detail: string }[]
    ).map((step) => step.detail);
    expect(plan).toContain("CORRELATED SCALAR SUBQUERY 1");
    expect(plan).toContain(
      "SEARCH follow_ledger USING INDEX follow_ledger_by_object (object_id=?)",
    );
    expect(plan.filter((d) => /TEMP B-TREE|GROUP BY/.test(d))).toEqual([]);
  });
});

describe("backoff", () => {
  // A class with no row attempts every pass; a set wait reads back, a later
  // one replaces it, and clearing it returns the class to every pass.
  test("a class's wait reads back, is replaced, and clears", async () => {
    expect(await readBackoff(db)).toEqual(new Map());
    await setBackoff(db, STATELESS_CLASS, {
      waitMs: 3_600_000,
      nextAttemptAtMs: AT_MS + 3_600_000,
    });
    await setBackoff(db, STATELESS_CLASS, {
      waitMs: 7_200_000,
      nextAttemptAtMs: AT_MS + 7_200_000,
    });
    expect(await readBackoff(db)).toEqual(
      new Map([
        [
          STATELESS_CLASS,
          { waitMs: 7_200_000, nextAttemptAtMs: AT_MS + 7_200_000 },
        ],
      ]),
    );
    await clearBackoff(db, STATELESS_CLASS);
    expect(await readBackoff(db)).toEqual(new Map());
  });
});

describe("query plans", () => {
  // follow_ledger keeps every record for the life of the environment, so a
  // statement that walks it costs more on every pass. Each plan is SQLite's
  // own, read with the schema applied. A step on the ledger must name the index
  // it searches: SQLite reports a lookup no index serves as a bare
  // "SEARCH follow_ledger", not as SCAN, so looking for SCAN alone misses it.
  test.each(
    Object.entries({
      ...CREATOR_SQL,
      ...CANDIDATE_SQL,
      ...GAP_SQL,
      ...LANE_TARGET_SQL,
      ...SPARE_SQL,
      ...SLOT_IDENTITY_SQL,
    }),
  )("%s searches follow_ledger only through an index", (_, sql) => {
    const plan = sqlite.query(`EXPLAIN QUERY PLAN ${sql}`).all() as {
      detail: string;
    }[];
    expect(
      plan
        .map((step) => step.detail)
        .filter(
          (detail) =>
            /\bfollow_ledger\b/.test(detail) &&
            !/^SEARCH follow_ledger USING (?!AUTOMATIC)/.test(detail),
        ),
    ).toEqual([]);
  });
});

describe("the release read's plan", () => {
  // The pending set has no bound of its own, so the pass's read of it must walk
  // the due index in its order and stop at its LIMIT: a sort would read every
  // pending row of the class first.
  test("walks follow_release_pending_due without sorting", () => {
    const plan = sqlite
      .query(`EXPLAIN QUERY PLAN ${CREATOR_SQL.readReleaseDue}`)
      .all() as { detail: string }[];
    const details = plan.map((step) => step.detail);
    expect(
      details.filter((detail) => /\bfollow_release_pending\b/.test(detail)),
    ).toEqual([
      "SEARCH follow_release_pending USING INDEX follow_release_pending_due (class_code=?)",
    ]);
    expect(details.filter((detail) => /TEMP B-TREE/.test(detail))).toEqual([]);
  });
});

describe("app-database query plans", () => {
  // The change log is kept for the life of the environment, so the creator's
  // read of it must search its key, the lane then the sequence number; the
  // lane record is a row per lane. Each plan is SQLite's, read with lane.sql.
  test.each(Object.entries(CREATOR_APP_SQL))(
    "%s searches follow_lane_change only through its key",
    async (_, sql) => {
      const app = new Database(":memory:");
      app.run(
        await Bun.file(new URL("../schema/lane.sql", import.meta.url)).text(),
      );
      const plan = app.query(`EXPLAIN QUERY PLAN ${sql}`).all() as {
        detail: string;
      }[];
      expect(
        plan
          .map((step) => step.detail)
          .filter(
            (detail) =>
              /\bfollow_lane_change\b/.test(detail) &&
              !/^SEARCH follow_lane_change USING (?!AUTOMATIC)/.test(detail),
          ),
      ).toEqual([]);
    },
  );
});
