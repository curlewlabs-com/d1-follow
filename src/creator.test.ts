// The creator's pass as a whole: its lease, observing and keeping slots, what
// it reads, and copying the lane change log, in the world
// creator-test-harness.ts sets up. Creating is creator-create.test.ts's and
// releasing creator-release.test.ts's.
import { beforeEach, describe, expect, test } from "bun:test";
import type { Colo } from "./colo";
import type { CreatorClass } from "./creator";
import {
  readOpenIntents,
  readReleasePending,
  readSlots,
  stampVerified,
} from "./creator-store";
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
} from "./creator-test-harness";
import { readGaps } from "./gap-store";
import { claimPass } from "./pass-lease";

let world: CreatorWorld;

beforeEach(async () => {
  world = await CreatorWorld.open();
});

describe("the pass lease", () => {
  // Passes running at once would read the same gap and fill it twice: a pass
  // that finds the lease held must do nothing.
  test("skips a pass while another holds the lease", async () => {
    await world.act();
    await claimPass(world.handle(), {
      holder: "other-pass",
      nowMs: world.clock,
      leaseMs: HOUR_MS / 2,
    });
    const cls = scriptedClass([ORD, MIA]);
    const report = await world.pass(cls);
    expect(report.skipped).toBe(true);
    expect(cls.where.size).toBe(0);
  });

  // A pass that died leaves its lease to expire, so the next one is not
  // locked out for good.
  test("runs once a held lease has expired", async () => {
    await world.act();
    await claimPass(world.handle(), {
      holder: "dead-pass",
      nowMs: world.clock,
      leaseMs: HOUR_MS / 2,
    });
    world.clock += HOUR_MS / 2;
    const report = await world.pass(scriptedClass([ORD]));
    expect(report.skipped).toBe(false);
    expect(report.created).toHaveLength(1);
  });

  // A pass that runs past its original claim renews it before each step that
  // acts, so a long pass keeps the lease and finishes.
  test("keeps the lease through a pass longer than its first claim", async () => {
    await world.act();
    const cls = scriptedClass([ORD, MIA]);
    const slow: CreatorClass = {
      ...cls,
      observe: async (name, hint) => {
        world.clock += HOUR_MS;
        return await cls.observe(name, hint);
      },
    };
    const report = await world.pass(slow);
    expect(report.leaseLost).toBe(false);
    expect(report.created).toHaveLength(1);
  });

  // If another pass takes the lease while this one is mid-call, this one must
  // stop before writing that call's outcome, which is the new holder's to
  // resolve.
  test("stops before its next step once another pass takes the lease", async () => {
    await world.act();
    const cls = scriptedClass([DEN, DEN, DEN, DEN]);
    const overtaken: CreatorClass = {
      ...cls,
      observe: async (name, hint) => {
        world.clock += HOUR_MS;
        await claimPass(world.handle(), {
          holder: "other-pass",
          nowMs: world.clock,
          leaseMs: HOUR_MS / 2,
        });
        return await cls.observe(name, hint);
      },
    };
    const report = await world.pass(overtaken);
    expect(report.leaseLost).toBe(true);
    // The call that outlasted the lease records nothing; its attempt stays open
    // for whichever pass holds the lease next.
    expect(report.spent).toEqual([]);
    expect(cls.where.size).toBe(1);
    expect(
      (await readOpenIntents(world.handle(), world.clock + 1)).map(
        (i) => i.name,
      ),
    ).toEqual(["scheduler-test-enam-1"]);
  });

  // A call that fails after another pass took the lease is no more this
  // pass's to record than one that answered: its failure, and any gap record
  // it would write, belong to whichever pass holds the lease.
  test("records nothing of a call that fails after the lease went", async () => {
    await world.act();
    const cls = scriptedClass([]);
    const overtaken: CreatorClass = {
      ...cls,
      observe: async () => {
        world.clock += HOUR_MS;
        await claimPass(world.handle(), {
          holder: "other-pass",
          nowMs: world.clock,
          leaseMs: HOUR_MS / 2,
        });
        throw new Error("observe timed out");
      },
    };
    const report = await world.pass(overtaken, { attemptsPerClassPerPass: 1 });
    expect(report.leaseLost).toBe(true);
    expect(report.failures).toEqual([]);
    expect(await readGaps(world.handle())).toEqual([]);
  });

  test("records nothing of a release that fails after the lease went", async () => {
    await world.act();
    const cls = scriptedClass([ORD]);
    world.creator
      .query(
        "INSERT INTO follow_release_pending (name, class_code, object_id, unregistered_at_ms) VALUES (?, ?, ?, ?)",
      )
      .run("scheduler-old-1", SCHEDULER, "id-old-1", T0_MS - HOUR_MS);
    const overtaken: CreatorClass = {
      ...cls,
      release: async () => {
        world.clock += HOUR_MS;
        await claimPass(world.handle(), {
          holder: "other-pass",
          nowMs: world.clock,
          leaseMs: HOUR_MS / 2,
        });
        throw new Error("release timed out");
      },
    };
    const report = await world.pass(overtaken);
    expect(report.leaseLost).toBe(true);
    expect(report.failures).toEqual([]);
  });

  // A placement that outlasts the lease leaves an object holding its marker
  // that no pass has recorded. Emptying it after the lease went could undo the
  // pass now holding it, so the object is left to that pass, which resolves
  // the open attempt.
  test("leaves an object it placed after losing the lease", async () => {
    await world.act();
    const cls = scriptedClass([ORD, ORD]);
    const slowPlace: CreatorClass = {
      ...cls,
      place: async (name, colo, deadlineMs) => {
        await cls.place(name, colo, deadlineMs);
        world.clock += HOUR_MS;
        await claimPass(world.handle(), {
          holder: "other-pass",
          nowMs: world.clock,
          leaseMs: HOUR_MS / 2,
        });
      },
    };
    const report = await world.pass(slowPlace);
    expect(report.leaseLost).toBe(true);
    expect(report.created).toEqual([]);
    expect(cls.releasedNames).toEqual([]);
    expect(await readSlots(world.handle())).toEqual([]);

    world.clock += HOUR_MS;
    const next = await world.pass(cls);
    expect(next.created.map((o) => o.name)).toEqual(["scheduler-test-enam-1"]);
    expect(cls.releasedNames).toEqual([]);
  });

  // A call the pass makes can take effect after its lease lapsed and another
  // pass took over, which no check after the call can undo. So each call that
  // acts carries a deadline that ends inside the lease the pass holds when it
  // makes the call: an object that refuses past it can never act for a pass
  // that no longer holds the lease.
  test("each call that acts carries a deadline inside the pass's lease", async () => {
    await world.act();
    // One slot that moved into a candidate colo (marked in place), one long out
    // of the registry (released), and a gap probed (placed).
    world.creator
      .query(
        "INSERT INTO follow_release_pending (name, class_code, object_id, unregistered_at_ms) VALUES (?, ?, ?, ?)",
      )
      .run("scheduler-gone", SCHEDULER, "id-gone", T0_MS - 2 * HOUR_MS);
    await world.seed("scheduler-moved", MIA, T0_MS - HOUR_MS);
    await world.seed("scheduler-old", DEN, T0_MS - 2 * HOUR_MS);
    world.candidate(IAD, T0_MS - HOUR_MS);
    const cls = scriptedClass([ORD]);
    cls.where.set("scheduler-moved", IAD);
    cls.marked.set("scheduler-moved", MIA);
    cls.where.set("scheduler-old", "SEA" as Colo);
    const calls: {
      call: string;
      deadlineMs: number;
      untilMs: number;
      nowMs: number;
    }[] = [];
    const leaseUntil = (): number =>
      (
        world.creator
          .query("SELECT claimed_until_ms FROM follow_pass WHERE id = 1")
          .get() as { claimed_until_ms: number }
      ).claimed_until_ms;
    const watched: CreatorClass = {
      ...cls,
      place: async (name, colo, deadlineMs) => {
        calls.push({
          call: "place",
          deadlineMs,
          untilMs: leaseUntil(),
          nowMs: world.clock,
        });
        await cls.place(name, colo, deadlineMs);
      },
      markInPlace: async (name, deadlineMs) => {
        calls.push({
          call: "mark",
          deadlineMs,
          untilMs: leaseUntil(),
          nowMs: world.clock,
        });
        return await cls.markInPlace(name, deadlineMs);
      },
      release: async (name, deadlineMs) => {
        calls.push({
          call: "release",
          deadlineMs,
          untilMs: leaseUntil(),
          nowMs: world.clock,
        });
        await cls.release(name, deadlineMs);
      },
    };
    await world.pass(watched);
    expect([...new Set(calls.map((c) => c.call))].sort()).toEqual([
      "mark",
      "place",
      "release",
    ]);
    for (const c of calls) {
      expect(c.deadlineMs).toBeGreaterThan(c.nowMs);
      expect(c.deadlineMs).toBeLessThan(c.untilMs);
    }
  });

  // A placement can fail at the caller while its request is still on its way
  // to the object, and land any time before its deadline. Had the pass given
  // its lease up early, the next pass could resolve and spend the name first,
  // and the late placement would then leave a marked object outside every
  // table. So the lease stays held until it lapses on its own.
  test("keeps its lease after a call that acts failed, until it lapses", async () => {
    await world.act();
    const cls = scriptedClass([ORD]);
    const timedOut: CreatorClass = {
      ...cls,
      place: async () => {
        throw new Error("placement timed out");
      },
    };
    const report = await world.pass(timedOut, { attemptsPerClassPerPass: 1 });
    expect(report.failures.length).toBeGreaterThan(0);
    expect(
      await claimPass(world.handle(), {
        holder: "next-pass",
        nowMs: world.clock,
        leaseMs: HOUR_MS / 2,
      }),
    ).toBe(false);
    expect(
      await claimPass(world.handle(), {
        holder: "next-pass",
        nowMs: world.clock + HOUR_MS / 2,
        leaseMs: HOUR_MS / 2,
      }),
    ).toBe(true);
  });

  // The other side of the fence: an object that finds the deadline passed
  // refuses, and the pass treats the refusal as any failed placement - its
  // attempt stays open for the pass that holds the lease to resolve, and
  // nothing is registered.
  test("a placement refused past its deadline leaves its attempt open", async () => {
    await world.act();
    const cls = scriptedClass([ORD]);
    const late: CreatorClass = {
      ...cls,
      place: async (name, colo, deadlineMs) => {
        world.clock = deadlineMs + 1;
        if (world.clock > deadlineMs) throw new Error("deadline passed");
        await cls.place(name, colo, deadlineMs);
      },
    };
    const report = await world.pass(late, { attemptsPerClassPerPass: 1 });
    expect(report.created).toEqual([]);
    expect(cls.placed).toEqual([]);
    expect(await readSlots(world.handle())).toEqual([]);
    expect(
      (await readOpenIntents(world.handle(), world.clock + 1)).map(
        (i) => i.name,
      ),
    ).toEqual(["scheduler-test-enam-1"]);
  });

  // Observing a slot does not renew the lease, so a pass can lose it between
  // observes without knowing. What it does next must not act: the slot it
  // read as moved stays registered, and the gap it would fill takes no name.
  // Each is the pass now holding the lease to decide.
  test("acts on nothing once another pass takes the lease between observes", async () => {
    await world.act();
    await world.seed("scheduler-mia", MIA, T0_MS - HOUR_MS);
    await world.seed("scheduler-ord", ORD, T0_MS - HOUR_MS);
    const cls = scriptedClass([IAD]);
    cls.where.set("scheduler-mia", MIA);
    cls.where.set("scheduler-ord", IAD);
    const overtaken: CreatorClass = {
      ...cls,
      observe: async (name, hint) => {
        if (name === "scheduler-mia") {
          world.clock += HOUR_MS;
          await claimPass(world.handle(), {
            holder: "other-pass",
            nowMs: world.clock,
            leaseMs: HOUR_MS / 2,
          });
        }
        return await cls.observe(name, hint);
      },
    };
    const report = await world.pass(overtaken);
    expect(report.leaseLost).toBe(true);
    expect(report.unregistered).toEqual([]);
    expect(report.created).toEqual([]);
    expect((await readSlots(world.handle())).map((s) => s.name).sort()).toEqual(
      ["scheduler-mia", "scheduler-ord"],
    );
    expect(await readReleasePending(world.handle())).toEqual([]);
    expect(
      world.creator
        .query("SELECT count(*) AS n FROM follow_name_counter")
        .get(),
    ).toEqual({ n: 0 });
  });

  // The pass holding the lease reads a slot, then finds it moved; a pass that
  // lost the lease stamps it in between, from an answer in its colo. The
  // holder's reading is the older one, so it must not unregister the slot.
  test("leaves a slot a stale pass verified after this one read it", async () => {
    await world.seed("scheduler-ord", ORD, T0_MS - HOUR_MS);
    const cls = scriptedClass([]);
    cls.where.set("scheduler-ord", IAD);
    const raced: CreatorClass = {
      ...cls,
      observe: async (name, hint) => {
        await stampVerified(world.handle(), {
          name,
          colo: ORD,
          opId: "stale-pass",
          atMs: world.clock,
        });
        return await cls.observe(name, hint);
      },
    };
    const report = await world.pass(raced);
    expect(report.leaseLost).toBe(false);
    expect(report.unregistered).toEqual([]);
    expect(
      (await readSlots(world.handle())).map((s) => [s.name, s.verifiedAtMs]),
    ).toEqual([["scheduler-ord", T0_MS]]);
    expect(await readReleasePending(world.handle())).toEqual([]);
  });

  test("gives the lease up when it finishes", async () => {
    await world.pass(scriptedClass([]));
    const next = await world.pass(scriptedClass([]));
    expect(next.skipped).toBe(false);
  });
});

