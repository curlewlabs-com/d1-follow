// The creator's creations: the probe each pass makes and what it learns, the
// attempts at a gap beside the primary with their bound (their pacing is
// creator-gaps.test.ts's), the region hints, and resolving an attempt whose
// answer was lost, in the world creator-test-harness.ts sets up.
import { beforeEach, describe, expect, test } from "bun:test";
import type { CreatorClass } from "./creator";
import { readCandidateColos, readRegionHints } from "./candidate-store";
import { readOpenIntents } from "./creator-store";
import { readGaps } from "./gap-store";
import {
  AMS,
  CreatorWorld,
  DEN,
  SCHEDULER,
  HOUR_MS,
  IAD,
  MIA,
  ORD,
  T0_MS,
  scriptedClass,
} from "./creator-test-harness";

let world: CreatorWorld;

beforeEach(async () => {
  world = await CreatorWorld.open();
});

describe("probing", () => {
  // Dry-run is the default: a class nobody set to act takes no number and
  // creates nothing, and says what it would have done.
  test("in dry-run, only says it would probe", async () => {
    const cls = scriptedClass([ORD]);
    const report = await world.pass(cls);
    expect(report.wouldCreate).toEqual([SCHEDULER]);
    expect(report.created).toEqual([]);
    expect(cls.where.size).toBe(0);
  });

  // The probe is the creator's only way to see where Cloudflare places
  // objects, so a class with no gap still makes one, and spends it when it
  // lands beside a slot the class has.
  test("probes once a pass, whatever the class's gaps", async () => {
    await world.act();
    await world.seed("scheduler-serving", ORD, T0_MS);
    const cls = scriptedClass([ORD, ORD]);
    cls.where.set("scheduler-serving", ORD);
    const report = await world.pass(cls);
    expect(report.spent).toEqual([
      { classCode: SCHEDULER, name: "scheduler-test-enam-1", colo: ORD },
    ]);
    expect(report.created).toEqual([]);
    expect(report.learnedColos).toEqual([]);
    expect(report.gaps).toEqual([]);
    expect(cls.where.size).toBe(2);
  });

  // The creator starts knowing no colo. A probe landing where none has landed
  // is how it learns Cloudflare places objects there, and the probe becomes
  // the class's slot there.
  test("keeps a probe that lands in a new colo, and learns the colo", async () => {
    await world.act();
    const cls = scriptedClass([DEN]);
    const report = await world.pass(cls);
    expect(report.created).toEqual([
      { classCode: SCHEDULER, name: "scheduler-test-enam-1", colo: DEN },
    ]);
    expect(cls.placed).toEqual(["scheduler-test-enam-1"]);
    expect(report.learnedColos).toEqual([DEN]);
    expect(report.candidateColos).toEqual([DEN]);
    expect(report.gaps).toEqual([]);
    expect(await readCandidateColos(world.handle())).toEqual([DEN]);
  });

  // A slot lost to a move is refilled by the probe that next lands in its
  // colo, with no list saying the colo is wanted.
  test("fills a gap in a candidate colo when a probe lands there", async () => {
    await world.act();
    await world.seed("scheduler-ord", ORD, T0_MS);
    await world.seed("scheduler-mia", MIA, T0_MS);
    const cls = scriptedClass([MIA]);
    cls.where.set("scheduler-ord", ORD);
    cls.where.set("scheduler-mia", IAD);
    const report = await world.pass(cls);
    expect(report.unregistered.map((o) => o.name)).toEqual(["scheduler-mia"]);
    expect(report.created).toEqual([
      { classCode: SCHEDULER, name: "scheduler-test-enam-1", colo: MIA },
    ]);
    expect(report.learnedColos).toEqual([]);
    expect(report.gaps).toEqual([]);
  });

  // The registered slots' colos are where objects have landed already, so
  // they are the set the creator starts from. One stays a candidate once its
  // slot leaves, or its gap would go unreported.
  test("keeps a registered slot's colo a candidate after the slot leaves", async () => {
    await world.seed("scheduler-ord", ORD, T0_MS - HOUR_MS);
    const cls = scriptedClass([]);
    cls.where.set("scheduler-ord", IAD);
    const moved = await world.pass(cls);
    expect(moved.unregistered.map((o) => o.name)).toEqual(["scheduler-ord"]);
    expect(moved.gaps).toEqual([{ classCode: SCHEDULER, colo: ORD }]);

    world.clock += HOUR_MS;
    const later = await world.pass(cls);
    expect(later.candidateColos).toEqual([ORD]);
    expect(later.gaps).toEqual([{ classCode: SCHEDULER, colo: ORD }]);
  });
});

