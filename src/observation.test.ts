import { describe, expect, test } from "bun:test";
import type { Colo } from "./colo";
import {
  currentObservation,
  OBSERVATION_MAX_AGE_MS,
  placementOf,
} from "./observation";
import { PrimaryObserver } from "./primary-colo";

const ORD = "ORD" as Colo;
const MIA = "MIA" as Colo;
const NOW_MS = Date.UTC(2026, 8, 29, 8, 0, 0);
const MINUTE_MS = 60_000;

describe("currentObservation", () => {
  test("a fresh sighting and a known own colo make an observation", () => {
    expect(
      currentObservation(
        ORD,
        { colo: MIA, atMs: NOW_MS - 5 * MINUTE_MS },
        NOW_MS,
      ),
    ).toEqual({ self: ORD, primary: MIA, primaryAtMs: NOW_MS - 5 * MINUTE_MS });
  });

  test("a sighting exactly at the age bound still counts", () => {
    const atMs = NOW_MS - OBSERVATION_MAX_AGE_MS;
    expect(currentObservation(ORD, { colo: MIA, atMs }, NOW_MS)).toEqual({
      self: ORD,
      primary: MIA,
      primaryAtMs: atMs,
    });
  });

  // An idle object's last sighting can predate a move. Acting on it would send
  // work to the colo the primary left.
  test("a sighting older than the bound is no observation", () => {
    expect(
      currentObservation(
        ORD,
        { colo: MIA, atMs: NOW_MS - OBSERVATION_MAX_AGE_MS - 1 },
        NOW_MS,
      ),
    ).toBeNull();
  });

  test("a missing sighting is no observation", () => {
    expect(currentObservation(ORD, null, NOW_MS)).toBeNull();
  });

  test("a missing own colo is no observation", () => {
    expect(
      currentObservation(null, { colo: MIA, atMs: NOW_MS }, NOW_MS),
    ).toBeNull();
  });

  // Clocks that disagree cannot say how old a sighting is, and a sighting
  // stamped in the future would otherwise stay fresh for as long as it is
  // ahead.
  test("a sighting stamped after now is no observation", () => {
    expect(
      currentObservation(ORD, { colo: MIA, atMs: NOW_MS + 1 }, NOW_MS),
    ).toBeNull();
  });

  test("an object whose D1 work only replicas served has no observation", () => {
    const observer = new PrimaryObserver();
    observer.note(
      [{ served_by_primary: false, served_by_colo: "ORD" }],
      () => NOW_MS - MINUTE_MS,
    );
    expect(currentObservation(ORD, observer.latest(), NOW_MS)).toBeNull();
  });
});

describe("placementOf", () => {
  test("no observation leaves the object unobserved", () => {
    expect(placementOf(null)).toEqual({ kind: "unobserved" });
  });

  test("an object in its primary's colo is beside it", () => {
    expect(
      placementOf({ self: ORD, primary: ORD, primaryAtMs: NOW_MS }),
    ).toEqual({ kind: "beside", colo: ORD });
  });

  // The separation every later decision acts on: reading it as `beside` would
  // leave an object paying a cross-colo round trip on every query it makes.
  test("an object in another colo than its primary is apart", () => {
    expect(
      placementOf({ self: ORD, primary: MIA, primaryAtMs: NOW_MS }),
    ).toEqual({ kind: "apart", self: ORD, primary: MIA });
  });
});
