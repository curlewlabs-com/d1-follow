// How the pass paces its probes through each region hint: in the hint's
// rounds, whose wait doubles while they teach nothing; on every pass while the
// class has a young gap; and every wait ended by a creation that lands in a
// new colo. In the world creator-test-harness.ts sets up, with hourly passes
// and a cap of a day.
import { beforeEach, describe, expect, test } from "bun:test";
import { readCandidateColos } from "./candidate-store";
import type { Colo } from "./colo";
import type { CreatorClass, CreatorPassReport } from "./creator";
import { LEDGER_KIND, registerSlot, setMode } from "./creator-store";
import {
  AMS,
  CreatorWorld,
  DEN,
  HOUR_MS,
  IAD,
  MIA,
  ORD,
  SCHEDULER,
  T0_MS,
  scriptedClass,
  type ScriptedClass,
} from "./creator-test-harness";
import { readGaps } from "./gap-store";
import { readHintWaits, type HintWait } from "./hint-wait-store";

const WORKER = 2;

let world: CreatorWorld;
let cls: ScriptedClass;

// The class keeps its one slot in ORD, where the primary is and where every
// probe lands, so it has no gap and probes only in the hints' rounds.
beforeEach(async () => {
  world = await CreatorWorld.open();
  await world.act();
  world.primary = { colo: ORD, region: "ENAM" };
  world.candidate(ORD, T0_MS - 48 * HOUR_MS);
  await world.seed("scheduler-ord", ORD, T0_MS);
  cls = scriptedClass(Array.from({ length: 400 }, () => ORD));
  cls.where.set("scheduler-ord", ORD);
});

// A pass `hours` after T0.
async function at(
  hours: number,
  classes: readonly CreatorClass[] = [cls],
): Promise<CreatorPassReport> {
  world.clock = T0_MS + hours * HOUR_MS;
  return await world.pass(cls, { classes, laneCodes: [] });
}

const wait = (
  regionHint: string,
  waitHours: number,
  dueHours: number,
): HintWait => ({
  regionHint,
  waitMs: waitHours * HOUR_MS,
  dueAtMs: T0_MS + dueHours * HOUR_MS,
});

// A wait as an earlier pass left it: the store's own write takes the pass
// lease, which no pass holds between passes.
function seedWait(w: HintWait): void {
  world.creator
    .query(
      "INSERT OR REPLACE INTO follow_hint_wait (region_hint, wait_ms, due_at_ms) VALUES (?, ?, ?)",
    )
    .run(w.regionHint, w.waitMs, w.dueAtMs);
}

function seedHint(regionHint: string): void {
  world.creator
    .query(
      "INSERT INTO follow_region_hint (region_hint, added_at_ms) VALUES (?, ?)",
    )
    .run(regionHint, T0_MS - 48 * HOUR_MS);
}

const waits = async (): Promise<HintWait[]> =>
  await readHintWaits(world.handle());

// A second class, with its own code and names, whose probes land in
// `landings`; its slot in ORD is seeded, and it acts unless `mode` says not.
async function worker(
  landings: Colo[],
  mode: "act" | "dry_run" = "act",
): Promise<ScriptedClass> {
  const base = scriptedClass(landings);
  const other: ScriptedClass = {
    ...base,
    code: WORKER,
    label: "worker",
    nameOf: (n, hint) => `worker-test-${hint}-${n}`,
  };
  await registerSlot(
    world.handle(),
    {
      classCode: WORKER,
      colo: ORD,
      name: "worker-ord",
      objectId: "id-worker-ord",
      registeredAtMs: T0_MS - 3 * HOUR_MS,
      verifiedAtMs: T0_MS,
    },
    { opId: "seed-worker-ord", kind: "seeded" },
  );
  other.where.set("worker-ord", ORD);
  await setMode(world.handle(), {
    kind: "class",
    code: WORKER,
    mode,
    opId: `mode-${WORKER}`,
    atMs: T0_MS,
  });
  return other;
}

