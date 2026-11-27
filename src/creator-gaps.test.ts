// How the pass paces its attempts at the gap in the primary's colo by the
// gap's record: on every pass while the gap is young, then once a cap, and the
// record's life from the first creation to the pass that sees the gap closed,
// in the world creator-test-harness.ts sets up. The cap is the harness's
// maxBackoffMs, a day, and passes are hourly. The probes' own pacing is
// creator-hints.test.ts's.
import { beforeEach, describe, expect, test } from "bun:test";
import type { Colo } from "./colo";
import type { CreatorPassReport } from "./creator";
import { LEDGER_KIND, setMode } from "./creator-store";
import {
  CreatorWorld,
  HOUR_MS,
  IAD,
  MIA,
  ORD,
  SCHEDULER,
  T0_MS,
  scriptedClass,
  type ScriptedClass,
} from "./creator-test-harness";
import { readGaps, type GapKind, type GapRecord } from "./gap-store";

const ATTEMPTS = 2;

let world: CreatorWorld;
let landings: Colo[];
let cls: ScriptedClass;

beforeEach(async () => {
  world = await CreatorWorld.open();
  await world.act();
  world.primary = { colo: MIA, region: "ENAM" };
  await world.seed("scheduler-ord", ORD, T0_MS);
  landings = Array.from({ length: 400 }, () => ORD);
  cls = scriptedClass(landings);
  cls.where.set("scheduler-ord", ORD);
});

const creations = (report: CreatorPassReport): number =>
  report.spent.length + report.created.length + report.sparesCreated.length;
// The attempts a pass made: its creations less one probe through each hint
// it probed through. Every creation here answers, so none drops out of the
// count.
const attempted = (report: CreatorPassReport): number =>
  creations(report) - report.regionHintsProbed.length;

// A pass `hours` after T0.
async function at(
  hours: number,
  of: ScriptedClass = cls,
): Promise<CreatorPassReport> {
  world.clock = T0_MS + hours * HOUR_MS;
  return await world.pass(of, { attemptsPerClassPerPass: ATTEMPTS });
}

const gap = (
  colo: Colo,
  begunHours: number,
  attemptedHours: number | null,
  kind: GapKind = "slot",
): GapRecord => ({
  classCode: SCHEDULER,
  colo,
  kind,
  begunAtMs: T0_MS + begunHours * HOUR_MS,
  attemptedAtMs:
    attemptedHours === null ? null : T0_MS + attemptedHours * HOUR_MS,
});

// A record as some other build or a hand edit left it: the store's own write
// takes the pass lease, which no pass holds between passes.
function seedGap(record: GapRecord): void {
  world.creator
    .query(
      "INSERT INTO follow_gap (class_code, colo, kind, begun_at_ms, attempted_at_ms) VALUES (?, ?, ?, ?, ?)",
    )
    .run(
      record.classCode,
      record.colo,
      record.kind === "slot" ? 1 : 2,
      record.begunAtMs,
      record.attemptedAtMs,
    );
}

const gaps = async (): Promise<GapRecord[]> => await readGaps(world.handle());

