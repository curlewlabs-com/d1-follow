// The pass's observation of the spares, in the world creator-test-harness.ts
// sets up. A spare is the object a failover would go to, so a spare kept
// verified while it no longer holds its colo's marker is the failure these
// guard: an older build that does not read the spare table can empty one, and
// the emptied object still answers from its colo.
import { LANE_HANDOFF_SETTLE_MS } from "./lane";
import { beforeEach, describe, expect, test } from "bun:test";
import type { Colo } from "./colo";
import { readReleasePending } from "./creator-store";
import {
  CreatorWorld,
  SCHEDULER,
  HOUR_MS,
  IAD,
  MIA,
  ORD,
  T0_MS,
  scriptedClass,
  type ScriptedClass,
} from "./creator-test-harness";
import { readSpares, registerSpare, stampSpareVerified } from "./spare-store";

const MINUTE_MS = 60_000;

let world: CreatorWorld;
let cls: ScriptedClass;

// Observation is what these cover, so the spare's colo keeps its base slot:
// without one, a verified spare would be promoted to it.
beforeEach(async () => {
  world = await CreatorWorld.open();
  cls = { ...scriptedClass([]), spares: 1 };
  await world.seed("scheduler-base", ORD, T0_MS - HOUR_MS);
  cls.where.set("scheduler-base", ORD);
});

async function spare(name: string, colo: Colo, verifiedAtMs: number | null) {
  await registerSpare(
    world.handle(),
    {
      classCode: SCHEDULER,
      colo,
      name,
      objectId: `id-${name}`,
      registeredAtMs: T0_MS - HOUR_MS,
      verifiedAtMs,
    },
    { opId: `seed-${name}`, kind: "seeded" },
  );
}

