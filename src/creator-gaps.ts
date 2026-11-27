// What a gap's record (gap-store.ts) makes due, under the cap,
// CreatorConfig.maxBackoffMs (README sec."The creator: making and keeping
// slots"): the attempts at the gap in the primary's colo, and whether the gap
// keeps its class probing on every pass. A gap is young for the cap from the
// pass that made its first creation, a probe or an attempt. While it is young
// its class probes on every pass and the attempts at it run on every pass;
// once old, it is attempted when the cap has passed since its last attempt,
// and its class probes only in the hints' rounds (creator-hints.ts).
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

interface PassClock {
  readonly passStartMs: number;
  readonly capMs: number;
  readonly passIntervalMs: number;
}

// A threshold is read by a pass, never timed: it ends on the first pass that
// begins at or after it, less half a pass, so a cron that fires a little early
// is not taken for one that came too soon. The time between two passes a
// threshold spaces is so a whole number of passes, and can run up to a pass
// past it.
export function passReading(
  thresholdMs: number,
  passIntervalMs: number,
): number {
  return thresholdMs - passIntervalMs / 2;
}

// A time ahead of the pass, or an attempt before the record began, is a clock
// that ran backward or a hand edit. Trusting it could hold the creations back
// for as long as it says, so the record is dropped instead.
export function untrustedGap(record: GapRecord, passStartMs: number): boolean {
  const { begunAtMs, attemptedAtMs } = record;
  return (
    begunAtMs > passStartMs ||
    (attemptedAtMs !== null &&
      (attemptedAtMs < begunAtMs || attemptedAtMs > passStartMs))
  );
}

// What `record` makes of the attempts in the pass that began at
// `at.passStartMs`.
export function paceAttempts(
  record: GapRecord | undefined,
  at: PassClock,
): AttemptPacing {
  const { passStartMs } = at;
  const fresh = (reason: "new" | "untrusted" | "restarted"): AttemptPacing => ({
    due: true,
    begunAtMs: passStartMs,
    reason,
    dueAtMs: null,
  });
  if (record === undefined) return fresh("new");
  if (untrustedGap(record, passStartMs)) return fresh("untrusted");
  const { begunAtMs, attemptedAtMs } = record;
  // A record with no attempt through the primary's hint since it began has
  // paced none, so the attempts start it over: their young day begins with
  // the first pass that can make one.
  if (attemptedAtMs === null) return fresh("restarted");
  if (passStartMs < passReading(begunAtMs + at.capMs, at.passIntervalMs)) {
    return { due: true, begunAtMs, reason: "young", dueAtMs: null };
  }
  const dueAtMs = passReading(attemptedAtMs + at.capMs, at.passIntervalMs);
  return passStartMs >= dueAtMs
    ? { due: true, begunAtMs, reason: "old", dueAtMs: null }
    : { due: false, begunAtMs, reason: "waiting", dueAtMs };
}

// Whether a gap keeps its class probing through every hint in the pass that
// began at `at.passStartMs`, whatever the hints' waits: a gap no pass has
// created for, or whose record the pass cannot trust, does, as a young gap
// does. Age alone is never a reason to distrust a record; an old gap is old.
export function keepsProbing(
  record: GapRecord | undefined,
  at: PassClock,
): boolean {
  return (
    record === undefined ||
    untrustedGap(record, at.passStartMs) ||
    at.passStartMs < passReading(record.begunAtMs + at.capMs, at.passIntervalMs)
  );
}
