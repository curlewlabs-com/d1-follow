// The pass's observation of the base slots, for a slot that answers from a
// colo other than its own, in the world creator-test-harness.ts sets up. One
// kept where it moved fills a colo for no creation and no spent name; one kept
// wrongly would be a slot the registry places in a colo it is not in, or a
// second slot of a class in a colo.
import { beforeEach, describe, expect, test } from "bun:test";
import type { Colo } from "./colo";
import { LEDGER_KIND, readReleasePending, readSlots } from "./creator-store";
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

let world: CreatorWorld;
let cls: ScriptedClass;

beforeEach(async () => {
  world = await CreatorWorld.open();
  await world.act();
  cls = scriptedClass([]);
  await world.seed("scheduler-moved", ORD, T0_MS - HOUR_MS);
  cls.where.set("scheduler-moved", IAD);
  cls.marked.set("scheduler-moved", ORD);
  world.candidate(IAD, T0_MS - HOUR_MS);
});

function ledger(): { kind: number; colo: string; detail: string | null }[] {
  return world.creator
    .query("SELECT kind, colo, detail FROM follow_ledger ORDER BY id")
    .all() as { kind: number; colo: string; detail: string | null }[];
}

describe("a slot that answers from another colo", () => {
  test("is kept there when the class has no slot in that candidate colo", async () => {
    const report = await world.pass(cls);
    expect(report.moved).toEqual([
      { classCode: SCHEDULER, name: "scheduler-moved", colo: IAD },
    ]);
    expect(report.unregistered).toEqual([]);
    expect(cls.marked.get("scheduler-moved")).toBe(IAD);
    expect(await readSlots(world.handle())).toMatchObject([
      { name: "scheduler-moved", colo: IAD, verifiedAtMs: T0_MS },
    ]);
    expect(await readReleasePending(world.handle())).toEqual([]);
    // Recorded with the ledger's fixed kinds: out of the old colo, seeded in
    // the new.
    expect(ledger().filter((row) => row.detail?.startsWith("moved"))).toEqual([
      { kind: LEDGER_KIND.unregistered, colo: ORD, detail: `moved to ${IAD}` },
      { kind: LEDGER_KIND.seeded, colo: IAD, detail: `moved from ${ORD}` },
    ]);
  });

  // A colo holds a single slot of a class.
  test("is taken out when its class already has a slot there", async () => {
    await world.seed("scheduler-iad", IAD, T0_MS - HOUR_MS);
    cls.where.set("scheduler-iad", IAD);
    const report = await world.pass(cls);
    expect(report.moved).toEqual([]);
    expect(report.unregistered.map((s) => s.name)).toEqual(["scheduler-moved"]);
    expect(cls.marked.get("scheduler-moved")).toBe(ORD);
  });

  test("is taken out when it answers from a colo that is no candidate", async () => {
    cls.where.set("scheduler-moved", MIA);
    const report = await world.pass(cls);
    expect(report.moved).toEqual([]);
    expect(report.unregistered.map((s) => s.name)).toEqual(["scheduler-moved"]);
  });

  // An object that cannot take the mark, as an older build's cannot, falls
  // back to what the pass did before the call existed.
  test("is taken out when it cannot take the mark", async () => {
    cls.unmarkable.add("scheduler-moved");
    const report = await world.pass(cls);
    expect(report.moved).toEqual([]);
    expect(report.unregistered.map((s) => s.name)).toEqual(["scheduler-moved"]);
    expect(report.failures).toContain(
      "mark scheduler-moved in place: no answer",
    );
  });

  // The failed mark may still land before its deadline. Released in the same
  // pass, the slot's object could take that late mark afterward and hold a
  // marker nothing records, so the pass that took it out leaves the release
  // to a later one.
  test("whose mark failed is released by a later pass, not this one", async () => {
    cls.unmarkable.add("scheduler-moved");
    await world.pass(cls);
    expect(cls.releasedNames).not.toContain("scheduler-moved");
    expect(
      (await readReleasePending(world.handle())).map((p) => p.name),
    ).toEqual(["scheduler-moved"]);

    world.clock += HOUR_MS;
    await world.pass(cls);
    expect(cls.releasedNames).toContain("scheduler-moved");
  });

  // An object can answer without taking the mark: its storage holds a value
  // under the marker key that is no marker, or it moved again between the
  // observe and the mark. Either answer keeps nothing.
  test.each<[string, { colo: Colo | null; markedColo: Colo | null }]>([
    ["holding no marker", { colo: IAD, markedColo: null }],
    ["from yet another colo", { colo: MIA, markedColo: MIA }],
  ])("is taken out when the mark's answer comes %s", async (_, answer) => {
    cls.markAnswers.set("scheduler-moved", answer);
    const report = await world.pass(cls);
    expect(report.moved).toEqual([]);
    expect(report.unregistered.map((s) => s.name)).toEqual(["scheduler-moved"]);
  });

  // Marking writes to the object, which a class in observe mode never does.
  test("is taken out without a mark in observe mode", async () => {
    const observed = await CreatorWorld.open();
    await observed.seed("scheduler-moved", ORD, T0_MS - HOUR_MS);
    observed.candidate(IAD, T0_MS - HOUR_MS);
    const report = await observed.pass(cls);
    expect(report.moved).toEqual([]);
    expect(report.unregistered.map((s) => s.name)).toEqual(["scheduler-moved"]);
    expect(cls.marked.get("scheduler-moved")).toBe(ORD);
  });
});
