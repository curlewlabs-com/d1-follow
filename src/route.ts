// The routing a stateless object does before any work (README sec."Stateless
// objects: route, forward once, hint"): forward the request once to the slot
// beside the primary, or serve it here, and what its answer hints the caller
// toward. The object supplies its placement, its own name, the request's hop
// count and its copy of the registry; the app decides what a forward costs and
// whether it is allowed to make one.
import type { Colo } from "./colo";
import type { Placement } from "./observation";

// A registered slot of the object's own class: where the router may send work.
export interface RouteSlot {
  readonly name: string;
  readonly colo: Colo;
}

export type RouteDecision =
  // Hand the request to `to` with a hop count of one, and answer with its
  // answer, hinting its name.
  | { readonly kind: "forward"; readonly to: RouteSlot }
  // Serve the request here. `gap` is the primary's colo when the primary is
  // apart and the registry copy holds no slot there, for the app to report.
  | { readonly kind: "serve"; readonly gap: Colo | null };

export interface RouteInput {
  readonly placement: Placement;
  // The deciding object's own name.
  readonly self: string;
  // Times the request has been forwarded: zero from the caller, one from a
  // forward. A forwarded request is served where it lands, so no request
  // bounces between objects.
  readonly hop: number;
  // The verified slot of the object's class in `colo`, from its registry copy,
  // or null.
  readonly slotIn: (colo: Colo) => RouteSlot | null;
}

// Decided before any of the request's own D1 work, so a forward can never
// repeat a write the object already made.
export function routeRequest(input: RouteInput): RouteDecision {
  const { placement } = input;
  if (placement.kind !== "apart") {
    return { kind: "serve", gap: null };
  }
  const slot = input.slotIn(placement.primary);
  if (slot === null) {
    return { kind: "serve", gap: placement.primary };
  }
  // The slot is this object when its registry copy places it beside the
  // primary but its own observation puts it apart: the copy is older than its
  // move, and the next read corrects it. Serving here is the safe answer.
  if (input.hop > 0 || slot.name === input.self) {
    return { kind: "serve", gap: null };
  }
  return { kind: "forward", to: slot };
}

// The name an answer hints its caller toward, from the observation the
// request's own D1 results left: the slot beside the primary when the primary
// is apart from this object, or null. A caller that caches it goes there
// directly next time.
export function hintAfter(input: Omit<RouteInput, "hop">): string | null {
  const decision = routeRequest({ ...input, hop: 0 });
  return decision.kind === "forward" ? decision.to.name : null;
}

// How long an object's registry copy serves before it is read again, and how
// soon it is read again while the primary's colo has no slot in it, so a slot
// the creator has just made is used within a minute.
export const ROUTE_REGISTRY_MAX_AGE_MS = 10 * 60 * 1000;
export const ROUTE_REGISTRY_GAP_RETRY_MS = 60 * 1000;

// How long an object serves requests itself after a forward fails. A forward
// that fails cannot be served here, since the slot may have run it, so without
// this one dead slot would fail every request sent its way for as long as the
// registry still calls it verified. With it, each object fails what it has in
// flight and serves apart, slow rather than down, then tries the slot again when
// this passes, so a slot that stays dead costs a batch per object per cooldown
// until the registry drops it. A failed request's caller retries into the window.
export const ROUTE_FORWARD_COOLDOWN_MS = 60 * 1000;

// Whether a forward that failed at `failedAtMs` still holds this object back. A
// failure stamped later than now came from another clock, so its age cannot be
// judged and it holds, as the registry read's age is judged the safe way.
export function forwardCoolingDown(input: {
  readonly failedAtMs: number | null;
  readonly nowMs: number;
}): boolean {
  if (input.failedAtMs === null) {
    return false;
  }
  const ageMs = input.nowMs - input.failedAtMs;
  return ageMs < 0 || ageMs < ROUTE_FORWARD_COOLDOWN_MS;
}

// Whether the object should read the registry again, after its response. A
// copy read at a time later than now came from another clock, so its age
// cannot be judged and it is read again.
export function registryReadDue(input: {
  readonly lastReadAtMs: number | null;
  readonly nowMs: number;
  // True when the primary is apart and the copy holds no slot in its colo.
  readonly gap: boolean;
}): boolean {
  if (input.lastReadAtMs === null) {
    return true;
  }
  const ageMs = input.nowMs - input.lastReadAtMs;
  if (ageMs < 0) {
    return true;
  }
  return (
    ageMs >=
    (input.gap ? ROUTE_REGISTRY_GAP_RETRY_MS : ROUTE_REGISTRY_MAX_AGE_MS)
  );
}
