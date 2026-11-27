// The gap records as the creator database keeps them, in the world
// creator-test-harness.ts sets up.
import { beforeEach, expect, test } from "bun:test";
import {
  CreatorWorld,
  MIA,
  ORD,
  SCHEDULER,
  T0_MS,
} from "./creator-test-harness";
import type { SqlDatabase } from "./creator-store";
import { deleteGap, readGaps, writeGap } from "./gap-store";
import { claimPass } from "./pass-lease";

const HOLDER = "this-pass";
let db: SqlDatabase;

beforeEach(async () => {
  db = (await CreatorWorld.open()).handle();
  await claimPass(db, { holder: HOLDER, nowMs: T0_MS, leaseMs: 1_800_000 });
});

// A record reads back as written, and a second write for the same gap
// replaces it rather than adding a row, so one gap has one record.
test("a gap's record reads back, and a later write replaces it", async () => {
  const first = {
    classCode: SCHEDULER,
    colo: MIA,
    kind: "slot" as const,
    begunAtMs: T0_MS,
    attemptedAtMs: null,
  };
  expect(await writeGap(db, first, HOLDER)).toBe(true);
  expect(
    await writeGap(
      db,
      { ...first, colo: ORD, kind: "spares", attemptedAtMs: T0_MS },
      HOLDER,
    ),
  ).toBe(true);
  const later = { ...first, attemptedAtMs: T0_MS + 1 };
  expect(await writeGap(db, later, HOLDER)).toBe(true);
  expect(await readGaps(db)).toEqual([
    later,
    { ...first, colo: ORD, kind: "spares", attemptedAtMs: T0_MS },
  ]);

  expect(await deleteGap(db, later, HOLDER)).toBe(true);
  expect((await readGaps(db)).map((g) => g.colo)).toEqual([ORD]);
  // Already gone is deleted, not a lost lease.
  expect(await deleteGap(db, later, HOLDER)).toBe(true);
});

// The risk this guards: a time no pass can read exactly, epoch nanoseconds
// say, would make every pass fail on reading the table. The schema refuses it,
// so the records a pass reads are ones it can judge.
test("refuses a time a pass cannot read exactly", async () => {
  const world = await CreatorWorld.open();
  const insert = (begunAtMs: bigint, attemptedAtMs: bigint | null) =>
    world.creator
      .query(
        "INSERT INTO follow_gap (class_code, colo, kind, begun_at_ms, attempted_at_ms) VALUES (?, ?, 1, ?, ?)",
      )
      .run(SCHEDULER, MIA, begunAtMs, attemptedAtMs);
  const nanos = BigInt(T0_MS) * 1_000_000n;
  expect(() => insert(nanos, null)).toThrow(/CHECK/);
  expect(() => insert(BigInt(T0_MS), nanos)).toThrow(/CHECK/);
  expect(() => insert(-1n, null)).toThrow(/CHECK/);
});

// The risk this guards: a pass that stalled past its lease writes after the
// pass now holding it has deleted the record, and a gap the new pass saw
// filled comes back, or one it started over keeps an old age. Each write
// takes effect only while its pass still holds the lease.
test("writes and deletes nothing for a pass that lost its lease", async () => {
  const record = {
    classCode: SCHEDULER,
    colo: MIA,
    kind: "slot" as const,
    begunAtMs: T0_MS,
    attemptedAtMs: T0_MS,
  };
  expect(await writeGap(db, record, HOLDER)).toBe(true);
  await claimPass(db, {
    holder: "next-pass",
    nowMs: T0_MS + 1_800_000,
    leaseMs: 1_800_000,
  });

  expect(await deleteGap(db, record, HOLDER)).toBe(false);
  expect(await readGaps(db)).toEqual([record]);
  expect(await writeGap(db, { ...record, begunAtMs: T0_MS - 1 }, HOLDER)).toBe(
    false,
  );
  expect(await readGaps(db)).toEqual([record]);
});