describe("the primary's gap", () => {
  // Until a creation lands beside the primary, its colo has no slot to move
  // to, so it is reported as a gap. It is not kept as a candidate: only a
  // landing says Cloudflare places objects there.
  test("judges the primary's colo while it is no candidate", async () => {
    world.primary = { colo: DEN, region: "ENAM" };
    const report = await world.pass(scriptedClass([]));
    expect(report.candidateColos).toEqual([DEN]);
    expect(report.gaps).toEqual([{ classCode: SCHEDULER, colo: DEN }]);
    expect(await readCandidateColos(world.handle())).toEqual([]);
  });

  // A lost slot beside the primary is the one a move needs, so its gap gets
  // the class's attempts as well as the probe, until a landing fills it.
  test("attempts a gap in the primary's colo until one lands there", async () => {
    await world.act();
    world.primary = { colo: MIA, region: "ENAM" };
    await world.seed("scheduler-ord", ORD, T0_MS);
    const cls = scriptedClass([ORD, ORD, MIA, ORD]);
    cls.where.set("scheduler-ord", ORD);
    const report = await world.pass(cls);
    expect(report.spent.map((o) => o.name)).toEqual([
      "scheduler-test-enam-1",
      "scheduler-test-enam-2",
    ]);
    expect(report.created).toEqual([
      { classCode: SCHEDULER, name: "scheduler-test-enam-3", colo: MIA },
    ]);
    expect(report.gaps).toEqual([]);
  });

  // The cost bound is sized from the attempts per pass, so a pass whose
  // attempts at the gap land nothing useful stops there.
  test("makes no more attempts at it than a pass allows", async () => {
    await world.act();
    world.primary = { colo: MIA, region: "ENAM" };
    await world.seed("scheduler-ord", ORD, T0_MS);
    const cls = scriptedClass(Array.from({ length: 6 }, () => ORD));
    cls.where.set("scheduler-ord", ORD);
    const report = await world.pass(cls, { attemptsPerClassPerPass: 4 });
    expect(report.spent).toHaveLength(5);
    expect(report.created).toEqual([]);
  });
});

describe("region hints", () => {
  // A primary seen outside every region the creator probes would never get a
  // slot beside it through the app's hint. The hint for its region joins,
  // the colos its probes land in become candidates, and the primary's gap is
  // attempted through it.
  test("adds the hint for a region the primary is seen in, and keeps it", async () => {
    await world.act();
    world.primary = { colo: AMS, region: "WEUR" };
    await world.seed("scheduler-ord", ORD, T0_MS);
    const cls = scriptedClass([ORD, ORD], { weur: [DEN, AMS, AMS] });
    cls.where.set("scheduler-ord", ORD);
    const report = await world.pass(cls);
    expect(report.regionHintsAdded).toEqual(["weur"]);
    expect(report.regionHints).toEqual(["enam", "weur"]);
    expect(report.created).toEqual([
      { classCode: SCHEDULER, name: "scheduler-test-weur-2", colo: DEN },
      { classCode: SCHEDULER, name: "scheduler-test-weur-3", colo: AMS },
    ]);
    expect(report.learnedColos).toEqual([DEN, AMS]);
    expect(report.gaps).toEqual([]);

    // The primary may return, so the hint stays once it has been needed.
    world.clock += HOUR_MS;
    world.primary = { colo: ORD, region: "ENAM" };
    const back = await world.pass(cls);
    expect(back.regionHintsAdded).toEqual([]);
    expect(back.regionHints).toEqual(["enam", "weur"]);
    expect(back.spent.map((o) => o.name)).toEqual([
      "scheduler-test-enam-4",
      "scheduler-test-weur-5",
    ]);
  });

  // A region no hint names cannot be probed; guessing one would spend
  // creations for nothing, so the pass logs it and keeps its hints.
  test("adds no hint for a region that names none", async () => {
    world.primary = { colo: ORD, region: "MARS" };
    const report = await world.pass(scriptedClass([]));
    expect(report.regionHints).toEqual(["enam"]);
    expect(report.regionHintsAdded).toEqual([]);
    expect(await readRegionHints(world.handle())).toEqual([]);
  });

  // A primary whose region names no hint gives no hint to attempt its gap
  // through. Attempting through the app's own would be a guess that spends
  // the budget, and a record it began would age the gap before the right hint
  // could reach it; the probe still runs.
  test("attempts no gap beside a primary whose region names no hint", async () => {
    await world.act();
    world.primary = { colo: DEN, region: "MARS" };
    await world.seed("scheduler-ord", ORD, T0_MS);
    const cls = scriptedClass(Array.from({ length: 5 }, () => ORD));
    cls.where.set("scheduler-ord", ORD);
    const report = await world.pass(cls);
    expect(report.spent.map((o) => o.name)).toEqual(["scheduler-test-enam-1"]);
    expect(report.gaps).toEqual([{ classCode: SCHEDULER, colo: DEN }]);
    expect(await readGaps(world.handle())).toEqual([]);
  });

  // The primary read is the pass's first call on the app database; a failure
  // there costs the pass its sighting, and the probe still runs.
  test("probes when the primary cannot be read", async () => {
    await world.act();
    world.primary = "fails";
    const report = await world.pass(scriptedClass([ORD]));
    expect(report.primary).toBeNull();
    expect(report.failures).toEqual([
      "read where the app's primary is: D1 unavailable",
    ]);
    expect(report.created.map((o) => o.colo)).toEqual([ORD]);
  });
});