describe("rounds", () => {
  // A hint whose probes keep landing where the creator already has slots
  // waits longer each round, from a single skipped pass up to the cap, so a
  // steady day costs about one round per hint.
  test("doubles a hint's wait each round that taught nothing, up to the cap", async () => {
    const rounds: number[] = [];
    for (let hour = 0; hour <= 80; hour++) {
      if ((await at(hour)).regionHintsProbed.length > 0) rounds.push(hour);
    }
    expect(rounds).toEqual([0, 2, 6, 14, 30, 54, 78]);
    expect(await waits()).toEqual([wait("enam", 24, 102)]);
    expect(world.lines).toContain(
      `[follow] region hint enam's round taught nothing - its next round is a pass from ${new Date(T0_MS + 1.5 * HOUR_MS).toISOString()}`,
    );
  });

  // Between rounds the pass probes through nothing, but its report still
  // lists the hints the creator holds, and its log says when the next round
  // is due.
  test("probes through no waiting hint for a class with no young gap", async () => {
    await at(0);
    const waiting = await at(1);
    expect(waiting.regionHints).toEqual(["enam"]);
    expect(waiting.regionHintsProbed).toEqual([]);
    expect(waiting.spent).toEqual([]);
    expect(world.lines).toContain(
      `[follow] region hint enam waits - its next round is a pass from ${new Date(T0_MS + 1.5 * HOUR_MS).toISOString()}`,
    );
    expect(await waits()).toEqual([wait("enam", 2, 2)]);
  });

  // A cron that fires twice runs two passes in an hour: the second finds the
  // wait the first wrote, or, when the first wrote none, probes again.
  test("two passes in an hour: the second waits, or probes when no wait was written", async () => {
    await at(0);
    expect((await at(0.5)).regionHintsProbed).toEqual([]);

    const nowhere: ScriptedClass = {
      ...cls,
      observe: (name, hint) =>
        hint === null
          ? cls.observe(name, hint)
          : Promise.resolve({ colo: null, markedColo: null }),
    };
    world.creator.query("DELETE FROM follow_hint_wait").run();
    await at(1, [nowhere]);
    expect(await waits()).toEqual([]);
    expect((await at(1.5, [nowhere])).regionHintsProbed).toEqual(["enam"]);
  });

  // The risk this guards: a probe that could not say where it landed taken
  // for one that landed somewhere known, which would slow the probes on no
  // evidence. It counts for nothing, so the round leaves the wait as it was.
  test("leaves the wait as it was after a round with no usable answer", async () => {
    seedWait(wait("enam", 4, 0));
    const nowhere: ScriptedClass = {
      ...cls,
      observe: () => Promise.resolve({ colo: null, markedColo: null }),
    };
    const round = await at(0, [nowhere]);
    expect(round.regionHintsProbed).toEqual(["enam"]);
    expect(round.spent.map((o) => o.colo)).toEqual([null]);
    expect(await waits()).toEqual([wait("enam", 4, 0)]);
  });

  // A probe whose answer was lost stays open, and counts for nothing in its
  // round whatever a later pass finds; the class behind it makes no probe
  // until it resolves, so its next pass is no round either.
  test("counts a probe left open for nothing, and a class behind it probes nothing", async () => {
    const lost: ScriptedClass = {
      ...cls,
      observe: (name, hint) =>
        name === "scheduler-ord"
          ? cls.observe(name, hint)
          : Promise.reject(new Error("answer lost")),
    };
    expect((await at(0, [lost])).failures).toHaveLength(1);
    expect(await waits()).toEqual([]);
    const blocked = await at(1, [lost]);
    expect(blocked.regionHintsProbed).toEqual([]);
    expect(await waits()).toEqual([]);
  });

  // One class's probe that answers with no colo, beside another's that
  // answers from a known colo: the round taught nothing, and its wait
  // doubles. A class behind an open attempt adds nothing to the round.
  test("doubles the wait on a usable answer beside one with no colo", async () => {
    const other = await worker([ORD]);
    const nowhere: ScriptedClass = {
      ...cls,
      observe: () => Promise.resolve({ colo: null, markedColo: null }),
    };
    const round = await at(0, [nowhere, other]);
    expect(round.spent.map((o) => o.colo)).toEqual([null, ORD]);
    expect(await waits()).toEqual([wait("enam", 2, 2)]);
  });

  // The risk this guards: a colo learned partway through a pass opening the
  // waiting hints for the classes after it but not those before, so classes
  // are paced unalike in one pass. Which hints are in their round is read
  // once; the learned colo still deletes every wait for the next pass.
  test("keeps the pass's rounds as they began when a class learns a colo", async () => {
    seedHint("weur");
    seedWait(wait("weur", 4, 3));
    const other = await worker([DEN]);
    const report = await at(0, [cls, other]);
    expect(report.learnedColos).toEqual([DEN]);
    expect(report.regionHintsProbed).toEqual(["enam"]);
    expect(report.failures).toEqual([]);
    expect(await waits()).toEqual([]);
  });

  // Dry-run makes no probe and writes no wait; it says what it would probe
  // through. The class beside it that acts makes the round.
  test("lets a class in dry-run beside one that acts leave the round to it", async () => {
    const dry = await worker([ORD], "dry_run");
    const round = await at(0, [cls, dry]);
    expect(round.spent.map((o) => o.classCode)).toEqual([SCHEDULER]);
    expect(round.wouldCreate).toEqual([WORKER]);
    expect(world.lines).toContain(
      "[follow] worker dry-run - would probe through enam",
    );
    expect(await waits()).toEqual([wait("enam", 2, 2)]);

    const waiting = await at(1, [cls, dry]);
    expect(world.lines).toContain(
      "[follow] worker dry-run - would probe through no hint",
    );
    expect(waiting.wouldCreate).toEqual([]);
  });

  // The app's own hint is whatever its configuration says, and the pass hands
  // it to the app's calls as it is, so its wait is kept under that same key.
  test("keeps the wait of an app hint in the form the app gives it", async () => {
    world.clock = T0_MS;
    const report = await world.pass(cls, { regionHint: "ENAM", laneCodes: [] });
    expect(report.failures).toEqual([]);
    expect(report.regionHints).toEqual(["ENAM", "enam"]);
    expect(await waits()).toEqual([wait("ENAM", 2, 2), wait("enam", 2, 2)]);
  });

  // A class with attempts open creates nothing until they resolve, so its
  // dry-run forecast says so and does not count it as one that would create.
  test("forecasts a dry-run class behind open attempts as conditional", async () => {
    world.creator
      .query(
        "INSERT INTO follow_open_intent (op_id, class_code, name, at_ms) VALUES ('op-open', ?, 'scheduler-test-enam-9', ?)",
      )
      .run(SCHEDULER, T0_MS - HOUR_MS);
    await setMode(world.handle(), {
      kind: "class",
      code: SCHEDULER,
      mode: "dry_run",
      opId: "dry",
      atMs: T0_MS,
    });
    const report = await at(0);
    expect(report.wouldCreate).toEqual([]);
    expect(world.lines).toContain(
      "[follow] scheduler dry-run - would resolve its open attempts first, then probe through enam",
    );
  });

  // The risk this guards: a probe whose outcome was never recorded, its
  // intent left open, taken for a round's usable answer, which would slow the
  // probes on an answer the pass did not keep.
  test("counts a probe whose outcome was not recorded for nothing", async () => {
    world.candidate(IAD, T0_MS - 48 * HOUR_MS);
    const unplaced: ScriptedClass = {
      ...scriptedClass([IAD]),
      place: () => Promise.reject(new Error("refused")),
    };
    unplaced.where.set("scheduler-ord", ORD);
    const report = await at(0, [unplaced]);
    expect(report.regionHintsProbed).toEqual(["enam"]);
    expect(report.failures).toEqual(["create scheduler-test-enam-1: refused"]);
    expect(await waits()).toEqual([]);
  });

  // The cap is a number of milliseconds, and the table holds whole ones, so
  // a cap with a fraction still writes a wait the schema takes.
  test("writes a whole-millisecond wait under a fractional cap", async () => {
    world.clock = T0_MS;
    const report = await world.pass(cls, {
      maxBackoffMs: 6_300_000.5,
      laneCodes: [],
    });
    expect(report.failures).toEqual([]);
    expect(await waits()).toEqual([
      { regionHint: "enam", waitMs: 6_300_000, dueAtMs: T0_MS + 6_300_000 },
    ]);
  });

  // With every class in dry-run nothing is probed, so nothing moves the
  // wait, a wait the pass could not trust included.
  test("writes no wait in a pass where every class is in dry-run", async () => {
    seedWait(wait("enam", 48, 0));
    await setMode(world.handle(), {
      kind: "class",
      code: SCHEDULER,
      mode: "dry_run",
      opId: "dry",
      atMs: T0_MS,
    });
    const report = await at(0);
    expect(report.regionHintsProbed).toEqual([]);
    expect(report.wouldCreate).toEqual([SCHEDULER]);
    expect(world.lines).toContain(
      "[follow] scheduler dry-run - would probe through enam",
    );
    expect(await waits()).toEqual([wait("enam", 48, 0)]);
  });

  // Dry-run writes none of the pacing's state. A pass in which no class acts
  // still records a registered slot's colo as a candidate, so the colo is not
  // lost if the slot then leaves, but it ends no wait, and says so as a
  // failure. The first pass in which a class acts finds each wait set before
  // the colo joined, drops it, and opens the round.
  test("records a colo but ends no wait in a pass where every class is in dry-run", async () => {
    seedWait(wait("enam", 4, 3));
    await world.seed("scheduler-den", DEN, T0_MS);
    cls.where.set("scheduler-den", DEN);
    await setMode(world.handle(), {
      kind: "class",
      code: SCHEDULER,
      mode: "dry_run",
      opId: "dry",
      atMs: T0_MS,
    });
    const dry = await at(0);
    expect(dry.failures).toEqual([
      "dry-run - candidate colo DEN added, where a slot is registered, and every hint's wait left as it was: dry-run writes no pacing state",
    ]);
    expect(dry.learnedColos).toEqual([]);
    expect(await readCandidateColos(world.handle())).toEqual([ORD, DEN]);
    expect(await waits()).toEqual([wait("enam", 4, 3)]);

    await world.act();
    const acting = await at(1);
    expect(acting.failures).toEqual([]);
    expect(acting.regionHintsProbed).toEqual(["enam"]);
    expect(await waits()).toEqual([wait("enam", 2, 3)]);
  });

  // The risk this guards: a wait of a hint the creator no longer probes
  // through, such as an app hint the configuration has since changed,
  // standing until that hint comes back and then holding back its first
  // round. A pass in which a class acts deletes it.
  test("deletes the wait of a hint the creator no longer holds", async () => {
    seedWait(wait("wnam", 4, 3));
    await at(0);
    expect(await waits()).toEqual([wait("enam", 2, 2)]);
    expect(world.lines).toContain(
      "[follow] region hint wnam's wait deleted - the creator no longer probes through it",
    );
  });

  // A creation whose intent could not be written was never made, so it
  // begins no gap's record: the gap stays one no pass has created for.
  test("begins no gap record for a creation whose intent was not written", async () => {
    world.primary = { colo: MIA, region: "ENAM" };
    const nameless: ScriptedClass = {
      ...cls,
      nameOf: () => {
        throw new Error("no name");
      },
    };
    await expect(at(0, [nameless])).rejects.toThrow("no name");
    expect(await readGaps(world.handle())).toEqual([]);
  });

  // The risk this guards: a pass stopping after a creation filled a gap but
  // before the class's turn ended would leave the gap's old record, so the
  // gap, reopened later, would start old. The creation settles the record at
  // once.
  test("deletes a gap's record as soon as a creation fills it", async () => {
    seedHint("weur");
    world.candidate(IAD, T0_MS - 48 * HOUR_MS);
    world.creator
      .query(
        "INSERT INTO follow_gap (class_code, colo, kind, begun_at_ms, attempted_at_ms) VALUES (?, 'IAD', 1, ?, NULL)",
      )
      .run(SCHEDULER, T0_MS - 48 * HOUR_MS);
    const filling = scriptedClass([ORD], { enam: [IAD], weur: [ORD] });
    filling.where.set("scheduler-ord", ORD);
    const stopping: ScriptedClass = {
      ...filling,
      observe: async (name, hint) => {
        if (hint === "weur") {
          world.creator
            .query("UPDATE follow_pass SET holder = 'next-pass'")
            .run();
        }
        return await filling.observe(name, hint);
      },
    };
    const report = await at(0, [stopping]);
    expect(report.created.map((o) => o.colo)).toEqual([IAD]);
    expect(report.leaseLost).toBe(true);
    expect(await readGaps(world.handle())).toEqual([]);
  });

  // A fresh creator starts in dry-run with its slots registered and no wait
  // anywhere, so recording their colos leaves nothing standing, and is no
  // failure: the failure list stays a signal during normal setup.
  test("records a colo in dry-run with no failure while no wait stands", async () => {
    await world.seed("scheduler-den", DEN, T0_MS);
    cls.where.set("scheduler-den", DEN);
    await setMode(world.handle(), {
      kind: "class",
      code: SCHEDULER,
      mode: "dry_run",
      opId: "dry",
      atMs: T0_MS,
    });
    const dry = await at(0);
    expect(dry.failures).toEqual([]);
    expect(await readCandidateColos(world.handle())).toEqual([ORD, DEN]);
    expect(world.lines).toContain(
      "[follow] candidate colo DEN added - a slot is registered there",
    );
  });

  // A hint the primary's region has just named has no wait, so its first
  // pass is a round, whatever the other hints' waits.
  test("probes through a hint just added on its first pass", async () => {
    seedWait(wait("enam", 4, 3));
    world.candidate(AMS, T0_MS - 48 * HOUR_MS);
    await world.seed("scheduler-ams", AMS, T0_MS);
    cls.where.set("scheduler-ams", AMS);
    world.primary = { colo: AMS, region: "WEUR" };
    const report = await at(0);
    expect(report.regionHintsAdded).toEqual(["weur"]);
    expect(report.regionHints).toEqual(["enam", "weur"]);
    expect(report.regionHintsProbed).toEqual(["weur"]);
    expect(await waits()).toEqual([wait("enam", 4, 3), wait("weur", 2, 2)]);
  });
});

