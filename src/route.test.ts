// The stateless router's decisions, from observations built the way an object
// builds them (currentObservation, placementOf), with a pinned clock.
import { describe, expect, test } from "bun:test";
import type { Colo } from "./colo";
import {
  currentObservation,
  OBSERVATION_MAX_AGE_MS,
  placementOf,
  type Placement,
} from "./observation";
import {
  forwardCoolingDown,
  hintAfter,
  registryReadDue,
  ROUTE_FORWARD_COOLDOWN_MS,
  ROUTE_REGISTRY_GAP_RETRY_MS,
  ROUTE_REGISTRY_MAX_AGE_MS,
  routeRequest,
  type RouteSlot,
} from "./route";

const ORD = "ORD" as Colo;
const MIA = "MIA" as Colo;
const NOW_MS = Date.UTC(2026, 9, 8, 21, 0, 0);
const SELF = "handler-test-enam-1";
const MIA_SLOT: RouteSlot = { name: "handler-test-enam-2", colo: MIA };

// An object in ORD that last saw its primary in `primary`, `ageMs` ago.
function placed(primary: Colo, ageMs = 0): Placement {
  return placementOf(
    currentObservation(ORD, { colo: primary, atMs: NOW_MS - ageMs }, NOW_MS),
  );
}

const slots =
  (...held: RouteSlot[]) =>
  (colo: Colo): RouteSlot | null =>
    held.find((slot) => slot.colo === colo) ?? null;

describe("routeRequest", () => {
  // The whole mechanism: a fresh observation of the primary in another colo,
  // with a slot waiting there, sends the request there once.
  test("forwards a fresh separated request to the slot beside the primary", () => {
    expect(
      routeRequest({
        placement: placed(MIA),
        self: SELF,
        hop: 0,
        slotIn: slots(MIA_SLOT),
      }),
    ).toEqual({ kind: "forward", to: MIA_SLOT });
  });

  // A forwarded request is served where it lands, even by a slot that finds
  // itself apart too; otherwise objects with crossed observations could
  // pass a request back and forth.
  test("serves a request already forwarded once", () => {
    expect(
      routeRequest({
        placement: placed(MIA),
        self: SELF,
        hop: 1,
        slotIn: slots(MIA_SLOT),
      }),
    ).toEqual({ kind: "serve", gap: null });
  });

  // An object that sat idle while the primary was free to move cannot know
  // where it went, so an old sighting sends nothing anywhere.
  test("serves on a sighting older than the observation window", () => {
    expect(
      routeRequest({
        placement: placed(MIA, OBSERVATION_MAX_AGE_MS + 1),
        self: SELF,
        hop: 0,
        slotIn: slots(MIA_SLOT),
      }),
    ).toEqual({ kind: "serve", gap: null });
  });

  test("serves beside the primary", () => {
    expect(
      routeRequest({
        placement: placed(ORD),
        self: SELF,
        hop: 0,
        slotIn: slots(MIA_SLOT),
      }),
    ).toEqual({ kind: "serve", gap: null });
  });

  // No slot where the primary is: the request is served here, apart, and the
  // colo is reported as the gap the creator has to fill.
  test("serves and names the gap when no slot waits beside the primary", () => {
    expect(
      routeRequest({
        placement: placed(MIA),
        self: SELF,
        hop: 0,
        slotIn: slots(),
      }),
    ).toEqual({ kind: "serve", gap: MIA });
  });

  // The copy places this object beside the primary, but its own observation
  // puts it apart: the copy predates its move, and forwarding to itself would
  // be a loop.
  test("serves when the slot beside the primary is this object", () => {
    expect(
      routeRequest({
        placement: placed(MIA),
        self: MIA_SLOT.name,
        hop: 0,
        slotIn: slots(MIA_SLOT),
      }),
    ).toEqual({ kind: "serve", gap: null });
  });
});

describe("hintAfter", () => {
  test("names the slot beside a primary the request saw apart", () => {
    expect(
      hintAfter({
        placement: placed(MIA),
        self: SELF,
        slotIn: slots(MIA_SLOT),
      }),
    ).toBe(MIA_SLOT.name);
  });

  test("hints nothing beside the primary, or with no slot there", () => {
    expect(
      hintAfter({
        placement: placed(ORD),
        self: SELF,
        slotIn: slots(MIA_SLOT),
      }),
    ).toBeNull();
    expect(
      hintAfter({ placement: placed(MIA), self: SELF, slotIn: slots() }),
    ).toBeNull();
  });
});

describe("registryReadDue", () => {
  test("reads a copy it has never read", () => {
    expect(
      registryReadDue({ lastReadAtMs: null, nowMs: NOW_MS, gap: false }),
    ).toBe(true);
  });

  // The copy serves ten minutes, the cost the design is sized from.
  test("keeps a copy until it is ten minutes old", () => {
    const due = (ageMs: number) =>
      registryReadDue({
        lastReadAtMs: NOW_MS - ageMs,
        nowMs: NOW_MS,
        gap: false,
      });
    expect(due(ROUTE_REGISTRY_MAX_AGE_MS - 1)).toBe(false);
    expect(due(ROUTE_REGISTRY_MAX_AGE_MS)).toBe(true);
  });

  // While the primary's colo has no slot in the copy, a slot the creator has
  // just made should be found within a minute, not ten.
  test("reads again within a minute while the primary's colo is a gap", () => {
    const due = (ageMs: number) =>
      registryReadDue({
        lastReadAtMs: NOW_MS - ageMs,
        nowMs: NOW_MS,
        gap: true,
      });
    expect(due(ROUTE_REGISTRY_GAP_RETRY_MS - 1)).toBe(false);
    expect(due(ROUTE_REGISTRY_GAP_RETRY_MS)).toBe(true);
  });

  test("reads again when the copy's time is later than now", () => {
    expect(
      registryReadDue({
        lastReadAtMs: NOW_MS + 1,
        nowMs: NOW_MS,
        gap: false,
      }),
    ).toBe(true);
  });
});

describe("forwardCoolingDown", () => {
  const FAILED_AT_MS = 1_000_000;

  test("holds nothing back with no failure", () => {
    expect(forwardCoolingDown({ failedAtMs: null, nowMs: FAILED_AT_MS })).toBe(
      false,
    );
  });

  test("holds until the cooldown has passed", () => {
    const at = (elapsedMs: number) =>
      forwardCoolingDown({
        failedAtMs: FAILED_AT_MS,
        nowMs: FAILED_AT_MS + elapsedMs,
      });
    expect(at(0)).toBe(true);
    expect(at(ROUTE_FORWARD_COOLDOWN_MS - 1)).toBe(true);
    expect(at(ROUTE_FORWARD_COOLDOWN_MS)).toBe(false);
  });

  // A clock that stepped back must not release a slot that just failed.
  test("holds when the failure is stamped ahead of now", () => {
    expect(
      forwardCoolingDown({ failedAtMs: FAILED_AT_MS, nowMs: FAILED_AT_MS - 1 }),
    ).toBe(true);
  });
});
