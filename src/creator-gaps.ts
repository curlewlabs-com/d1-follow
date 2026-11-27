// When a pass attempts the gap in the primary's colo (README sec."The creator:
// making and keeping slots"): read from the gap's record (gap-store.ts) and
// the cap, CreatorConfig.maxBackoffMs. A gap is young for the cap from the
// pass that made its first creation, and attempted on every pass while it is;
// once old, it is attempted when the cap has passed since its last attempt.
import type { GapRecord } from "./gap-store";

export interface AttemptPacing {
  readonly due: boolean;
  // When the gap's record begins, for the record a pass that attempts writes.
  readonly begunAtMs: number;
  // Why, for the pass's log: no record yet; a record the pass cannot trust,
  // dropped; a record that had no attempt since it began, starting over; a
  // young gap; an old one whose wait has passed; an old one still waiting.
  readonly reason:
    "new" | "untrusted" | "restarted" | "young" | "old" | "waiting";
  // While the gap waits, the earliest start of a pass that attempts it.
  readonly dueAtMs: number | null;
}

// What `record` makes of the pass that began at `passStartMs`. A threshold is
// read by a pass, never timed: it ends on the first pass that begins at or
// after it, less half a pass, so a cron that fires a little early is not taken
// for one that came too soon. The time between attempts once a gap is old is
// a whole number of passes, and can run up to a pass past the cap.
export function paceAttempts(
  record: GapRecord | undefined,
  at: {
    readonly passStartMs: number;
    readonly capMs: number;
    readonly passIntervalMs: number;
  },
): AttemptPacing {
  const { passStartMs } = at;
  const fresh = (reason: "new" | "untrusted" | "restarted"): AttemptPacing => ({
    due: true,
    begunAtMs: passStartMs,
    reason,
    dueAtMs: null,
  });
  if (record === undefined) return fresh("new");
  const { begunAtMs, attemptedAtMs } = record;
  // A time ahead of the pass, or an attempt before the record began, is a
  // clock that ran backward or a hand edit. Trusting it could hold the
  // attempts back for as long as it says, so the record is dropped instead.
  if (
    begunAtMs > passStartMs ||
    (attemptedAtMs !== null &&
      (attemptedAtMs < begunAtMs || attemptedAtMs > passStartMs))
  ) {
    return fresh("untrusted");
  }
  // A record with no attempt through the primary's hint since it began has
  // paced none, so the attempts start it over: their young day begins with
  // the first pass that can make one.
  if (attemptedAtMs === null) return fresh("restarted");
  const passReading = (thresholdMs: number): number =>
    thresholdMs - at.passIntervalMs / 2;
  if (passStartMs < passReading(begunAtMs + at.capMs)) {
    return { due: true, begunAtMs, reason: "young", dueAtMs: null };
  }
  const dueAtMs = passReading(attemptedAtMs + at.capMs);
  return passStartMs >= dueAtMs
    ? { due: true, begunAtMs, reason: "old", dueAtMs: null }
    : { due: false, begunAtMs, reason: "waiting", dueAtMs };
}