describe("pacing", () => {
  // A fresh gap beside the primary is the one a move needs filled, so it gets
  // the full attempt rate for its first day; one that outlives the day costs
  // one round a day. The thresholds are read by hourly passes, less half a
  // pass, so the last young pass is the 23rd hour and the next attempt the
  // 47th.
  test("attempts on every pass while the gap is young, then once a cap", async () => {
    const counts: number[] = [];
    for (let hour = 0; hour <= 48; hour++) {
      counts.push(attempted(await at(hour)));
    }
    expect(counts.slice(0, 24)).toEqual(Array(24).fill(ATTEMPTS));
    expect(counts.slice(24, 47)).toEqual(Array(23).fill(0));
    expect(counts.slice(47)).toEqual([ATTEMPTS, 0]);
    expect(await gaps()).toEqual([gap(MIA, 0, 47)]);
    expect(world.lines).toContain(
      `[follow] scheduler the gap in MIA is next attempted by a pass from ${new Date(T0_MS + 46.5 * HOUR_MS).toISOString()}`,
    );
  });

  // A cron that fires twice runs two passes in an hour. While the gap is
  // young both attempt, each within the attempts bound; once it is old the
  // second finds the first one's attempt and waits.
  test("two passes in an hour both attempt a young gap, and one an old", async () => {
    expect(attempted(await at(0))).toBe(ATTEMPTS);
    expect(attempted(await at(0.5))).toBe(ATTEMPTS);
    expect(attempted(await at(24))).toBe(ATTEMPTS);
    expect(attempted(await at(24.5))).toBe(0);
    expect(await gaps()).toEqual([gap(MIA, 0, 24)]);
  });

  // The risk this guards: a clock that ran backward, or a hand edit, leaves a
  // record that would silence the attempts for as long as it says. A record
  // the pass cannot trust is dropped, the attempts run, and the gap begins
  // again from this pass.
  test.each([
    ["begins after the pass", gap(MIA, 1, 1)],
    ["was attempted after the pass", gap(MIA, -48, 1)],
    ["was attempted before it began", gap(MIA, -1, -2)],
  ])("drops a record that %s, and attempts", async (_, record) => {
    seedGap(record);
    expect(attempted(await at(0))).toBe(ATTEMPTS);
    expect(await gaps()).toEqual([gap(MIA, 0, 0)]);
    expect(world.lines).toContain(
      "[follow] scheduler gap record in MIA cannot be trusted - replaced",
    );
  });

  // A record the pass cannot trust is dropped even when no attempt can
  // replace it, so it is not read again as the gap's history once the class
  // can attempt.
  test("deletes a record it cannot trust when no attempt replaces it", async () => {
    const lost: ScriptedClass = {
      ...cls,
      observe: () => Promise.reject(new Error("answer lost")),
    };
    await at(0, lost);
    world.creator
      .query("UPDATE follow_gap SET begun_at_ms = ?, attempted_at_ms = ?")
      .run(T0_MS + 5 * HOUR_MS, T0_MS + 5 * HOUR_MS);
    expect(attempted(await at(1, lost))).toBe(0);
    expect(await gaps()).toEqual([]);
    expect(world.lines).toContain(
      "[follow] scheduler gap record in MIA cannot be trusted - deleted",
    );
  });

  // Dry-run and an attempt left open each stop a class creating, but the
  // gap's age is wall time from its first creation, so a class that comes
  // back after the cap finds the gap old. Dry-run writes none of the records
  // and logs what is due.
  test("lets a gap age while its class can create nothing", async () => {
    expect(attempted(await at(0))).toBe(ATTEMPTS);
    const dryRun = async (hours: number): Promise<CreatorPassReport> => {
      await setMode(world.handle(), {
        kind: "class",
        code: SCHEDULER,
        mode: "dry_run",
        opId: `dry-${hours}`,
        atMs: T0_MS + hours * HOUR_MS,
      });
      return await at(hours);
    };
    const dry = await dryRun(12);
    expect(creations(dry)).toBe(0);
    expect(world.lines).toContain(
      "[follow] scheduler dry-run - would probe through enam and attempt the gap in MIA",
    );
    expect(await gaps()).toEqual([gap(MIA, 0, 0)]);

    await world.act();
    expect(attempted(await at(25))).toBe(ATTEMPTS);
    expect(attempted(await at(26))).toBe(0);
    expect(await gaps()).toEqual([gap(MIA, 0, 25)]);

    await dryRun(27);
    expect(world.lines).toContain(
      `[follow] scheduler dry-run - would probe through enam; the gap in MIA is next attempted by a pass from ${new Date(T0_MS + 48.5 * HOUR_MS).toISOString()}`,
    );
    expect(await gaps()).toEqual([gap(MIA, 0, 25)]);
  });

  // The wait's time is for an operator deciding whether to wait or launch by
  // hand, so it names none for a gap a probe has just filled, or for one no
  // hint can reach.
  test("names no wait for a gap a probe filled or no hint reaches", async () => {
    await at(0);
    const waits = (): string[] =>
      world.lines.filter((l) => l.includes("is next attempted"));
    await at(24);
    await at(25);
    expect(waits()).toHaveLength(1);

    world.primary = { colo: MIA, region: "MARS" };
    await setMode(world.handle(), {
      kind: "class",
      code: SCHEDULER,
      mode: "dry_run",
      opId: "dry",
      atMs: T0_MS + 26 * HOUR_MS,
    });
    await at(26);
    expect(waits()).toHaveLength(1);

    await world.act();
    world.primary = { colo: MIA, region: "ENAM" };
    landings.unshift(MIA);
    const filled = await at(27);
    expect(filled.created.map((o) => o.colo)).toEqual([MIA]);
    expect(waits()).toHaveLength(1);
  });

  test("keeps a class with an attempt left open from attempting or writing its record", async () => {
    expect(attempted(await at(0))).toBe(ATTEMPTS);
    const lost: ScriptedClass = {
      ...cls,
      observe: () => Promise.reject(new Error("answer lost")),
    };
    // The answers are lost, so this pass leaves its creations open.
    await at(1, lost);
    expect(await gaps()).toEqual([gap(MIA, 0, 1)]);
    const blocked = await at(2, lost);
    expect(attempted(blocked)).toBe(0);
    expect(await gaps()).toEqual([gap(MIA, 0, 1)]);
  });
});

