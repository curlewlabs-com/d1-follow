// An observation: where an object runs, and where its D1 primary was as of a
// recent result. Every decision this package makes starts from one, and an
// object without one serves where it is.
import type { Colo } from "./colo";
import type { PrimarySighting } from "./primary-colo";

// A lane works once a minute and a busy stateless object many times a minute,
// so an object doing its work sees the primary well inside ten minutes. An
// older sighting belongs to an object that has sat idle while the primary was
// free to move, and acting on it could send work to the colo the primary left.
export const OBSERVATION_MAX_AGE_MS = 10 * 60 * 1000;

export interface Observation {
  readonly self: Colo;
  readonly primary: Colo;
  readonly primaryAtMs: number;
}

// `nowMs` is the caller's clock, injected so the rule has no clock of its own.
export function currentObservation(
  self: Colo | null,
  primary: PrimarySighting | null,
  nowMs: number,
): Observation | null {
  if (self === null || primary === null) {
    return null;
  }
  const ageMs = nowMs - primary.atMs;
  // A sighting stamped after now means its time and now did not come from one
  // clock. Age cannot be judged then, and no observation is the safe answer.
  if (ageMs < 0 || ageMs > OBSERVATION_MAX_AGE_MS) {
    return null;
  }
  return { self, primary: primary.colo, primaryAtMs: primary.atMs };
}

// Where an object stands against its primary: the closed outcome every decision
// that follows an observation branches on. `apart` is a separation, the state
// a forward, a handoff or a report acts on; `unobserved` leaves the object
// serving where it is.
export type Placement =
  | { readonly kind: "unobserved" }
  | { readonly kind: "beside"; readonly colo: Colo }
  | { readonly kind: "apart"; readonly self: Colo; readonly primary: Colo };

export function placementOf(observation: Observation | null): Placement {
  if (observation === null) {
    return { kind: "unobserved" };
  }
  return observation.self === observation.primary
    ? { kind: "beside", colo: observation.self }
    : { kind: "apart", self: observation.self, primary: observation.primary };
}
