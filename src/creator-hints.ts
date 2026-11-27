// When a pass probes through each region hint for every class (README
// sec."Pacing the probes"): read from the hint's wait (hint-wait-store.ts) and
// the cap, CreatorConfig.maxBackoffMs. A hint with no wait, or one whose wait
// has passed, is in its round; a round that taught nothing doubles the wait,
// from a single skipped pass up to the cap.
import { passReading } from "./creator-gaps";
import type { HintWait } from "./hint-wait-store";

export interface HintPacing {
  // True when the pass's probes through the hint are a round.
  readonly round: boolean;
  // Why, for the pass's log: no wait; a wait the pass cannot trust, dropped;
  // a wait that has passed; one still running.
  readonly reason: "none" | "untrusted" | "due" | "waiting";
  // The wait the next one doubles, when the pass can trust it.
  readonly waitMs: number | null;
  // While the hint waits, the earliest start of a pass that is its round.
  readonly dueAtMs: number | null;
}

interface PassClock {
  readonly passStartMs: number;
  readonly capMs: number;
  readonly passIntervalMs: number;
}

// What `wait` makes of the hint in the pass that began at `at.passStartMs`.
// A wait longer than the cap, or due further ahead than its own length, is a
// cap since lowered, a clock that ran backward or a hand edit; trusting it
// could hold the probes back for as long as it says, so it is dropped. A cap
// no longer than a pass paces nothing, so under one every pass is a round.
export function paceHint(
  wait: HintWait | undefined,
  at: PassClock,
): HintPacing {
  if (wait === undefined || at.capMs <= at.passIntervalMs) {
    return { round: true, reason: "none", waitMs: null, dueAtMs: null };
  }
  if (wait.waitMs > at.capMs || wait.dueAtMs - at.passStartMs > wait.waitMs) {
    return { round: true, reason: "untrusted", waitMs: null, dueAtMs: null };
  }
  const dueAtMs = passReading(wait.dueAtMs, at.passIntervalMs);
  return at.passStartMs >= dueAtMs
    ? { round: true, reason: "due", waitMs: wait.waitMs, dueAtMs: null }
    : { round: false, reason: "waiting", waitMs: wait.waitMs, dueAtMs };
}

// The wait a round that taught nothing sets: twice the one it doubles, or two
// passes for a hint that had none, so the first wait skips a single pass; at
// most the cap. Null under a cap no longer than a pass, which paces nothing,
// so no wait is written.
export function nextHintWait(
  regionHint: string,
  pacing: HintPacing,
  at: PassClock,
): HintWait | null {
  if (at.capMs <= at.passIntervalMs) return null;
  const waitMs = Math.min(2 * (pacing.waitMs ?? at.passIntervalMs), at.capMs);
  return { regionHint, waitMs, dueAtMs: at.passStartMs + waitMs };
}