describe("a cap that paces nothing", () => {
  // A cap no longer than a pass and a half paces nothing, since even a wait
  // of the whole cap would end by the next pass: every pass is a round and no
  // wait is written, so a cap of zero cannot write a wait the schema refuses,
  // a cron that fires twice in a pass probes on both, and no pass rewrites a
  // wait that skips nothing.
  test.each([
    ["of zero", 0],
    ["of one pass", HOUR_MS],
    ["of a pass and a half", 1.5 * HOUR_MS],
  ])("probes on every pass under a cap %s", async (_, capMs) => {
    for (const hours of [0, 0.5, 1]) {
      world.clock = T0_MS + hours * HOUR_MS;
      const report = await world.pass(cls, {
        maxBackoffMs: capMs,
        laneCodes: [],
      });
      expect(report.regionHintsProbed).toEqual(["enam"]);
      expect(report.failures).toEqual([]);
    }
    expect(await waits()).toEqual([]);
  });

  // Just past that boundary the first wait skips the next pass.
  test("skips a pass under a cap just over a pass and a half", async () => {
    const probedAt = async (hours: number): Promise<readonly string[]> => {
      world.clock = T0_MS + hours * HOUR_MS;
      return (
        await world.pass(cls, { maxBackoffMs: 1.75 * HOUR_MS, laneCodes: [] })
      ).regionHintsProbed;
    };
    expect(await probedAt(0)).toEqual(["enam"]);
    expect(await probedAt(1)).toEqual([]);
    expect(await probedAt(2)).toEqual(["enam"]);
    expect(await waits()).toEqual([
      {
        regionHint: "enam",
        waitMs: 1.75 * HOUR_MS,
        dueAtMs: T0_MS + 3.75 * HOUR_MS,
      },
    ]);
  });
});

