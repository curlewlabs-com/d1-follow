// The creator's releases: which objects out of the registry it empties, when,
// and how a backlog or a release that keeps failing is bounded, in the world
// creator-test-harness.ts sets up.
import { beforeEach, describe, expect, test } from "bun:test";
import type { CreatorClass } from "./creator";
import { readReleasePending } from "./creator-store";
import { LANE_HANDOFF_SETTLE_MS } from "./lane";
import {
  CreatorWorld,
  DEN,
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

beforeEach(async () => {
  world = await CreatorWorld.open();
});

describe("releasing", () => {
  async function outOfRegistry(cls: ScriptedClass) {
    await world.seed("scheduler-old", ORD, T0_MS - HOUR_MS);
    cls.where.set("scheduler-old", IAD);
    await world.pass(cls);
  }

  test("releases an object out of the registry once the rule allows", async () => {
    await world.act();
    const cls = scriptedClass([ORD]);
    await outOfRegistry(cls);
    world.clock += LANE_HANDOFF_SETTLE_MS;
    await world.pass(cls);
    expect(cls.releasedNames).toEqual(["scheduler-old"]);
    expect(await readReleasePending(world.handle())).toEqual([]);
  });

  // A handoff that validated the object while it was registered can commit
  // its swap after the pass unregistered it; releasing in that gap would clear
  // the new holder's marker. So even a class with no delay of its own waits
  // out the settle time, and a holder that landed meanwhile is kept.
  test("waits out the handoff settle time, then keeps a holder that landed", async () => {
    await world.act();
    const cls = scriptedClass([ORD]);
    await outOfRegistry(cls);
    expect(cls.releasedNames).toEqual([]);
    world.clock += LANE_HANDOFF_SETTLE_MS - 1;
    await world.pass(cls);
    expect(cls.releasedNames).not.toContain("scheduler-old");
    world.app
      .query(
        "INSERT INTO follow_lane (lane, holder, seq, changed_at_ms, changed_by) VALUES (1, 'scheduler-old', 2, 0, 3)",
      )
      .run();
    world.clock += 1;
    await world.pass(cls);
    expect(cls.releasedNames).not.toContain("scheduler-old");
    expect(
      (await readReleasePending(world.handle())).map((p) => p.name),
    ).toEqual(["scheduler-old"]);
  });

  // A stateless class's callers may hold an old name in a cache, so its
  // objects wait out the class's window before they are emptied.
  test("holds a release until the class's window has passed", async () => {
    await world.act();
    const cls = { ...scriptedClass([ORD]), releaseAfterMs: 24 * HOUR_MS };
    await outOfRegistry(cls);
    expect(cls.releasedNames).toEqual([]);
  });

  // The lane's holder and each deployment's default are never released,
  // whatever the registry says: emptying one would stop the lane.
  test("never releases a lane holder or a protected name", async () => {
    await world.act();
    world.app
      .query(
        "INSERT INTO follow_lane (lane, holder, seq, changed_at_ms, changed_by) VALUES (1, 'scheduler-old', 1, 0, 1)",
      )
      .run();
    const cls = scriptedClass([ORD]);
    await outOfRegistry(cls);
    expect(cls.releasedNames).toEqual([]);
  });

  test("in dry-run, only says it would release", async () => {
    const cls = scriptedClass([]);
    await world.seed("scheduler-old", ORD, T0_MS - HOUR_MS);
    cls.where.set("scheduler-old", IAD);
    await world.pass(cls);
    world.clock += LANE_HANDOFF_SETTLE_MS;
    const report = await world.pass(cls);
    expect(report.wouldRelease).toEqual(["scheduler-old"]);
    expect(cls.releasedNames).toEqual([]);
  });
});

describe("release retries", () => {
  // A release that keeps failing is retried a budget at a time, so an outage
  // costs each pass a bounded number of calls and ledger rows, however many
  // objects wait.
  test("retries no more releases per pass than the budget", async () => {
    await world.act();
    const cls = scriptedClass([ORD, ORD]);
    let calls = 0;
    const failing: CreatorClass = {
      ...cls,
      release: async () => {
        calls++;
        throw new Error("release refused");
      },
    };
    for (const [n, colo] of [
      [1, ORD],
      [2, MIA],
      [3, DEN],
    ] as const) {
      await world.seed(`scheduler-old-${n}`, colo, T0_MS - HOUR_MS);
      cls.where.set(`scheduler-old-${n}`, IAD);
    }
    await world.pass(failing, { attemptsPerClassPerPass: 2 });
    expect(calls).toBe(0);
    world.clock += LANE_HANDOFF_SETTLE_MS;
    await world.pass(failing, { attemptsPerClassPerPass: 2 });
    expect(calls).toBe(2);

    calls = 0;
    world.clock += HOUR_MS;
    await world.pass(failing, { attemptsPerClassPerPass: 2 });
    expect(calls).toBe(2);
    expect(
      world.creator
        .query("SELECT count(*) AS n FROM follow_ledger WHERE kind = 6")
        .get(),
    ).toEqual({ n: 4 });
  });

  // Releases that keep failing must not take the whole budget every pass: one
  // not yet attempted goes ahead of them, or it would wait for ever.
  test("tries a release not yet attempted before retrying a failing one", async () => {
    await world.act();
    const cls = scriptedClass([ORD, ORD]);
    const stuck = new Set(["scheduler-old-1", "scheduler-old-2"]);
    let attempted: string[] = [];
    const flaky: CreatorClass = {
      ...cls,
      release: async (name) => {
        attempted.push(name);
        if (stuck.has(name)) throw new Error("release refused");
      },
    };
    for (const n of [1, 2, 3]) {
      world.creator
        .query(
          "INSERT INTO follow_release_pending (name, class_code, object_id, unregistered_at_ms) VALUES (?, ?, ?, ?)",
        )
        .run(
          `scheduler-old-${n}`,
          SCHEDULER,
          `id-old-${n}`,
          T0_MS - (4 - n) * HOUR_MS,
        );
    }
    await world.pass(flaky, { attemptsPerClassPerPass: 2 });
    expect(attempted).toEqual(["scheduler-old-1", "scheduler-old-2"]);

    attempted = [];
    world.clock += HOUR_MS;
    const next = await world.pass(flaky, { attemptsPerClassPerPass: 2 });
    expect(attempted).toEqual(["scheduler-old-3", "scheduler-old-1"]);
    expect(next.released.map((o) => o.name)).toEqual(["scheduler-old-3"]);
  });
});

describe("the release read", () => {
  // The pending set can grow through a long release outage, so a pass must
  // read no more of it than it can act on; a protected name at its head must
  // not take the budget from the releases behind it.
  test("reads no more of a backlog than the budget, past a protected name", async () => {
    await world.act();
    const cls = scriptedClass([ORD]);
    for (const n of [1, 2, 3, 4, 5, 6]) {
      world.creator
        .query(
          "INSERT INTO follow_release_pending (name, class_code, object_id, unregistered_at_ms) VALUES (?, ?, ?, ?)",
        )
        .run(
          `scheduler-old-${n}`,
          SCHEDULER,
          `id-old-${n}`,
          T0_MS - (7 - n) * HOUR_MS,
        );
    }
    let pendingRowsRead = 0;
    const report = await world.pass(
      cls,
      {
        attemptsPerClassPerPass: 2,
        protectedNames: new Set(["scheduler-old-1"]),
      },
      (query, rows) => {
        if (/\bFROM follow_release_pending\b/.test(query)) {
          pendingRowsRead += rows.length;
        }
      },
    );
    expect(pendingRowsRead).toBe(2);
    expect(report.released.map((o) => o.name)).toEqual([
      "scheduler-old-2",
      "scheduler-old-3",
    ]);
  });
});
