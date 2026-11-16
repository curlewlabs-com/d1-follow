// The creator's modes on real SQLite with schema/creator.sql applied: what a
// class's or lane's mode is, and what it was. They touch follow_mode and the
// ledger's mode rows alone, so they build and run apart from the registry and
// the release queue creator-store.test.ts covers.
import { Database } from "bun:sqlite";
import { beforeEach, describe, expect, test } from "bun:test";
import {
  readLaneModeChanges,
  readModes,
  setMode,
  type SqlDatabase,
} from "./creator-store";
import { sqliteHandle } from "./sqlite-test-handle";

const AT_MS = Date.UTC(2026, 9, 5, 23, 0, 0);
const STATELESS_CLASS = 1;

let sqlite: Database;
let db: SqlDatabase;

beforeEach(async () => {
  sqlite = new Database(":memory:");
  sqlite.exec(
    await Bun.file(new URL("../schema/creator.sql", import.meta.url)).text(),
  );
  db = sqliteHandle(sqlite);
});

function modeRows(): Record<string, unknown>[] {
  return sqlite
    .query("SELECT op_id, lane_code, mode FROM follow_ledger ORDER BY id")
    .all() as Record<string, unknown>[];
}

describe("the modes", () => {
  // Nothing acts until someone sets a mode: a missing row must read as dry-run.
  test("a class or lane with no mode set is in dry-run", async () => {
    expect((await readModes(db)).modeOf("class", STATELESS_CLASS)).toBe(
      "dry_run",
    );
  });

  test("a set mode reads back with its record, for its subject only", async () => {
    await setMode(db, {
      kind: "lane",
      code: 1,
      mode: "act",
      opId: "a",
      atMs: AT_MS,
    });
    const modes = await readModes(db);
    expect(modes.modeOf("lane", 1)).toBe("act");
    // The same code under the other kind is a different subject.
    expect(modes.modeOf("class", 1)).toBe("dry_run");
    expect(modeRows()).toEqual([{ op_id: "a", lane_code: 1, mode: 2 }]);
  });
});

describe("a lane's mode changes", () => {
  const change = (mode: "dry_run" | "act", atMs: number, code = 1) =>
    setMode(db, {
      kind: "lane",
      code,
      mode,
      opId: `${code}-${atMs}`,
      atMs,
    });

  // A grade asks what the mode was during an interval, which only this history
  // can answer once the mode has changed again.
  test("reads oldest first, for its lane only, whatever order they landed", async () => {
    await change("act", AT_MS + 2_000);
    await change("dry_run", AT_MS + 1_000);
    await change("act", AT_MS, 2);
    await setMode(db, {
      kind: "class",
      code: 1,
      mode: "act",
      opId: "class",
      atMs: AT_MS,
    });
    expect(await readLaneModeChanges(db, 1, 10)).toEqual([
      { atMs: AT_MS + 1_000, mode: "dry_run" },
      { atMs: AT_MS + 2_000, mode: "act" },
    ]);
  });

  test("a lane whose mode was never set has no changes", async () => {
    expect(await readLaneModeChanges(db, 1, 10)).toEqual([]);
  });

  // The ledger keeps every change for the life of the environment, so a daily
  // read keeps the newest: what a mode was lately is what a grade asks.
  test("keeps the newest changes at its limit, still oldest first", async () => {
    await change("act", AT_MS);
    await change("dry_run", AT_MS + 1_000);
    await change("act", AT_MS + 2_000);
    expect(await readLaneModeChanges(db, 1, 2)).toEqual([
      { atMs: AT_MS + 1_000, mode: "dry_run" },
      { atMs: AT_MS + 2_000, mode: "act" },
    ]);
  });
});
