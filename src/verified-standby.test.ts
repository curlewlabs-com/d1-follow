import { Database } from "bun:sqlite";
import { afterEach, beforeEach, expect, test } from "bun:test";
import type { Colo } from "./colo";
import { sqliteHandle } from "./sqlite-test-handle";
import { readVerifiedStandby, type StandbyLookup } from "./verified-standby";

const now = Date.UTC(2026, 0, 2, 1);
const lookup: StandbyLookup = {
  classCode: 1,
  primaryColo: "ORD" as Colo,
  configuredServingName: "configured",
  attemptedName: "configured",
  nowMs: now,
  verifiedMaxAgeMs: 3000,
  releaseAfterMs: 5000,
};
let sqlite: Database;

beforeEach(async () => {
  sqlite = new Database(":memory:");
  sqlite.run(
    await Bun.file(new URL("../schema/creator.sql", import.meta.url)).text(),
  );
});
afterEach(() => sqlite.close());

function add(
  table: "follow_slot" | "follow_spare",
  name: string,
  verified: number | null,
  classCode = 1,
  colo = "ORD",
) {
  sqlite
    .query(
      `INSERT INTO ${table} (class_code,colo,name,object_id,registered_at_ms,verified_at_ms)
     VALUES (?,?,?,?,?,?)`,
    )
    .run(classCode, colo, name, name + "-id", now - 10000, verified);
}

const read = (override: Partial<StandbyLookup> = {}) =>
  readVerifiedStandby(sqliteHandle(sqlite), { ...lookup, ...override });

test("a configured name outlives its registration but cannot grant a hint that authority", async () => {
  add("follow_spare", "spare", now - 100);
  expect(await read()).toEqual({ name: "spare", expiresAtMs: now + 2900 });
  expect(await read({ attemptedName: "old-hint" })).toBeNull();
  // A still-registered base can be apart after the primary moves.
  add("follow_slot", "old-hint", now - 1800, 1, "MIA");
  expect(await read({ attemptedName: "old-hint" })).toEqual({
    name: "spare",
    expiresAtMs: now + 1200,
  });
  expect(await read({ releaseAfterMs: 200 })).toEqual({
    name: "spare",
    expiresAtMs: now + 200,
  });
  expect(await read({ releaseAfterMs: 0 })).toBeNull();
});

test.each([null, now - 3000, now + 1])(
  "ignores a spare or hinted base with an ineligible stamp (%s)",
  async (stamp) => {
    add("follow_spare", "a", stamp);
    expect(await read()).toBeNull();
    add("follow_spare", "z", now);
    add("follow_slot", "hint", stamp);
    expect(await read({ attemptedName: "hint" })).toBeNull();
    expect((await read())?.name).toBe("z");
  },
);

test("only a distinct spare of the requested class at the current primary can serve", async () => {
  add("follow_spare", "configured", now);
  add("follow_spare", "other-class", now, 2);
  add("follow_spare", "other-colo", now, 1, "MIA");
  // Promotion may leave a verified base and no replacement spare.
  add("follow_slot", "promoted", now);
  expect(await read()).toBeNull();
});

test("invalid timing cannot issue a name past its safe expiry", async () => {
  add("follow_spare", "spare", now);
  await expect(read({ verifiedMaxAgeMs: Infinity })).rejects.toThrow(
    RangeError,
  );
  await expect(
    read({
      nowMs: Number.MAX_SAFE_INTEGER,
      verifiedMaxAgeMs: Number.MAX_SAFE_INTEGER,
      releaseAfterMs: 1,
    }),
  ).rejects.toThrow(RangeError);
});