describe("an app's class", () => {
  // An app can implement its class as a class instance, with prototype
  // methods and private state. The pass wraps each class to fence its calls,
  // and a wrapper that copied own properties would drop the prototype methods
  // and rebind `this`; every member must reach the app's own object.
  test("works when it is a class instance with private state", async () => {
    await world.act();
    const scripted = scriptedClass([ORD]);
    class AppClass implements CreatorClass {
      readonly #inner = scripted;
      get code() {
        return this.#inner.code;
      }
      get label() {
        return this.#inner.label;
      }
      get releaseAfterMs() {
        return this.#inner.releaseAfterMs;
      }
      get spares() {
        return this.#inner.spares;
      }
      nameOf(number: number, regionHint: string) {
        return this.#inner.nameOf(number, regionHint);
      }
      objectIdOf(name: string) {
        return this.#inner.objectIdOf(name);
      }
      observe(name: string, hint: string | null) {
        return this.#inner.observe(name, hint);
      }
      place(name: string, colo: Colo, deadlineMs: number) {
        return this.#inner.place(name, colo, deadlineMs);
      }
      markInPlace(name: string, deadlineMs: number) {
        return this.#inner.markInPlace(name, deadlineMs);
      }
      release(name: string, deadlineMs: number) {
        return this.#inner.release(name, deadlineMs);
      }
    }
    const report = await world.pass(new AppClass());
    expect(report.failures).toEqual([]);
    expect(report.created.map((o) => o.name)).toEqual([
      "scheduler-test-enam-1",
    ]);
    expect(scripted.placed).toEqual(["scheduler-test-enam-1"]);
  });
});