describe("observing the spares", () => {
  test("verifies a spare that answers from its colo holding its marker", async () => {
    await spare("scheduler-spare", ORD, null);
    cls.where.set("scheduler-spare", ORD);
    cls.marked.set("scheduler-spare", ORD);
    const report = await world.pass(cls);
    expect(report.sparesVerified).toEqual(["scheduler-spare"]);
    expect(report.sparesUnregistered).toEqual([]);
    expect((await readSpares(world.handle()))[0]?.verifiedAtMs).toBe(T0_MS);
  });

  // An emptied spare answers from its colo with no marker. Kept verified, it
  // would be a failover's standby that ceases at its next idle period. One
  // that cannot take a new mark, as an older build's cannot, is taken out.
  // The failed mark may still land before its deadline, so the spare is
  // released by a later pass, never by the one whose mark failed: a release
  // the late mark followed would leave a marker nothing records.
  test.each<[string, Colo | undefined]>([
    ["holding no marker", undefined],
    ["holding a marker for another colo", IAD],
  ])(
    "takes out a spare answering from its colo %s, releasing it a pass later",
    async (_, marker) => {
      await world.act();
      await spare("scheduler-spare", ORD, T0_MS - HOUR_MS);
      cls.where.set("scheduler-spare", ORD);
      cls.unmarkable.add("scheduler-spare");
      if (marker !== undefined) cls.marked.set("scheduler-spare", marker);
      const report = await world.pass(cls);
      expect(report.sparesVerified).toEqual([]);
      expect(report.sparesUnregistered).toEqual([
        { classCode: SCHEDULER, name: "scheduler-spare", colo: ORD },
      ]);
      expect(await readSpares(world.handle())).toEqual([]);
      expect(cls.releasedNames).toEqual([]);

      world.clock += HOUR_MS;
      await world.pass(cls);
      expect(cls.releasedNames).toContain("scheduler-spare");
    },
  );

  // The object is still where the spare is kept, so it is marked again there
  // rather than released for a creation to replace.
  test.each<[string, Colo | undefined]>([
    ["holding no marker", undefined],
    ["holding a marker for another colo", IAD],
  ])(
    "marks a spare answering from its colo %s again, in act mode",
    async (_, marker) => {
      await world.act();
      await spare("scheduler-spare", ORD, T0_MS - HOUR_MS);
      cls.where.set("scheduler-spare", ORD);
      if (marker !== undefined) cls.marked.set("scheduler-spare", marker);
      const report = await world.pass(cls);
      expect(report.sparesRemarked).toEqual(["scheduler-spare"]);
      expect(report.sparesVerified).toEqual(["scheduler-spare"]);
      expect(report.sparesUnregistered).toEqual([]);
      expect(cls.marked.get("scheduler-spare")).toBe(ORD);
      expect(cls.releasedNames).toEqual([]);
    },
  );

  // A spare can answer the mark without taking it: a value under its marker
  // key that is no marker, or a move between the observe and the mark. It is
  // taken out as one that cannot answer is.
  test.each<[string, { colo: Colo | null; markedColo: Colo | null }]>([
    ["holding no marker", { colo: ORD, markedColo: null }],
    ["from another colo", { colo: IAD, markedColo: IAD }],
  ])("takes out a spare whose mark's answer comes %s", async (_, answer) => {
    await world.act();
    await spare("scheduler-spare", ORD, T0_MS - HOUR_MS);
    cls.where.set("scheduler-spare", ORD);
    cls.markAnswers.set("scheduler-spare", answer);
    const report = await world.pass(cls);
    expect(report.sparesRemarked).toEqual([]);
    expect(report.sparesUnregistered.map((s) => s.name)).toEqual([
      "scheduler-spare",
    ]);
  });

  // Marking writes to the object, which a class in observe mode never does.
  test("takes out rather than marks a spare in observe mode", async () => {
    await spare("scheduler-spare", ORD, T0_MS - HOUR_MS);
    cls.where.set("scheduler-spare", ORD);
    const report = await world.pass(cls);
    expect(report.sparesRemarked).toEqual([]);
    expect(report.sparesUnregistered.map((s) => s.name)).toEqual([
      "scheduler-spare",
    ]);
    expect(cls.marked.has("scheduler-spare")).toBe(false);
  });

  test("takes out a spare that answers from another colo", async () => {
    await spare("scheduler-spare", ORD, T0_MS - HOUR_MS);
    cls.where.set("scheduler-spare", IAD);
    cls.marked.set("scheduler-spare", ORD);
    const report = await world.pass(cls);
    expect(report.sparesUnregistered.map((s) => s.name)).toEqual([
      "scheduler-spare",
    ]);
    expect(
      (await readReleasePending(world.handle())).map((p) => p.name),
    ).toEqual(["scheduler-spare"]);
  });

  // An object that cannot name its colo still reports its marker. A missing
  // or foreign marker is a definite answer and takes the spare out at once;
  // only the right marker earns the wait an unanswered spare gets.
  test.each<[string, Colo | undefined, boolean]>([
    ["no marker", undefined, false],
    ["a marker for another colo", IAD, false],
    ["its own colo's marker", ORD, true],
  ])(
    "with its colo unknown, a spare holding %s is kept only with its own colo's marker",
    async (_, marker, kept) => {
      await spare("scheduler-spare", ORD, T0_MS - HOUR_MS);
      if (marker !== undefined) cls.marked.set("scheduler-spare", marker);
      const report = await world.pass(cls);
      expect(report.sparesVerified).toEqual([]);
      expect(report.sparesUnregistered.map((s) => s.name)).toEqual(
        kept ? [] : ["scheduler-spare"],
      );
    },
  );

  // A spare that cannot answer is not yet known to be gone, as with a base
  // slot: it stays until its last answer is older than a slot may go.
  test("keeps a silent spare until its last answer is too old", async () => {
    world.candidate(ORD, T0_MS - HOUR_MS);
    await spare("scheduler-spare", ORD, T0_MS - HOUR_MS);
    cls.silent.add("scheduler-spare");
    const kept = await world.pass(cls);
    expect(kept.sparesUnregistered).toEqual([]);
    expect(kept.failures).toEqual(["observe spare scheduler-spare: no answer"]);

    world.clock += 2 * HOUR_MS;
    const gone = await world.pass(cls);
    expect(gone.sparesUnregistered.map((s) => s.name)).toEqual([
      "scheduler-spare",
    ]);
  });
});