describe("a cap lowered to one pass and raised again", () => {
  // The risk this guards: a wait set under a day's cap outliving a cap
  // lowered to one pass, so that raising the cap again resumes a schedule
  // the lower cap discarded. Longer than the cap, it is dropped.
  test("drops a wait longer than the lowered cap", async () => {
    await at(0);
    expect(await waits()).toEqual([wait("enam", 2, 2)]);
    world.clock = T0_MS + HOUR_MS;
    const lowered = await world.pass(cls, {
      maxBackoffMs: HOUR_MS,
      laneCodes: [],
    });
    expect(lowered.regionHintsProbed).toEqual(["enam"]);
    expect(await waits()).toEqual([]);
    expect((await at(1.5)).regionHintsProbed).toEqual(["enam"]);
  });
});

describe("a cap lowered while no class can probe", () => {
  // A wait longer than a lowered cap is dropped by a pass in which a class
  // acts, even one whose open attempt keeps it from probing, so raising the
  // cap again once the attempt resolves does not revive the old wait.
  test("drops the wait, and the restored cap starts from none", async () => {
    const lost: ScriptedClass = {
      ...cls,
      observe: (name, hint) =>
        name === "scheduler-ord"
          ? cls.observe(name, hint)
          : Promise.reject(new Error("answer lost")),
    };
    await at(0, [lost]);
    seedWait(wait("enam", 24, 20));
    world.clock = T0_MS + HOUR_MS;
    const blocked = await world.pass(lost, {
      maxBackoffMs: HOUR_MS,
      laneCodes: [],
    });
    expect(blocked.regionHintsProbed).toEqual([]);
    expect(await waits()).toEqual([]);
    expect((await at(2)).regionHintsProbed).toEqual(["enam"]);
  });
});