describe("keeping", () => {
  test("stamps a slot that answers from its colo", async () => {
    await world.seed("scheduler-serving", ORD, T0_MS - HOUR_MS);
    const cls = scriptedClass([]);
    cls.where.set("scheduler-serving", ORD);
    const report = await world.pass(cls);
    expect(report.verified).toEqual(["scheduler-serving"]);
    expect((await readSlots(world.handle()))[0]?.verifiedAtMs).toBe(T0_MS);
  });

  // A slot answering from another colo is not where the router would send
  // work, so it leaves the registry at once and waits to be released.
  test("unregisters a slot that answers from another colo", async () => {
    await world.seed("scheduler-serving", ORD, T0_MS - HOUR_MS);
    const cls = scriptedClass([]);
    cls.where.set("scheduler-serving", IAD);
    const report = await world.pass(cls);
    expect(report.unregistered).toEqual([
      { classCode: SCHEDULER, name: "scheduler-serving", colo: ORD },
    ]);
    expect(report.gaps).toEqual([{ classCode: SCHEDULER, colo: ORD }]);
    expect(
      (await readReleasePending(world.handle())).map((p) => p.name),
    ).toEqual(["scheduler-serving"]);
  });

  // One missed answer is not a move: a slot stays until its last answer from
  // its colo is older than the verified window.
  test("keeps a silent slot until its last answer is too old", async () => {
    await world.seed("scheduler-serving", ORD, T0_MS - HOUR_MS);
    const cls = scriptedClass([]);
    cls.silent.add("scheduler-serving");
    const quiet = await world.pass(cls);
    expect(quiet.unregistered).toEqual([]);

    world.clock += 2 * HOUR_MS;
    const gone = await world.pass(cls);
    expect(gone.unregistered.map((o) => o.name)).toEqual(["scheduler-serving"]);
  });
});

