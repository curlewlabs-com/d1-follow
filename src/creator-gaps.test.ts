// How the pass paces its attempts at the gap in the primary's colo by the
// gap's record: on every pass while the gap is young, then once a cap, and the
// record's life from the first attempt to the pass that sees the gap closed,
// in the world creator-test-harness.ts sets up. The cap is the harness's
// maxBackoffMs, a day, and passes are hourly.
import { beforeEach, describe, expect, test } from "bun:test";
import { addCandidateColo } from "./candidate-store";
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
import { readGaps, type GapRecord } from "./gap-store";

const ATTEMPTS = 2;
// What a pass creates: its probe through the one hint, and the attempts when
// they are due, each spent beside the class's slot in ORD.
const PROBE_ONLY = 1;
const ATTEMPTING = 1 + ATTEMPTS;

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
): GapRecord => ({
  classCode: SCHEDULER,
  colo,
  begunAtMs: T0_MS + begunHours * HOUR_MS,
  attemptedAtMs:
    attemptedHours === null ? null : T0_MS + attemptedHours * HOUR_MS,
});

// A record as some other build or a hand edit left it: the store's own write
// takes the pass lease, which no pass holds between passes.
function seedGap(record: GapRecord): void {
  world.creator
    .query(
      "INSERT INTO follow_gap (class_code, colo, begun_at_ms, attempted_at_ms) VALUES (?, ?, ?, ?)",
    )
    .run(record.classCode, record.colo, record.begunAtMs, record.attemptedAtMs);
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
      counts.push(creations(await at(hour)));
    }
    expect(counts.slice(0, 24)).toEqual(Array(24).fill(ATTEMPTING));
    expect(counts.slice(24, 47)).toEqual(Array(23).fill(PROBE_ONLY));
    expect(counts.slice(47)).toEqual([ATTEMPTING, PROBE_ONLY]);
    expect(await gaps()).toEqual([gap(MIA, 0, 47)]);
    expect(world.lines).toContain(
      `[follow] scheduler the gap in MIA is next attempted by a pass from ${new Date(T0_MS + 46.5 * HOUR_MS).toISOString()}`,
    );
  });

  // A cron that fires twice runs two passes in an hour. While the gap is
  // young both attempt, each within the attempts bound; once it is old the
  // second finds the first one's attempt and waits.
  test("two passes in an hour both attempt a young gap, and one an old", async () => {
    expect(creations(await at(0))).toBe(ATTEMPTING);
    expect(creations(await at(0.5))).toBe(ATTEMPTING);
    expect(creations(await at(24))).toBe(ATTEMPTING);
    expect(creations(await at(24.5))).toBe(PROBE_ONLY);
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
    expect(creations(await at(0))).toBe(ATTEMPTING);
    expect(await gaps()).toEqual([gap(MIA, 0, 0)]);
    expect(world.lines).toContain(
      "[follow] scheduler gap record in MIA cannot be trusted - dropped",
    );
  });

  // Dry-run and an attempt left open each stop a class creating, but the
  // gap's age is wall time from its first creation, so a class that comes
  // back after the cap finds the gap old. Dry-run writes none of the records
  // and logs what is due.
  test("lets a gap age while its class can create nothing", async () => {
    expect(creations(await at(0))).toBe(ATTEMPTING);
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
    expect(creations(await at(25))).toBe(ATTEMPTING);
    expect(creations(await at(26))).toBe(PROBE_ONLY);
    expect(await gaps()).toEqual([gap(MIA, 0, 25)]);

    await dryRun(27);
    expect(world.lines).toContain(
      `[follow] scheduler dry-run - would probe through enam; the gap in MIA is next attempted by a pass from ${new Date(T0_MS + 48.5 * HOUR_MS).toISOString()}`,
    );
    expect(await gaps()).toEqual([gap(MIA, 0, 25)]);
  });

  test("keeps a class with an attempt left open from attempting or writing its record", async () => {
    expect(creations(await at(0))).toBe(ATTEMPTING);
    const lost: ScriptedClass = {
      ...cls,
      observe: () => Promise.reject(new Error("answer lost")),
    };
    // The answers are lost, so this pass leaves its creations open.
    await at(1, lost);
    expect(await gaps()).toEqual([gap(MIA, 0, 1)]);
    const blocked = await at(2, lost);
    expect(creations(blocked)).toBe(0);
    expect(await gaps()).toEqual([gap(MIA, 0, 1)]);
  });
});