describe("a wait the pass cannot trust", () => {
  // The risk this guards: a cap since lowered, a clock that ran backward or a
  // hand edit leaves a wait that would hold the probes back for as long as it
  // says. It is dropped and the round runs.
  test.each([
    ["is longer than the cap", wait("enam", 48, 1)],
    ["is due further ahead than its own length", wait("enam", 2, 5)],
  ])("drops a wait that %s, and probes", async (_, w) => {
    seedWait(w);
    expect((await at(0)).regionHintsProbed).toEqual(["enam"]);
    expect(await waits()).toEqual([wait("enam", 2, 2)]);
  });

  // When the round that drops it has no usable answer, nothing replaces it,
  // and it is deleted rather than read again.
  test("deletes it when no round replaces it", async () => {
    seedWait(wait("enam", 48, 1));
    const nowhere: ScriptedClass = {
      ...cls,
      observe: () => Promise.resolve({ colo: null, markedColo: null }),
    };
    await at(0, [nowhere]);
    expect(await waits()).toEqual([]);
    expect(world.lines).toContain(
      "[follow] region hint enam's wait cannot be trusted - deleted",
    );
  });
});

describe("a new colo", () => {
  beforeEach(() => {
    seedHint("weur");
  });

  // Somewhere new says the hints have more to teach, so a probe landing in a
  // colo no creation had reached ends every hint's wait, and the pass that
  // learned it writes none, though its other rounds taught nothing.
  test("from a probe ends every hint's wait", async () => {
    seedWait(wait("enam", 4, 0));
    seedWait(wait("weur", 2, 0));
    const learning = scriptedClass([ORD], { enam: [DEN], weur: [ORD] });
    learning.where.set("scheduler-ord", ORD);
    const report = await at(0, [learning]);
    expect(report.learnedColos).toEqual([DEN]);
    expect(report.regionHintsProbed).toEqual(["enam", "weur"]);
    expect(await waits()).toEqual([]);
  });

  // An attempt beside the primary that lands somewhere new ends the waits
  // too, and the round its class's probe made, which taught nothing, writes
  // no wait after it.
  test("from an attempt ends every hint's wait, and the pass writes none", async () => {
    seedWait(wait("enam", 4, 0));
    seedWait(wait("weur", 2, 10));
    world.primary = { colo: MIA, region: "ENAM" };
    const learning = scriptedClass([ORD], { enam: [ORD, DEN], weur: [ORD] });
    learning.where.set("scheduler-ord", ORD);
    const report = await world.pass(learning, {
      attemptsPerClassPerPass: 1,
      laneCodes: [],
    });
    expect(report.learnedColos).toEqual([DEN]);
    expect(report.spent.map((o) => o.colo)).toEqual([ORD, ORD]);
    expect(await waits()).toEqual([]);
  });

  // A probe whose answer was lost and which a later pass finds in a new colo
  // was still a creation that landed there.
  test("from a late resolution ends every hint's wait", async () => {
    let lost = true;
    const late: ScriptedClass = {
      ...cls,
      observe: async (name, hint) => {
        if (!lost || hint === null) return await cls.observe(name, hint);
        lost = false;
        cls.where.set(name, DEN);
        throw new Error("answer lost");
      },
    };
    await at(0, [late]);
    seedWait(wait("enam", 4, 5));
    seedWait(wait("weur", 4, 5));
    const report = await at(1, [late]);
    expect(report.learnedColos).toEqual([DEN]);
    expect(await waits()).toEqual([]);
  });

  // The risk this guards: a pass that stops between adding the colo and
  // deleting the waits, leaving the hints waiting after a probe found
  // somewhere new. Both are one batch, so a pass that loses its lease right
  // after learning leaves no wait standing.
  test("leaves no wait standing when the pass stops right after learning it", async () => {
    seedWait(wait("enam", 4, 0));
    seedWait(wait("weur", 4, 10));
    const learning = scriptedClass([ORD], { enam: [DEN] });
    learning.where.set("scheduler-ord", ORD);
    world.afterBatch = () => {
      const learned = world.creator
        .query("SELECT 1 FROM follow_colo WHERE colo = 'DEN'")
        .get();
      if (learned !== null) {
        world.afterBatch = undefined;
        world.creator
          .query("UPDATE follow_pass SET holder = 'next-pass'")
          .run();
      }
    };
    const report = await at(0, [learning]);
    expect(report.leaseLost).toBe(true);
    expect(await readCandidateColos(world.handle())).toContain(DEN);
    expect(await waits()).toEqual([]);
  });
});