describe("the pass's own reads", () => {
  // The pass is sized as one registry read and lease renewals only around
  // acts. A steady pass that renewed around each observe, or read the registry
  // again for each phase, would cost rows that grow with every slot kept.
  test("reads each slot's row once and renews no more for more slots", async () => {
    const steadyPass = async (colos: Colo[]) => {
      const fresh = await CreatorWorld.open();
      const cls = scriptedClass([]);
      for (const colo of colos) {
        await fresh.seed(`scheduler-${colo}`, colo, T0_MS - HOUR_MS);
        cls.where.set(`scheduler-${colo}`, colo);
      }
      let slotRows = 0;
      let renewals = 0;
      const report = await fresh.pass(cls, {}, (query, rows) => {
        if (/\bFROM follow_slot\b/.test(query)) slotRows += rows.length;
        if (/^UPDATE follow_pass\b/.test(query)) renewals++;
      });
      expect(report.verified).toHaveLength(colos.length);
      expect(report.gaps).toEqual([]);
      return { slotRows, renewals };
    };
    const one = await steadyPass([ORD]);
    const four = await steadyPass([ORD, MIA, IAD, DEN]);
    expect(one.slotRows).toBe(1);
    expect(four.slotRows).toBe(4);
    expect(four.renewals).toBe(one.renewals);
  });
});

describe("the lane change log", () => {
  // The ledger is the one account of every move, so each change the app's log
  // holds is copied, once, however many passes see it.
  test("copies each change into the ledger once", async () => {
    world.app.run(
      "INSERT INTO follow_lane_change (lane, seq, from_holder, to_holder, changed_at_ms, changed_by) VALUES (1, 1, NULL, 'lane-a', 10, 1), (1, 2, 'lane-a', 'lane-b', 20, 3)",
    );
    const cls = scriptedClass([]);
    const first = await world.pass(cls);
    const again = await world.pass(cls);
    expect(first.laneChangesCopied).toBe(2);
    expect(again.laneChangesCopied).toBe(0);
    expect(
      world.creator
        .query(
          "SELECT lane_seq, name, from_name, changed_by FROM follow_ledger WHERE kind = 8 ORDER BY lane_seq",
        )
        .all(),
    ).toEqual([
      { lane_seq: 1, name: "lane-a", from_name: null, changed_by: 1 },
      { lane_seq: 2, name: "lane-b", from_name: "lane-a", changed_by: 3 },
    ]);
  });
});
