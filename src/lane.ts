// A singleton lane's record and the decision an object makes when work arrives
// for it (README sec."Singleton lanes: admit, redirect, hand off under the
// lock").
//
// The record lives in the app's own database (schema/lane.sql), read in the
// first query of every unit of work. The app runs that query in its own query
// model, beside its other first-query statements, and hands the row here.

import type { Colo } from "./colo";
import type { Placement } from "./observation";

// The codes schema/lane.sql's changed_by column holds, for the app's queries.
export const LANE_CHANGED_BY = {
  seeded: 1,
  handed_off: 2,
  operator: 3,
} as const;

export interface LaneRecord {
  readonly holder: string;
  // Every change to the holder compares this and sets it one higher.
  readonly seq: number;
}

export type Admission =
  // No record yet: insert one naming the deployment's default holder with
  // INSERT OR IGNORE, read it back, and decide again from what was read.
  | { readonly kind: "seed" }
  | { readonly kind: "work" }
  // Another object holds the lane: refuse before any work and name it, so the
  // caller can go there.
  | { readonly kind: "redirect"; readonly holder: string };

// `self` is the deciding object's own name.
export function admit(record: LaneRecord | null, self: string): Admission {
  if (record === null) {
    return { kind: "seed" };
  }
  return record.holder === self
    ? { kind: "work" }
    : { kind: "redirect", holder: record.holder };
}

// The holder's run: how many consecutive observations have put the primary in
// the same other colo, kept on its lane record (schema/lane.sql's run_*
// columns) and counted after each unit of work, under the lane's lock.
export interface LaneRun {
  readonly colo: Colo | null;
  readonly count: number;
  readonly lastAtMs: number | null;
}

export const NO_RUN: LaneRun = { colo: null, count: 0, lastAtMs: null };

// Observations before the lane hands off. It is also the lane's rate limit: a
// new holder starts its own run, so a lane changes hands at most once per
// threshold. Five is about five minutes for a lane that works once a minute.
export const LANE_HANDOFF_THRESHOLD = 5;

// A run whose last observation is older than this starts again: in between,
// the primary was free to move away and back unseen.
export const LANE_RUN_MAX_GAP_MS = 2 * 60 * 60 * 1000;

// The least time the creator lets an object sit out of the registry before it
// releases it, whatever its class's own delay. A handoff validates its target
// while the target is registered and then commits the holder swap as a
// separate write, which can land after the caller stopped waiting for it; a
// release decided in between would see the old holder and clear the new one's
// marker. Waiting this long after unregistering lets any such handoff land
// first, so the release's holder check sees it. An app whose handoff can still
// commit later than this excludes handoffs through the release itself.
export const LANE_HANDOFF_SETTLE_MS = 15 * 60 * 1000;

// The run after this unit of work's placement. A unit that observed nothing
// leaves the run as it was; one beside the primary ends it.
export function nextLaneRun(
  run: LaneRun,
  placement: Placement,
  nowMs: number,
): LaneRun {
  switch (placement.kind) {
    case "unobserved":
      return run;
    case "beside":
      return NO_RUN;
    case "apart": {
      const gapMs = run.lastAtMs === null ? null : nowMs - run.lastAtMs;
      // A last observation stamped after now means it and now came from
      // different clocks, so the run cannot be judged and starts again.
      const continues =
        run.colo === placement.primary &&
        gapMs !== null &&
        gapMs >= 0 &&
        gapMs <= LANE_RUN_MAX_GAP_MS;
      return {
        colo: placement.primary,
        count: continues ? run.count + 1 : 1,
        lastAtMs: nowMs,
      };
    }
  }
}

// The colo the lane should hand off to once its run has reached the
// threshold, or null. Handing off also needs a verified slot of the lane's
// class there, which the caller looks up.
export function handoffColo(run: LaneRun): Colo | null {
  return run.colo !== null && run.count >= LANE_HANDOFF_THRESHOLD
    ? run.colo
    : null;
}
