import { describe, expect, test } from "bun:test";
import type { Colo } from "./colo";
import {
  PrimaryObserver,
  primaryColoOf,
  primaryPlacementOf,
} from "./primary-colo";

const ORD = "ORD" as Colo;
const MIA = "MIA" as Colo;
const SEEN_AT_MS = Date.UTC(2026, 8, 29, 7, 45, 0);

describe("primaryColoOf", () => {
  test("a primary-served result names the primary's colo", () => {
    expect(
      primaryColoOf({ served_by_primary: true, served_by_colo: "MIA" }),
    ).toBe(MIA);
  });

  test("a runtime that reports the flag as 1 is read the same way", () => {
    expect(primaryColoOf({ served_by_primary: 1, served_by_colo: "MIA" })).toBe(
      MIA,
    );
  });

  // A replica's colo is where the replica is. Taking it for the primary's would
  // send work away from the primary.
  test("a replica-served result yields no colo", () => {
    expect(
      primaryColoOf({ served_by_primary: false, served_by_colo: "SEA" }),
    ).toBeNull();
    expect(
      primaryColoOf({ served_by_primary: 0, served_by_colo: "SEA" }),
    ).toBeNull();
  });

  test("a result without served_by_primary yields no colo", () => {
    expect(primaryColoOf({ served_by_colo: "ORD" })).toBeNull();
  });

  // served_by_colo is undocumented, so its absence or a change of shape has to
  // read as no observation rather than as a colo.
  test("a primary-served result without a well-formed colo yields none", () => {
    expect(primaryColoOf({ served_by_primary: true })).toBeNull();
    expect(
      primaryColoOf({ served_by_primary: true, served_by_colo: null }),
    ).toBeNull();
    expect(
      primaryColoOf({ served_by_primary: true, served_by_colo: "ord" }),
    ).toBeNull();
  });

  // The meta is an undocumented platform object. A value that is not an object
  // at all must read as no observation; a throw here would fail the work the
  // object was doing for a telemetry read.
  test("a meta that is not an object yields no colo", () => {
    expect(primaryColoOf(null)).toBeNull();
    expect(primaryColoOf(undefined)).toBeNull();
    expect(primaryColoOf("served_by_colo=ORD")).toBeNull();
    expect(primaryColoOf(1)).toBeNull();
  });
});

describe("primaryPlacementOf", () => {
  // The creator probes through the hint this names once the primary is seen
  // outside the regions it already probes, so the region has to map onto a
  // hint a creation can name.
  test("names the location hint for the primary's region", () => {
    expect(
      primaryPlacementOf({
        served_by_primary: true,
        served_by_colo: "AMS",
        served_by_region: "WEUR",
      }),
    ).toEqual({ colo: "AMS" as Colo, region: "WEUR", regionHint: "weur" });
  });

  // A region D1 does not run databases in, or a value of another shape, is
  // no hint: probing through a guessed one would spend creations for nothing.
  test("a region that is no D1 region names no hint", () => {
    for (const region of ["MARS", "SAM", "", 7, null, undefined]) {
      expect(
        primaryPlacementOf({
          served_by_primary: true,
          served_by_colo: "ORD",
          served_by_region: region,
        }),
      ).toEqual({
        colo: ORD,
        region: typeof region === "string" ? region : null,
        regionHint: null,
      });
    }
  });

  // A replica's region is the replica's, so a replica-served result says
  // nothing about where the primary runs.
  test("a replica-served result is no placement", () => {
    expect(
      primaryPlacementOf({
        served_by_primary: false,
        served_by_colo: "DEN",
        served_by_region: "WNAM",
      }),
    ).toBeNull();
  });
});

describe("PrimaryObserver", () => {
  test("a batch's primary-served meta is found after a replica-served one", () => {
    const observer = new PrimaryObserver();
    observer.note(
      [
        { served_by_primary: false, served_by_colo: "SEA" },
        { served_by_primary: true, served_by_colo: "ORD" },
      ],
      () => SEEN_AT_MS,
    );
    expect(observer.latest()).toEqual({ colo: ORD, atMs: SEEN_AT_MS });
  });

  test("metas that are not objects are skipped, not thrown on", () => {
    const observer = new PrimaryObserver();
    observer.note(
      [null, 7, { served_by_primary: true, served_by_colo: "ORD" }],
      () => SEEN_AT_MS,
    );
    expect(observer.latest()).toEqual({ colo: ORD, atMs: SEEN_AT_MS });
  });

  test("a later sighting replaces an earlier one, so a move is followed", () => {
    const observer = new PrimaryObserver();
    observer.note(
      [{ served_by_primary: true, served_by_colo: "ORD" }],
      () => SEEN_AT_MS,
    );
    observer.note(
      [{ served_by_primary: true, served_by_colo: "MIA" }],
      () => SEEN_AT_MS + 60_000,
    );
    expect(observer.latest()).toEqual({ colo: MIA, atMs: SEEN_AT_MS + 60_000 });
  });

  // Reads go to replicas between writes. If a replica result erased the last
  // sighting, an object would lose its observation on every read.
  test("a replica-only call keeps the earlier sighting", () => {
    const observer = new PrimaryObserver();
    observer.note(
      [{ served_by_primary: true, served_by_colo: "ORD" }],
      () => SEEN_AT_MS,
    );
    observer.note(
      [{ served_by_primary: false, served_by_colo: "SEA" }],
      () => SEEN_AT_MS + 60_000,
    );
    expect(observer.latest()).toEqual({ colo: ORD, atMs: SEEN_AT_MS });
  });

  // An app feeds every D1 result through this, often inside its own timing
  // code; a clock read per result would cost for nothing and shift that code's
  // own readings.
  test("a call that records no sighting never reads the clock", () => {
    const observer = new PrimaryObserver();
    let reads = 0;
    observer.note(
      [null, { served_by_primary: false, served_by_colo: "SEA" }],
      () => {
        reads += 1;
        return SEEN_AT_MS;
      },
    );
    expect(reads).toBe(0);
  });

  test("an observer that has seen only replicas has no sighting", () => {
    const observer = new PrimaryObserver();
    observer.note(
      [{ served_by_primary: false, served_by_colo: "SEA" }],
      () => SEEN_AT_MS,
    );
    expect(observer.latest()).toBeNull();
  });
});
