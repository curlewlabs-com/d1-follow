// The candidate colos and region hints as the creator database keeps them, in
// the world creator-test-harness.ts sets up.
import { expect, test } from "bun:test";
import {
  addCandidateColo,
  addRegionHint,
  readCandidateColos,
  readRegionHints,
} from "./candidate-store";
import {
  CreatorWorld,
  DEN,
  HOUR_MS,
  MIA,
  ORD,
  T0_MS,
} from "./creator-test-harness";
import { readHintWaits, writeHintWait } from "./hint-wait-store";
import { claimPass } from "./pass-lease";

const HOLDER = "pass-1";

async function leased(): Promise<CreatorWorld> {
  const world = await CreatorWorld.open();
  await claimPass(world.handle(), {
    holder: HOLDER,
    nowMs: T0_MS,
    leaseMs: HOUR_MS,
  });
  return world;
}

// A colo or hint can be written again by a later pass, or a hint by a pass
// that lost its lease. The order each joined is the order a pass reports them
// in, so a second write must keep the first one's place rather than move or
// repeat it.
test("a colo or hint added twice keeps its first place", async () => {
  const db = (await leased()).handle();
  await addCandidateColo(db, ORD, T0_MS + 2, HOLDER);
  await addCandidateColo(db, MIA, T0_MS + 1, HOLDER);
  await addCandidateColo(db, DEN, T0_MS + 1, HOLDER);
  await addCandidateColo(db, MIA, T0_MS + 3, HOLDER);
  expect(await readCandidateColos(db)).toEqual([DEN, MIA, ORD]);

  await addRegionHint(db, "weur", T0_MS + 1);
  await addRegionHint(db, "wnam", T0_MS + 2);
  await addRegionHint(db, "weur", T0_MS + 3);
  expect(await readRegionHints(db)).toEqual(["weur", "wnam"]);
});

// A new colo says the hints have more to teach, so its add ends every hint's
// wait in the same batch: a pass that stopped between the two would otherwise
// leave a hint waiting a day after its probe found somewhere new.
test("adding a colo deletes every hint's wait in its batch", async () => {
  const db = (await leased()).handle();
  for (const regionHint of ["enam", "weur"]) {
    await writeHintWait(
      db,
      { regionHint, waitMs: 2 * HOUR_MS, dueAtMs: T0_MS + 2 * HOUR_MS },
      HOLDER,
    );
  }
  expect(await addCandidateColo(db, DEN, T0_MS, HOLDER)).toBe(true);
  expect(await readHintWaits(db)).toEqual([]);
});

// The risk this guards: a pass that stalled past its lease adding a colo, or
// deleting the waits, after the pass holding the lease has set one.
test("a pass without the lease adds no colo and deletes no wait", async () => {
  const db = (await leased()).handle();
  const wait = {
    regionHint: "enam",
    waitMs: 2 * HOUR_MS,
    dueAtMs: T0_MS + 2 * HOUR_MS,
  };
  await writeHintWait(db, wait, HOLDER);
  expect(await addCandidateColo(db, DEN, T0_MS, "pass-0")).toBe(false);
  expect(await readCandidateColos(db)).toEqual([]);
  expect(await readHintWaits(db)).toEqual([wait]);
});