describe("fenced by the lease", () => {
  // The risk this guards: a pass that stalled past its lease writes its
  // round's wait after the pass now holding the lease cleared the waits. The
  // write names the lease, so it is refused and the pass reports the lease
  // lost.
  test("a pass that lost its lease writes no wait", async () => {
    world.afterBatch = () => {
      const { n } = world.creator
        .query(
          `SELECT count(*) AS n FROM follow_ledger WHERE kind = ${LEDGER_KIND.name_spent}`,
        )
        .get() as { n: number };
      if (n === 1) {
        world.afterBatch = undefined;
        world.creator
          .query("UPDATE follow_pass SET holder = 'next-pass'")
          .run();
      }
    };
    const report = await at(0);
    expect(report.spent).toHaveLength(1);
    expect(report.leaseLost).toBe(true);
    expect(await waits()).toEqual([]);
  });

  // The risk this guards: the batch that adds a colo commits, deleting every
  // wait, and its answer is lost. The pass must still count the colo as added,
  // or it writes the waits of its other rounds again, and the next pass,
  // already knowing the colo, never deletes them.
  test("writes no wait after a colo add whose answer was lost", async () => {
    seedHint("weur");
    const learning = scriptedClass([ORD], { enam: [DEN], weur: [ORD] });
    learning.where.set("scheduler-ord", ORD);
    world.afterBatch = () => {
      const learned = world.creator
        .query("SELECT 1 FROM follow_colo WHERE colo = 'DEN'")
        .get();
      if (learned !== null) {
        world.afterBatch = undefined;
        throw new Error("answer lost");
      }
    };
    const report = await at(0, [learning]);
    expect(report.regionHintsProbed).toEqual(["enam", "weur"]);
    expect(await readCandidateColos(world.handle())).toContain(DEN);
    expect(await waits()).toEqual([]);
  });

  // The risk this guards: the stamp of a slot the pass has just registered
  // fails, and the pass, not counting the slot, takes its colo for a gap
  // still open, records it again and places a second base slot there. The
  // slot is held once registered, so the next landing there is spent.
  test("holds a registered slot whose stamp failed, and spends the next landing there", async () => {
    seedHint("weur");
    world.candidate(IAD, T0_MS - 48 * HOUR_MS);
    const filling = scriptedClass([ORD], { enam: [IAD], weur: [IAD] });
    filling.where.set("scheduler-ord", ORD);
    let batches = 0;
    world.afterBatch = () => {
      if (filling.placed.length !== 1) return;
      batches++;
      if (batches === 2) throw new Error("stamp lost");
    };
    const report = await at(0, [filling]);
    expect(report.failures).toEqual([
      "create scheduler-test-enam-1: stamp lost",
    ]);
    expect(report.spent.map((o) => o.colo)).toEqual([IAD]);
    const iad = world.creator
      .query("SELECT name FROM follow_slot WHERE colo = 'IAD'")
      .all();
    expect(iad).toEqual([{ name: "scheduler-test-enam-1" }]);
    expect(await readGaps(world.handle())).toEqual([]);
  });

  // A probe whose call was never made is no probe: a pass that loses its
  // lease before making one reports none.
  test("reports no probe a pass lost its lease before making", async () => {
    const stealing: ScriptedClass = {
      ...cls,
      observe: async (name, hint) => {
        if (name === "scheduler-ord") {
          world.creator
            .query("UPDATE follow_pass SET holder = 'next-pass'")
            .run();
        }
        return await cls.observe(name, hint);
      },
    };
    const report = await at(0, [stealing]);
    expect(report.leaseLost).toBe(true);
    expect(report.spent).toEqual([]);
    expect(report.regionHintsProbed).toEqual([]);
  });
});