describe("the gap's record", () => {
  // A pass that cannot read where the primary is cannot say which colo the
  // attempts are for, nor whether a shortfall of spares is still one. It makes
  // no attempts and leaves the record as it is, even when its probe has filled
  // the colo; the next pass that reads the primary judges it.
  test("is left alone while the primary cannot be read", async () => {
    expect(creations(await at(0))).toBe(ATTEMPTING);
    world.primary = "fails";
    landings.unshift(MIA);
    const unread = await at(1);
    expect(creations(unread)).toBe(PROBE_ONLY);
    expect(unread.created.map((o) => o.colo)).toEqual([MIA]);
    expect(await gaps()).toEqual([gap(MIA, 0, 0)]);

    world.primary = { colo: MIA, region: "ENAM" };
    expect(creations(await at(2))).toBe(PROBE_ONLY);
    expect(await gaps()).toEqual([]);
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
    expect(creations(reopened)).toBe(ATTEMPTING);
    expect(await gaps()).toEqual([gap(MIA, 31, 31)]);
    expect(creations(await at(32))).toBe(ATTEMPTING);
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

    expect(creations(await at(0, withSpare))).toBe(ATTEMPTING);
    expect(await gaps()).toEqual([gap(ORD, 0, 0)]);

    world.primary = { colo: MIA, region: "ENAM" };
    await at(1, withSpare);
    expect(await gaps()).toEqual([gap(MIA, 1, 1)]);

    world.primary = { colo: ORD, region: "ENAM" };
    expect(creations(await at(30, withSpare))).toBe(ATTEMPTING);
    expect(await gaps()).toEqual([gap(ORD, 30, 30)]);
  });

  // A base slot's gap stays a gap while the primary is elsewhere, so its
  // record stays and keeps its age. A record that has been attempted is not
  // young again when the primary returns: the gap had its first day.
  test("keeps an old gap old when the primary moves back into it", async () => {
    await addCandidateColo(world.handle(), MIA, T0_MS);
    expect(creations(await at(0))).toBe(ATTEMPTING);

    world.primary = { colo: ORD, region: "ENAM" };
    expect(creations(await at(1))).toBe(PROBE_ONLY);
    expect(await gaps()).toEqual([gap(MIA, 0, 0)]);

    world.primary = { colo: MIA, region: "ENAM" };
    expect(creations(await at(30))).toBe(ATTEMPTING);
    expect(creations(await at(31))).toBe(PROBE_ONLY);
    expect(await gaps()).toEqual([gap(MIA, 0, 30)]);
  });

  // A record with no attempt since it began has paced no attempts, so the
  // first pass that can make one starts it over, and the gap gets its young
  // day of attempts from then.
  test("starts over a record with no attempt once the primary is in its colo", async () => {
    await addCandidateColo(world.handle(), MIA, T0_MS - 48 * HOUR_MS);
    seedGap(gap(MIA, -48, null));
    world.primary = { colo: ORD, region: "ENAM" };
    expect(creations(await at(0))).toBe(PROBE_ONLY);
    expect(await gaps()).toEqual([gap(MIA, -48, null)]);

    world.primary = { colo: MIA, region: "ENAM" };
    expect(creations(await at(1))).toBe(ATTEMPTING);
    expect(await gaps()).toEqual([gap(MIA, 1, 1)]);
    expect(creations(await at(2))).toBe(ATTEMPTING);
  });

  // A primary whose region names no hint has no targeted attempt, so nothing
  // begins the record. Once the region names one, the gap is new, and young.
  test("begins only once the primary's region names a hint", async () => {
    world.primary = { colo: MIA, region: "MARS" };
    expect(creations(await at(0))).toBe(PROBE_ONLY);
    expect(await gaps()).toEqual([]);

    world.primary = { colo: MIA, region: "ENAM" };
    expect(creations(await at(30))).toBe(ATTEMPTING);
    expect(await gaps()).toEqual([gap(MIA, 30, 30)]);
  });

  // The risk this guards: a pass that lost its lease after its last attempt
  // writes the record anyway, over one the pass now holding the lease wrote
  // or deleted. The write names the lease, so it is refused, and the pass
  // reports the lease lost.
  test("is not written by a pass that lost its lease after attempting", async () => {
    let stolen = false;
    world.afterBatch = () => {
      const { n } = world.creator
        .query(
          `SELECT count(*) AS n FROM follow_ledger WHERE kind = ${LEDGER_KIND.name_spent}`,
        )
        .get() as { n: number };
      if (!stolen && n === ATTEMPTING) {
        stolen = true;
        world.creator
          .query("UPDATE follow_pass SET holder = 'next-pass'")
          .run();
      }
    };
    const report = await at(0);
    expect(stolen).toBe(true);
    expect(creations(report)).toBe(ATTEMPTING);
    expect(report.leaseLost).toBe(true);
    expect(await gaps()).toEqual([]);
  });
});
