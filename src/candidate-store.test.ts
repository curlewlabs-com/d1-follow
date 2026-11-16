// The candidate colos and region hints as the creator database keeps them, in
// the world creator-test-harness.ts sets up.
import { expect, test } from "bun:test";
import {
  addCandidateColo,
  addRegionHint,
  readCandidateColos,
  readRegionHints,
} from "./candidate-store";
import { CreatorWorld, DEN, MIA, ORD, T0_MS } from "./creator-test-harness";

// A pass that lost its lease can write a colo or hint that the pass holding it
// writes too. The order each joined is the order a pass reports them in, so a
// second write must keep the first one's place rather than move or repeat it.
test("a colo or hint added twice keeps its first place", async () => {
  const db = (await CreatorWorld.open()).handle();
  await addCandidateColo(db, ORD, T0_MS + 2);
  await addCandidateColo(db, MIA, T0_MS + 1);
  await addCandidateColo(db, DEN, T0_MS + 1);
  await addCandidateColo(db, MIA, T0_MS + 3);
  expect(await readCandidateColos(db)).toEqual([DEN, MIA, ORD]);

  await addRegionHint(db, "weur", T0_MS + 1);
  await addRegionHint(db, "wnam", T0_MS + 2);
  await addRegionHint(db, "weur", T0_MS + 3);
  expect(await readRegionHints(db)).toEqual(["weur", "wnam"]);
});