describe("attempts", () => {
  // A placed object the registry refuses (here, because another slot took
  // the colo first) would hold its marker forever outside every record, so it
  // is emptied, and its attempt stays open for a later pass.
  test("empties a placed object the registry refuses", async () => {
    await world.act();
    const cls = scriptedClass([ORD]);
    const racing: CreatorClass = {
      ...cls,
      place: async (name, colo, deadlineMs) => {
        await cls.place(name, colo, deadlineMs);
        await world.seed("scheduler-racer", colo, T0_MS);
      },
    };
    const report = await world.pass(racing, { attemptsPerClassPerPass: 1 });
    expect(report.created).toEqual([]);
    expect(cls.releasedNames).toEqual(["scheduler-test-enam-1"]);
    expect(report.failures).toHaveLength(1);
    expect(
      (await readOpenIntents(world.handle(), world.clock + 1)).map(
        (i) => i.name,
      ),
    ).toEqual(["scheduler-test-enam-1"]);
  });

  // An attempt resolved later may have been placed before its answer was
  // lost, so one that is not kept is emptied before it is recorded as spent.
  test("empties a resolved attempt before spending it", async () => {
    await world.act();
    const cls = scriptedClass([ORD, ORD]);
    const lost: CreatorClass = {
      ...cls,
      observe: async (name, hint) => {
        await cls.observe(name, hint);
        if (hint !== null) throw new Error("answer lost");
        return { colo: cls.where.get(name) ?? null, markedColo: null };
      },
    };
    await world.seed("scheduler-serving", ORD, T0_MS);
    cls.where.set("scheduler-serving", ORD);
    await world.pass(lost, { attemptsPerClassPerPass: 1 });

    world.clock += HOUR_MS;
    const resolved = await world.pass(cls, { attemptsPerClassPerPass: 1 });
    // The second is this pass's own probe, spent beside the serving slot
    // without being emptied, since it was never placed.
    expect(resolved.spent.map((o) => o.name)).toEqual([
      "scheduler-test-enam-1",
      "scheduler-test-enam-2",
    ]);
    expect(cls.releasedNames).toEqual(["scheduler-test-enam-1"]);
  });

  // Both cleanups empty an object the creator minted and never registered,
  // and an app may still protect such a name. The keep list that guards the
  // release step guards them too: a protected name is never emptied, and its
  // attempt stays open rather than being recorded as spent.
  test("empties no protected name when the registry refuses it", async () => {
    await world.act();
    const cls = scriptedClass([ORD]);
    const racing: CreatorClass = {
      ...cls,
      place: async (name, colo, deadlineMs) => {
        await cls.place(name, colo, deadlineMs);
        await world.seed("scheduler-racer", colo, T0_MS);
      },
    };
    const report = await world.pass(racing, {
      attemptsPerClassPerPass: 1,
      protectedNames: new Set(["scheduler-test-enam-1"]),
    });
    expect(cls.releasedNames).toEqual([]);
    expect(
      (await readOpenIntents(world.handle(), world.clock + 1)).map(
        (i) => i.name,
      ),
    ).toEqual(["scheduler-test-enam-1"]);
    expect(report.created).toEqual([]);
  });

  test("leaves a resolved attempt open when its name holds a lane", async () => {
    await world.act();
    const cls = scriptedClass([ORD, ORD]);
    const lost: CreatorClass = {
      ...cls,
      observe: async (name, hint) => {
        await cls.observe(name, hint);
        if (hint !== null) throw new Error("answer lost");
        return { colo: cls.where.get(name) ?? null, markedColo: null };
      },
    };
    await world.seed("scheduler-serving", ORD, T0_MS);
    cls.where.set("scheduler-serving", ORD);
    await world.pass(lost, { attemptsPerClassPerPass: 1 });
    world.app
      .query(
        "INSERT INTO follow_lane (lane, holder, seq, changed_at_ms, changed_by) VALUES (1, 'scheduler-test-enam-1', 1, 0, 3)",
      )
      .run();

    world.clock += HOUR_MS;
    const resolved = await world.pass(cls, { attemptsPerClassPerPass: 1 });
    expect(cls.releasedNames).toEqual([]);
    expect(resolved.spent.map((o) => o.name)).not.toContain(
      "scheduler-test-enam-1",
    );
    expect(
      (await readOpenIntents(world.handle(), world.clock + 1)).map(
        (i) => i.name,
      ),
    ).toEqual(["scheduler-test-enam-1"]);
  });

  // Through an outage every attempt's answer is lost. Resolutions share the
  // pass's budget with attempts at the primary's gap, so the calls stay at one
  // pass's budget, and a class with attempts still open starts no new ones,
  // not even its probes, so the backlog does not grow either, even when the
  // budget has room for more.
  test("keeps the backlog and the calls bounded through an outage", async () => {
    await world.act();
    world.primary = { colo: MIA, region: "ENAM" };
    let calls = 0;
    const down: CreatorClass = {
      ...scriptedClass([]),
      observe: async () => {
        calls++;
        throw new Error("down");
      },
    };
    await world.pass(down, { attemptsPerClassPerPass: 2 });
    for (let n = 0; n < 3; n++) {
      // Past any gap's wait, with room in the budget for new attempts.
      world.clock += 24 * HOUR_MS;
      calls = 0;
      await world.pass(down, { attemptsPerClassPerPass: 4 });
      expect(calls).toBe(3);
    }
    expect(await readOpenIntents(world.handle(), world.clock)).toHaveLength(3);
  });

  // A backlog larger than the budget is worked through a budget at a time,
  // never re-observed all at once.
  test("resolves no more open attempts in a pass than its budget", async () => {
    await world.act();
    world.primary = { colo: MIA, region: "ENAM" };
    let calls = 0;
    const down: CreatorClass = {
      ...scriptedClass([]),
      observe: async () => {
        calls++;
        throw new Error("down");
      },
    };
    await world.pass(down, { attemptsPerClassPerPass: 4 });
    world.clock += 24 * HOUR_MS;
    calls = 0;
    await world.pass(down, { attemptsPerClassPerPass: 2 });
    expect(calls).toBe(2);
  });

  // An answer lost on the way back leaves the attempt open; a later pass asks
  // the name where it landed and records the outcome then.
  test("resolves an attempt whose answer was lost", async () => {
    await world.act();
    const cls = scriptedClass([ORD, ORD]);
    const flaky: CreatorClass = {
      ...cls,
      observe: async (name, hint) => {
        await cls.observe(name, hint);
        if (hint !== null) throw new Error("answer lost");
        return { colo: cls.where.get(name) ?? null, markedColo: null };
      },
    };
    const lost = await world.pass(flaky, { attemptsPerClassPerPass: 1 });
    expect(lost.created).toEqual([]);
    expect(await readOpenIntents(world.handle(), world.clock + 1)).toHaveLength(
      1,
    );

    world.clock += HOUR_MS;
    const resolved = await world.pass(cls, { attemptsPerClassPerPass: 1 });
    expect(resolved.created.map((o) => o.name)).toEqual([
      "scheduler-test-enam-1",
    ]);
    expect(await readOpenIntents(world.handle(), world.clock + 1)).toEqual([]);
  });
});