describe("a young gap", () => {
  // A gap keeps its class probing through every hint on every pass for its
  // first day, whatever the hints' waits. Those probes are no round: they
  // leave the wait as it was.
  test("probes through a waiting hint without moving its wait", async () => {
    seedWait(wait("enam", 4, 3));
    world.primary = { colo: MIA, region: "ENAM" };
    const report = await world.pass(cls, {
      attemptsPerClassPerPass: 0,
      laneCodes: [],
    });
    expect(report.regionHintsProbed).toEqual(["enam"]);
    expect(report.spent.map((o) => o.colo)).toEqual([ORD]);
    expect(await waits()).toEqual([wait("enam", 4, 3)]);
    expect(await readGaps(world.handle())).toEqual([
      {
        classCode: SCHEDULER,
        colo: MIA,
        kind: "slot",
        begunAtMs: T0_MS,
        attemptedAtMs: null,
      },
    ]);
  });

  // A gap the probes have not filled in a day is old, and its class probes
  // only in the hints' rounds, as one with no gap does.
  test("probes only in the hint's round once old", async () => {
    world.primary = { colo: MIA, region: "MARS" };
    const probedAt = async (hours: number): Promise<readonly string[]> => {
      world.clock = T0_MS + hours * HOUR_MS;
      return (await world.pass(cls, { laneCodes: [] })).regionHintsProbed;
    };
    for (let hour = 0; hour < 24; hour++) {
      expect(await probedAt(hour)).toEqual(["enam"]);
    }
    expect(await probedAt(24)).toEqual([]);
    expect(await probedAt(30)).toEqual(["enam"]);
    expect(await probedAt(31)).toEqual([]);
  });
});