describe("keeping spares beside the primary", () => {
  beforeEach(async () => {
    await world.act();
    world.primary = { colo: ORD, region: "ENAM" };
  });

  // A creation that lands beside the class's base slot in the primary's colo
  // was spent before spares; while the class is short, it is kept as one.
  test("keeps a probe landing in the primary's colo as a spare", async () => {
    const keeping = { ...scriptedClass([ORD]), spares: 1 };
    keeping.where.set("scheduler-base", ORD);
    const report = await world.pass(keeping);
    expect(report.sparesCreated.map((s) => s.colo)).toEqual([ORD]);
    expect(report.spent).toEqual([]);
    expect(report.spareGaps).toEqual([]);
    const [kept] = await readSpares(world.handle());
    expect(kept).toMatchObject({ colo: ORD, verifiedAtMs: T0_MS });
    expect(keeping.marked.get(kept?.name ?? "")).toBe(ORD);
  });

  // The failures this guards: a spare whose registration committed and lost
  // its reply was emptied, so a registered spare held no marker, and was not
  // counted, so the next attempt this pass registered a spare past the count.
  test("keeps and counts a spare whose registration lost its reply", async () => {
    const losing = { ...scriptedClass([ORD, ORD, ORD]), spares: 1 };
    losing.where.set("scheduler-base", ORD);
    let loseReply = false;
    world.afterBatch = () => {
      if (!loseReply) return;
      loseReply = false;
      throw new Error("reply lost");
    };
    const placing = {
      ...losing,
      place: async (name: string, colo: Colo, deadlineMs: number) => {
        await losing.place(name, colo, deadlineMs);
        loseReply = true;
      },
    };
    const report = await world.pass(placing);
    expect(report.sparesCreated).toEqual([]);
    expect(report.failures).toHaveLength(1);
    expect(losing.releasedNames).toEqual([]);
    const [kept, ...beyond] = await readSpares(world.handle());
    expect(beyond).toEqual([]);
    expect(losing.marked.get(kept?.name ?? "")).toBe(ORD);

    world.clock += HOUR_MS;
    const next = await world.pass(losing);
    expect(next.sparesVerified).toContain(kept?.name ?? "");
    expect(await readSpares(world.handle())).toHaveLength(1);
  });

  // Once the class holds its spares there, a creation landing beside them is
  // spent as before, and the primary's colo asks for no more attempts.
  test("spends a landing once the class holds its spares", async () => {
    await spare("scheduler-spare", ORD, T0_MS - HOUR_MS);
    const full = { ...scriptedClass([ORD]), spares: 1 };
    full.where.set("scheduler-base", ORD);
    full.where.set("scheduler-spare", ORD);
    full.marked.set("scheduler-spare", ORD);
    const report = await world.pass(full);
    expect(report.sparesCreated).toEqual([]);
    expect(report.spent.map((s) => s.colo)).toEqual([ORD]);
  });

  // The attempts beside the primary keep going while the class is short of
  // spares there, not only while it lacks its base slot.
  test("attempts the primary's colo while it is short of spares", async () => {
    await world.seed("scheduler-iad", IAD, T0_MS - HOUR_MS);
    const short = { ...scriptedClass([IAD, IAD, ORD]), spares: 1 };
    short.where.set("scheduler-base", ORD);
    short.where.set("scheduler-iad", IAD);
    const report = await world.pass(short);
    expect(report.sparesCreated.map((s) => s.colo)).toEqual([ORD]);
    expect(report.spent.map((s) => s.colo)).toEqual([IAD, IAD]);
  });

  test("reports a class short of its spares in the primary's colo", async () => {
    await world.seed("scheduler-iad", IAD, T0_MS - HOUR_MS);
    const short = { ...scriptedClass([IAD, IAD, IAD, IAD, IAD]), spares: 1 };
    short.where.set("scheduler-base", ORD);
    short.where.set("scheduler-iad", IAD);
    const report = await world.pass(short);
    expect(report.spareGaps).toEqual([{ classCode: SCHEDULER, colo: ORD }]);
  });

  // When the base slot leaves, a verified spare in its colo takes its place
  // in one batch: the colo keeps a slot with no creation.
  test("promotes a verified spare when its colo's base slot leaves", async () => {
    await spare("scheduler-spare", ORD, T0_MS - HOUR_MS);
    const moved = { ...scriptedClass([]), spares: 1 };
    moved.where.set("scheduler-base", IAD);
    moved.where.set("scheduler-spare", ORD);
    moved.marked.set("scheduler-spare", ORD);
    const report = await world.pass(moved);
    expect(report.unregistered.map((s) => s.name)).toEqual(["scheduler-base"]);
    expect(report.sparesPromoted).toEqual([
      { classCode: SCHEDULER, name: "scheduler-spare", colo: ORD },
    ]);
    expect(report.created).toEqual([]);
    expect(await readSpares(world.handle())).toEqual([]);
  });

  // Spares are kept only beside the primary, so a move takes the old colo's
  // out for release while its base slot stays.
  test("takes a spare out when the primary has moved from its colo", async () => {
    await spare("scheduler-spare", ORD, T0_MS - HOUR_MS);
    world.primary = { colo: IAD, region: "ENAM" };
    const after = { ...scriptedClass([]), spares: 1 };
    after.where.set("scheduler-base", ORD);
    after.where.set("scheduler-spare", ORD);
    after.marked.set("scheduler-spare", ORD);
    const report = await world.pass(after);
    expect(report.sparesUnregistered).toEqual([
      { classCode: SCHEDULER, name: "scheduler-spare", colo: ORD },
    ]);
    // The scheduler class has no delay of its own, so the spare goes once the
    // handoff settle time has passed.
    expect(after.releasedNames).toEqual([]);
    world.clock += LANE_HANDOFF_SETTLE_MS;
    await world.pass(after);
    expect(after.releasedNames).toContain("scheduler-spare");
  });

  // The settle time runs from when the spare leaves its table, not from when
  // it was observed: a slow re-mark before it left must not have used it up.
  test("starts the settle time when a spare leaves, after a slow re-mark", async () => {
    await world.act();
    await spare("scheduler-spare", ORD, T0_MS - HOUR_MS);
    cls.where.set("scheduler-spare", ORD);
    const slow = {
      ...cls,
      markInPlace: () => {
        world.clock += MINUTE_MS;
        return Promise.resolve({ colo: ORD, markedColo: null });
      },
    };
    await world.pass(slow);
    const pending = await readReleasePending(world.handle());
    expect(
      pending.find((p) => p.name === "scheduler-spare")?.unregisteredAtMs,
    ).toBe(T0_MS + MINUTE_MS);
  });

  // A move and the old colo's base slot leaving in one pass: spares are kept
  // only beside the primary, so the old colo's spare leaves rather than take
  // the base slot there.
  test("does not promote a spare in a colo the primary has left", async () => {
    await spare("scheduler-spare", ORD, T0_MS - HOUR_MS);
    world.primary = { colo: IAD, region: "ENAM" };
    const moved = { ...scriptedClass([]), spares: 1 };
    moved.where.set("scheduler-base", MIA);
    moved.where.set("scheduler-spare", ORD);
    moved.marked.set("scheduler-spare", ORD);
    const report = await world.pass(moved);
    expect(report.unregistered.map((s) => s.name)).toEqual(["scheduler-base"]);
    expect(report.sparesPromoted).toEqual([]);
    expect(report.sparesUnregistered.map((s) => s.name)).toEqual([
      "scheduler-spare",
    ]);
  });

  // More spares than the class keeps, as an interrupted creation could leave,
  // would multiply the hourly observe and stamp cost the count was sized at:
  // the latest registered leaves.
  test("takes out spares beyond the class's count, latest first", async () => {
    await spare("scheduler-spare-1", ORD, T0_MS - HOUR_MS);
    await spare("scheduler-spare-2", ORD, T0_MS - HOUR_MS);
    const surplus = { ...scriptedClass([]), spares: 1 };
    surplus.where.set("scheduler-base", ORD);
    for (const name of ["scheduler-spare-1", "scheduler-spare-2"]) {
      surplus.where.set(name, ORD);
      surplus.marked.set(name, ORD);
    }
    const report = await world.pass(surplus);
    expect(report.sparesUnregistered.map((s) => s.name)).toEqual([
      "scheduler-spare-2",
    ]);
    expect((await readSpares(world.handle())).map((s) => s.name)).toEqual([
      "scheduler-spare-1",
    ]);
  });

  // A surplus keeps the spare a failover could use: a verified one stays over
  // an earlier one that has never answered.
  test("keeps a verified spare over an unverified one in a surplus", async () => {
    await spare("scheduler-spare-1", ORD, null);
    await spare("scheduler-spare-2", ORD, T0_MS - HOUR_MS);
    const surplus = { ...scriptedClass([]), spares: 1 };
    surplus.where.set("scheduler-base", ORD);
    surplus.silent.add("scheduler-spare-1");
    surplus.where.set("scheduler-spare-2", ORD);
    surplus.marked.set("scheduler-spare-2", ORD);
    const report = await world.pass(surplus);
    expect(report.sparesUnregistered.map((s) => s.name)).toEqual([
      "scheduler-spare-1",
    ]);
    expect(report.spareGaps).toEqual([]);
  });

  // A spare that has never answered occupies its place, so the pass creates
  // none past it, but it is no standby yet: the class reports its spare gap.
  test("reports an unverified spare as a gap without creating past it", async () => {
    await spare("scheduler-spare", ORD, null);
    const waiting = { ...scriptedClass([ORD]), spares: 1 };
    waiting.where.set("scheduler-base", ORD);
    waiting.silent.add("scheduler-spare");
    const report = await world.pass(waiting);
    expect(report.sparesCreated).toEqual([]);
    expect(report.spent.map((s) => s.colo)).toEqual([ORD]);
    expect(report.spareGaps).toEqual([{ classCode: SCHEDULER, colo: ORD }]);
  });

  // Taking a spare out matches the verification the pass read, so one another
  // pass stamped meanwhile stays. It must still count against the class this
  // pass, or a spare would be created beside the primary while the old one
  // remains, and the class would hold more than it keeps.
  test("creates no spare past one whose removal lost to a later stamp", async () => {
    world.primary = { colo: ORD, region: "ENAM" };
    await spare("scheduler-old-iad", IAD, T0_MS - HOUR_MS);
    await spare("scheduler-old-mia", MIA, T0_MS - HOUR_MS);
    const racing = { ...scriptedClass([ORD]), spares: 1 };
    racing.where.set("scheduler-base", ORD);
    racing.where.set("scheduler-old-iad", IAD);
    racing.marked.set("scheduler-old-iad", IAD);
    racing.where.set("scheduler-old-mia", MIA);
    racing.marked.set("scheduler-old-mia", MIA);
    // The spares are observed in colo order. While the second is observed,
    // a pass that lost the lease stamps the first again.
    const observe = racing.observe;
    racing.observe = async (name, hint) => {
      if (name === "scheduler-old-mia") {
        await stampSpareVerified(world.handle(), {
          name: "scheduler-old-iad",
          colo: IAD,
          opId: "other-pass",
          atMs: T0_MS + 1,
        });
      }
      return await observe(name, hint);
    };
    const report = await world.pass(racing);
    expect(report.sparesUnregistered.map((s) => s.name)).toEqual([
      "scheduler-old-mia",
    ]);
    expect(report.sparesCreated).toEqual([]);
    expect((await readSpares(world.handle())).map((s) => s.name)).toEqual([
      "scheduler-old-iad",
    ]);
  });

  // The lingering spare is counted only after the settle loop: counted when
  // its removal failed, one sorting ahead of the primary's spare would make
  // that spare look surplus and take it out.
  test("keeps the primary's spare beside one whose removal lost the race", async () => {
    world.primary = { colo: ORD, region: "ENAM" };
    await spare("scheduler-old-iad", IAD, T0_MS - HOUR_MS);
    await spare("scheduler-spare", ORD, T0_MS - HOUR_MS);
    const racing = { ...scriptedClass([ORD]), spares: 1 };
    racing.where.set("scheduler-base", ORD);
    racing.where.set("scheduler-old-iad", IAD);
    racing.marked.set("scheduler-old-iad", IAD);
    racing.where.set("scheduler-spare", ORD);
    racing.marked.set("scheduler-spare", ORD);
    const observe = racing.observe;
    racing.observe = async (name, hint) => {
      if (name === "scheduler-spare") {
        await stampSpareVerified(world.handle(), {
          name: "scheduler-old-iad",
          colo: IAD,
          opId: "other-pass",
          atMs: T0_MS + 1,
        });
      }
      return await observe(name, hint);
    };
    const report = await world.pass(racing);
    expect(report.sparesUnregistered).toEqual([]);
    expect(report.sparesCreated).toEqual([]);
    expect((await readSpares(world.handle())).map((s) => s.name)).toEqual([
      "scheduler-old-iad",
      "scheduler-spare",
    ]);
  });

  // A pass that cannot read where the primary is has no move to act on.
  test("keeps the spares when the pass cannot tell where the primary is", async () => {
    await spare("scheduler-spare", ORD, T0_MS - HOUR_MS);
    world.primary = "fails";
    const unknown = { ...scriptedClass([]), spares: 1 };
    unknown.where.set("scheduler-base", ORD);
    unknown.where.set("scheduler-spare", ORD);
    unknown.marked.set("scheduler-spare", ORD);
    const report = await world.pass(unknown);
    expect(report.sparesUnregistered).toEqual([]);
    expect((await readSpares(world.handle())).map((s) => s.name)).toEqual([
      "scheduler-spare",
    ]);
  });
});
