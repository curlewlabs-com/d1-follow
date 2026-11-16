import { Database } from "bun:sqlite";
import { describe, expect, test } from "bun:test";
import type { Colo } from "./colo";
import {
  admit,
  handoffColo,
  LANE_HANDOFF_THRESHOLD,
  LANE_RUN_MAX_GAP_MS,
  nextLaneRun,
  NO_RUN,
  type LaneRun,
} from "./lane";
import type { Placement } from "./observation";

describe("admit", () => {
  test("a lane with no record is seeded before anyone works", () => {
    expect(admit(null, "holder-a")).toEqual({ kind: "seed" });
  });

  test("the object the record names does the work", () => {
    expect(admit({ holder: "holder-a", seq: 3 }, "holder-a")).toEqual({
      kind: "work",
    });
  });

  // A second object working the lane beside its holder is the double send the
  // record exists to prevent: a non-holder refuses and points at the holder.
  test("any other object is redirected to the holder", () => {
    expect(admit({ holder: "holder-b", seq: 4 }, "holder-a")).toEqual({
      kind: "redirect",
      holder: "holder-b",
    });
  });
});

describe("the lane's run", () => {
  const ORD = "ORD" as Colo;
  const MIA = "MIA" as Colo;
  const IAD = "IAD" as Colo;
  const MINUTE_MS = 60_000;
  const T0_MS = Date.UTC(2026, 9, 7, 3, 0, 0);
  const apart = (primary: Colo): Placement => ({
    kind: "apart",
    self: ORD,
    primary,
  });
  // The run after one observation a minute, from T0.
  const runOf = (placements: readonly Placement[]): LaneRun =>
    placements.reduce(
      (run, placement, i) => nextLaneRun(run, placement, T0_MS + i * MINUTE_MS),
      NO_RUN,
    );

  // The handoff fires on the threshold-th consecutive observation and not
  // before: one early would move the lane on a primary that was only passing.
  test("hands off once the primary has been in one other colo for the threshold", () => {
    const short = runOf(Array(LANE_HANDOFF_THRESHOLD - 1).fill(apart(MIA)));
    expect(short.count).toBe(LANE_HANDOFF_THRESHOLD - 1);
    expect(handoffColo(short)).toBeNull();
    const due = runOf(Array(LANE_HANDOFF_THRESHOLD).fill(apart(MIA)));
    expect(handoffColo(due)).toBe(MIA);
  });

  test("an observation beside the primary ends the run", () => {
    const run = runOf([apart(MIA), apart(MIA), { kind: "beside", colo: ORD }]);
    expect(run).toEqual(NO_RUN);
  });

  // A unit that saw no primary-served result is no evidence either way.
  test("a unit that observed nothing leaves the run as it was", () => {
    const run = runOf([apart(MIA), apart(MIA)]);
    expect(
      nextLaneRun(run, { kind: "unobserved" }, T0_MS + 5 * MINUTE_MS),
    ).toBe(run);
  });

  // Consecutive means the same other colo: a primary seen in MIA then IAD is
  // still moving, and the count starts again at the new colo.
  test("a primary seen in another colo starts the run again there", () => {
    const run = runOf([apart(MIA), apart(MIA), apart(IAD)]);
    expect(run.colo).toBe(IAD);
    expect(run.count).toBe(1);
  });

  // Between observations further apart than the gap, the primary could
  // have left and come back unseen.
  test("a run whose last observation is older than the gap starts again", () => {
    const run = runOf([apart(MIA), apart(MIA)]);
    const lastAtMs = T0_MS + MINUTE_MS;
    expect(
      nextLaneRun(run, apart(MIA), lastAtMs + LANE_RUN_MAX_GAP_MS).count,
    ).toBe(3);
    expect(
      nextLaneRun(run, apart(MIA), lastAtMs + LANE_RUN_MAX_GAP_MS + 1).count,
    ).toBe(1);
  });

  test("a last observation stamped after now starts the run again", () => {
    const run = runOf([apart(MIA), apart(MIA)]);
    expect(nextLaneRun(run, apart(MIA), T0_MS - MINUTE_MS).count).toBe(1);
  });
});

// The DDL an app applies to its own database has to be valid SQLite, which
// is what D1 runs; an app finds out otherwise only at its own schema deploy.
test("schema/lane.sql applies to SQLite", async () => {
  const sqlite = new Database(":memory:");
  sqlite.exec(
    await Bun.file(new URL("../schema/lane.sql", import.meta.url)).text(),
  );
  const tables = sqlite
    .query("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name")
    .all();
  expect(tables).toEqual([
    { name: "follow_lane" },
    { name: "follow_lane_change" },
  ]);
});

// The change log is copied into the creator's ledger as the account of every
// move, so it must refuse a row the lane record itself could not hold.
test.each([
  ["a lane code below one", 0, 1, null, "lane-b"],
  ["a sequence number below one", 1, 0, null, "lane-b"],
  ["an empty previous holder", 1, 2, "", "lane-b"],
  ["an empty new holder", 1, 2, "lane-a", ""],
])("lane.sql's change log refuses %s", async (_, lane, seq, from, to) => {
  const sqlite = new Database(":memory:");
  sqlite.exec(
    await Bun.file(new URL("../schema/lane.sql", import.meta.url)).text(),
  );
  expect(() =>
    sqlite
      .query(
        "INSERT INTO follow_lane_change (lane, seq, from_holder, to_holder, changed_at_ms, changed_by) VALUES (?, ?, ?, ?, 0, 2)",
      )
      .run(lane, seq, from, to),
  ).toThrow(/CHECK constraint failed/);
});

// A run's colo is compared with observed colos, which parseColo admits only in
// the shape it checks; anything else in the record could never match one.
test.each(["ord", "OR", "123"])(
  "lane.sql's record refuses the run colo %s",
  async (runColo) => {
    const sqlite = new Database(":memory:");
    sqlite.exec(
      await Bun.file(new URL("../schema/lane.sql", import.meta.url)).text(),
    );
    expect(() =>
      sqlite
        .query(
          "INSERT INTO follow_lane (lane, holder, seq, run_colo, changed_at_ms, changed_by) VALUES (1, 'lane-a', 1, ?, 0, 1)",
        )
        .run(runColo),
    ).toThrow(/CHECK constraint failed/);
  },
);

// The shape parseColo admits is accepted, so the refusals above come from the
// check and not from a column that takes nothing.
test("lane.sql's record accepts an uppercase colo as the run colo", async () => {
  const sqlite = new Database(":memory:");
  sqlite.exec(
    await Bun.file(new URL("../schema/lane.sql", import.meta.url)).text(),
  );
  sqlite
    .query(
      "INSERT INTO follow_lane (lane, holder, seq, run_colo, changed_at_ms, changed_by) VALUES (1, 'lane-a', 1, 'ORD', 0, 1)",
    )
    .run();
  expect(sqlite.query("SELECT run_colo FROM follow_lane").all()).toEqual([
    { run_colo: "ORD" },
  ]);
});