describe("the gap's record", () => {
  // A pass that cannot read where the primary is cannot say which colo the
  // attempts are for, nor whether a shortfall of spares is still one. It makes
  // no attempts and leaves such a record as it is; the next pass that reads
  // the primary judges it.
  test("leaves a shortfall of spares alone while the primary cannot be read", async () => {
    await world.seed("scheduler-iad", IAD, T0_MS);
    cls.where.set("scheduler-iad", IAD);
    landings.splice(0, landings.length, ...Array(400).fill(IAD));
    const withSpare: ScriptedClass = { ...cls, spares: 1 };
    world.primary = { colo: ORD, region: "ENAM" };
    expect(attempted(await at(0, withSpare))).toBe(ATTEMPTS);
    expect(await gaps()).toEqual([gap(ORD, 0, 0, "spares")]);

    world.primary = "fails";
    expect(attempted(await at(1, withSpare))).toBe(0);
    expect(await gaps()).toEqual([gap(ORD, 0, 0, "spares")]);
  });

  // The risk this guards: a missing slot filled while the primary cannot be
  // read, and lost again before it can, would leave the record of the first
  // gap standing, so the second would start old and its class would not
  // probe on every pass. A missing slot the class now holds is closed, or a
  // shortfall of spares, whatever the primary is, so the pass judges it.
  test("closes a missing slot it sees filled while the primary cannot be read", async () => {
    expect(attempted(await at(0))).toBe(ATTEMPTS);
    world.primary = "fails";
    landings.unshift(MIA);
    const unread = await at(1);
    expect(attempted(unread)).toBe(0);
    expect(unread.created.map((o) => o.colo)).toEqual([MIA]);
    expect(await gaps()).toEqual([]);

    const name = unread.created[0]?.name ?? "";
    cls.where.set(name, IAD);
    const reopened = await at(30);
    expect(reopened.unregistered.map((o) => o.name)).toEqual([name]);
    expect(reopened.regionHintsProbed).toEqual(["enam"]);
    expect(await gaps()).toEqual([gap(MIA, 30, null)]);
  });

  // A record outliving its gap would make the next gap there start old. So
  // the pass that sees the gap filled deletes the record, and the gap that
  // returns when the slot leaves is young again.
  test("goes once the gap fills, so a gap that returns is new", async () => {
    await at(0);
    landings.unshift(MIA);
    const filled = await at(30);
    expect(filled.created.map((o) => o.colo)).toEqual([MIA]);
    expect(await gaps()).toEqual([]);

    const name = filled.created[0]?.name ?? "";
    cls.where.set(name, IAD);
    const reopened = await at(31);
    expect(reopened.unregistered.map((o) => o.name)).toEqual([name]);
    expect(attempted(reopened)).toBe(ATTEMPTS);
    expect(await gaps()).toEqual([gap(MIA, 31, 31)]);
    expect(attempted(await at(32))).toBe(ATTEMPTS);
  });

  // A shortfall of spares is a gap only while the primary is in its colo. The
  // primary leaving closes it, and its return opens a new one, young, with
  // the attempts' full first day.
  test("goes when the primary leaves a colo whose gap was its spares", async () => {
    await world.seed("scheduler-mia", MIA, T0_MS);
    await world.seed("scheduler-iad", IAD, T0_MS);
    cls.where.set("scheduler-mia", MIA);
    cls.where.set("scheduler-iad", IAD);
    landings.splice(0, landings.length, ...Array(400).fill(IAD));
    const withSpare: ScriptedClass = { ...cls, spares: 1 };
    world.primary = { colo: ORD, region: "ENAM" };

    expect(attempted(await at(0, withSpare))).toBe(ATTEMPTS);
    expect(await gaps()).toEqual([gap(ORD, 0, 0, "spares")]);

    world.primary = { colo: MIA, region: "ENAM" };
    await at(1, withSpare);
    expect(await gaps()).toEqual([gap(MIA, 1, 1, "spares")]);

    world.primary = { colo: ORD, region: "ENAM" };
    expect(attempted(await at(30, withSpare))).toBe(ATTEMPTS);
    expect(await gaps()).toEqual([gap(ORD, 30, 30, "spares")]);
  });

  // The risk this guards: a shortfall of spares that has outlived its first
  // day waits a day between attempts, and the class's slot beside the
  // primary then leaves. The class has nothing there to move to, so the lost
  // slot is a new gap with its own young day, not the old shortfall's wait.
  test("starts over when the slot beside the primary is lost where only spares were short", async () => {
    await world.seed("scheduler-iad", IAD, T0_MS);
    cls.where.set("scheduler-iad", IAD);
    landings.splice(0, landings.length, ...Array(400).fill(IAD));
    const withSpare: ScriptedClass = { ...cls, spares: 1 };
    world.primary = { colo: ORD, region: "ENAM" };
    await at(0, withSpare);
    expect(attempted(await at(24, withSpare))).toBe(ATTEMPTS);
    expect(attempted(await at(25, withSpare))).toBe(0);
    expect(await gaps()).toEqual([gap(ORD, 0, 24, "spares")]);

    cls.where.set("scheduler-ord", IAD);
    const lost = await at(26, withSpare);
    expect(lost.unregistered.map((o) => o.name)).toEqual(["scheduler-ord"]);
    expect(attempted(lost)).toBe(ATTEMPTS);
    expect(await gaps()).toEqual([gap(ORD, 26, 26)]);
    expect(attempted(await at(27, withSpare))).toBe(ATTEMPTS);
  });

  // The reverse: a probe restores the slot while the class is still short of
  // spares there. What it lacks is now its spares, a gap that begins with
  // the attempts this pass makes at it.
  test("starts over when a probe restores the slot and spares are still short", async () => {
    const withSpare: ScriptedClass = { ...cls, spares: 1 };
    await at(0, withSpare);
    expect(attempted(await at(24, withSpare))).toBe(ATTEMPTS);
    expect(attempted(await at(25, withSpare))).toBe(0);

    landings.unshift(MIA);
    const restored = await at(26, withSpare);
    expect(restored.created.map((o) => o.colo)).toEqual([MIA]);
    expect(restored.spent).toHaveLength(ATTEMPTS);
    expect(await gaps()).toEqual([gap(MIA, 26, 26, "spares")]);
    expect(attempted(await at(27, withSpare))).toBe(ATTEMPTS);
  });

  // A base slot's gap stays a gap while the primary is elsewhere, so its
  // record stays and keeps its age. A record that has been attempted is not
  // young again when the primary returns: the gap had its first day.
  test("keeps an old gap old when the primary moves back into it", async () => {
    world.candidate(MIA, T0_MS);
    expect(attempted(await at(0))).toBe(ATTEMPTS);

    world.primary = { colo: ORD, region: "ENAM" };
    expect(attempted(await at(1))).toBe(0);
    expect(await gaps()).toEqual([gap(MIA, 0, 0)]);

    world.primary = { colo: MIA, region: "ENAM" };
    expect(attempted(await at(30))).toBe(ATTEMPTS);
    expect(attempted(await at(31))).toBe(0);
    expect(await gaps()).toEqual([gap(MIA, 0, 30)]);
  });

  // A record with no attempt since it began has paced no attempts, so the
  // first pass that can make one starts it over, and the gap gets its young
  // day of attempts from then.
  test("starts over a record with no attempt once the primary is in its colo", async () => {
    world.candidate(MIA, T0_MS - 48 * HOUR_MS);
    seedGap(gap(MIA, -48, null));
    world.primary = { colo: ORD, region: "ENAM" };
    expect(attempted(await at(0))).toBe(0);
    expect(await gaps()).toEqual([gap(MIA, -48, null)]);

    // The gap is young again from this pass, for its probes as for its
    // attempts, so the class probes through a hint that is waiting.
    world.creator
      .query(
        "INSERT OR REPLACE INTO follow_hint_wait (region_hint, wait_ms, due_at_ms) VALUES ('enam', ?, ?)",
      )
      .run(4 * HOUR_MS, T0_MS + 4 * HOUR_MS);
    world.primary = { colo: MIA, region: "ENAM" };
    const restarted = await at(1);
    expect(restarted.regionHintsProbed).toEqual(["enam"]);
    expect(attempted(restarted)).toBe(ATTEMPTS);
    expect(await gaps()).toEqual([gap(MIA, 1, 1)]);
    expect(attempted(await at(2))).toBe(ATTEMPTS);
  });

  // A primary whose region names no hint has no targeted attempt, so the
  // record its probe begins has none. Once the region names one, the attempts
  // start the record over, and the gap is young for them.
  test("starts over a probe's record once the primary's region names a hint", async () => {
    world.primary = { colo: MIA, region: "MARS" };
    expect(attempted(await at(0))).toBe(0);
    expect(await gaps()).toEqual([gap(MIA, 0, null)]);

    world.primary = { colo: MIA, region: "ENAM" };
    expect(attempted(await at(30))).toBe(ATTEMPTS);
    expect(await gaps()).toEqual([gap(MIA, 30, 30)]);
  });

  // The risk this guards: a pass that lost its lease writes the record
  // anyway, over one the pass now holding the lease wrote or deleted. The
  // record is written before the attempt it records, naming the lease, so
  // the write is refused, the pass makes no attempt, and it reports the lease
  // lost. The record its probe began, while it held the lease, stands.
  test("is not written by a pass that lost its lease before attempting", async () => {
    let stolen = false;
    world.afterBatch = () => {
      const { n } = world.creator
        .query(
          `SELECT count(*) AS n FROM follow_ledger WHERE kind = ${LEDGER_KIND.name_spent}`,
        )
        .get() as { n: number };
      if (!stolen && n === 1) {
        stolen = true;
        world.creator
          .query("UPDATE follow_pass SET holder = 'next-pass'")
          .run();
      }
    };
    const report = await at(0);
    expect(stolen).toBe(true);
    expect(attempted(report)).toBe(0);
    expect(report.leaseLost).toBe(true);
    expect(await gaps()).toEqual([gap(MIA, 0, null)]);
  });

  // An attempt is recorded before it is made, so a pass that stops after
  // attempting has already recorded it, and the next pass reads the gap's
  // pacing from it rather than from an older attempt.
  test("records an attempt before it is made", async () => {
    await at(0);
    await at(24);
    let seen: GapRecord[] = [];
    const watching: ScriptedClass = {
      ...cls,
      observe: async (name, hint) => {
        seen = await readGaps(world.handle());
        return await cls.observe(name, hint);
      },
    };
    await at(48, watching);
    expect(seen).toEqual([gap(MIA, 0, 48)]);
  });

  // The last attempt of a pass restores the slot while spares are still
  // short. No creation was made for the shortfall, so it has no record yet;
  // the next pass's probe and attempts at it begin one, young.
  test("begins no record for a kind of gap no attempt targeted", async () => {
    const withSpare: ScriptedClass = { ...cls, spares: 1 };
    landings.splice(ATTEMPTS, 0, MIA);
    const restored = await at(0, withSpare);
    expect(restored.created.map((o) => o.colo)).toEqual([MIA]);
    expect(attempted(restored)).toBe(ATTEMPTS);
    expect(await gaps()).toEqual([]);

    expect(attempted(await at(1, withSpare))).toBe(ATTEMPTS);
    expect(await gaps()).toEqual([gap(MIA, 1, 1, "spares")]);
  });

  // A filled gap's record is deleted in the batch that registers the slot
  // filling it, guarded on the lease: a pass that lost its lease just before
  // that batch deletes nothing the pass now holding the lease relies on, and
  // the delete itself reports the lease lost, so the pass says it stopped.
  test("is not deleted by a pass that lost its lease as its gap filled", async () => {
    await at(0);
    landings.unshift(MIA);
    let stolen = false;
    world.clock = T0_MS + HOUR_MS;
    const report = await world.pass(
      cls,
      { attemptsPerClassPerPass: ATTEMPTS, laneCodes: [] },
      (query) => {
        if (
          !stolen &&
          cls.placed.length === 1 &&
          query.startsWith("UPDATE follow_pass SET claimed_until_ms")
        ) {
          stolen = true;
          world.creator
            .query("UPDATE follow_pass SET holder = 'next-pass'")
            .run();
        }
      },
    );
    expect(stolen).toBe(true);
    expect(report.leaseLost).toBe(true);
    expect(await gaps()).toEqual([gap(MIA, 0, 0)]);
    expect(world.lines.filter((l) => l.includes("closed"))).toEqual([]);
  });

  // The risk this guards: a pass that registers the slot filling a gap and
  // then stops, leaving the gap's record, so the gap, reopened when that slot
  // leaves, starts old. The record goes in the registration's own batch.
  test("is deleted in the batch that registers the slot filling it", async () => {
    await at(0);
    landings.unshift(MIA);
    world.afterBatch = () => {
      if (cls.placed.length === 1) {
        world.afterBatch = undefined;
        world.creator
          .query("UPDATE follow_pass SET holder = 'next-pass'")
          .run();
      }
    };
    world.clock = T0_MS + HOUR_MS;
    const report = await world.pass(cls, {
      attemptsPerClassPerPass: ATTEMPTS,
      laneCodes: [],
    });
    expect(report.created.map((o) => o.colo)).toEqual([MIA]);
    expect(await gaps()).toEqual([]);
  });
});
