// How a creator pass reads its pacing thresholds (README sec."Pacing the
// probes" and sec."Pacing the attempts"): the clock a pass's pacing decisions
// read, and when a threshold ends for a pass. The gaps' pacing
// (creator-gaps.ts) and the hints' (creator-hints.ts) both read it.

// The pass's start, the cap on its pacing (CreatorConfig.maxBackoffMs), and
// the time between passes.
export interface PassClock {
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
