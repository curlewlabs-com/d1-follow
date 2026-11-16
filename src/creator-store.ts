// The creator database's statements (schema/creator.sql), several
// responsibilities held together: the registry of base slots, the name counter,
// the modes, the ledger with the intents and releases it opens, and the backoff.
//
// They run against any handle with D1's prepare/bind/all/run/batch shape. D1
// satisfies it, and the tests run the same statements against SQLite. Rows
// come back untyped, so every field is narrowed here before it reaches a
// caller.
import { parseColo, type Colo } from "./colo";
import { LANE_CHANGED_BY } from "./lane";
import { holdIdentity, releaseIdentity } from "./slot-identity";

export interface SqlStatement {
  bind(...values: unknown[]): SqlStatement;
  // D1's result carries a meta, which says where a primary-served result was
  // served (primary-colo.ts); a handle that has none leaves it out.
  all(): Promise<{ results: unknown[]; meta?: unknown }>;
  run(): Promise<unknown>;
}

export interface SqlDatabase {
  prepare(query: string): SqlStatement;
  // Runs the statements as one transaction, as D1's batch does.
  batch(statements: SqlStatement[]): Promise<unknown[]>;
}

// A row this store cannot read as the schema promises: a schema drift or a
// hand edit, never a value to guess around.
export class CreatorStoreError extends Error {
  override readonly name = "CreatorStoreError";
}

// The codes schema/creator.sql's follow_ledger.kind holds.
export const LEDGER_KIND = {
  creation_intent: 1,
  created: 2,
  name_spent: 3,
  verified: 4,
  unregistered: 5,
  release_intent: 6,
  released: 7,
  lane_changed: 8,
  seeded: 9,
  mode_changed: 10,
} as const;

export type LedgerKind = keyof typeof LEDGER_KIND;
export type LaneChangedBy = keyof typeof LANE_CHANGED_BY;

// Every statement this store runs, in one place so the tests can check each
// one's query plan: follow_ledger is the table that grows for the life of the
// environment, and none of these may scan it (README sec."Schema changes").
export const CREATOR_SQL = {
  readSlots:
    "SELECT class_code, colo, name, object_id, registered_at_ms, verified_at_ms FROM follow_slot ORDER BY class_code, colo",
  // Unordered: an ORDER BY could lead the planner to walk the ledger in rowid
  // order instead of searching its object index.
  readLedgerByObjects:
    "SELECT id, object_id, kind FROM follow_ledger WHERE object_id IN (SELECT value FROM json_each(?))",
  appendLedger:
    "INSERT INTO follow_ledger (op_id, at_ms, kind, class_code, name, object_id, colo, lane_code, lane_seq, from_name, changed_by, mode, detail) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
  takeNameNumber:
    "INSERT INTO follow_name_counter (class_code, last_number) VALUES (?, 1) ON CONFLICT (class_code) DO UPDATE SET last_number = last_number + 1 RETURNING last_number",
  insertSlot:
    "INSERT INTO follow_slot (class_code, colo, name, object_id, registered_at_ms, verified_at_ms) VALUES (?, ?, ?, ?, ?, ?)",
  // Both stamp statements match the slot only in the colo its answer came from
  // (stampVerified says why).
  recordFirstVerification:
    "INSERT INTO follow_ledger (op_id, at_ms, kind, class_code, name, object_id, colo) SELECT ?, ?, ?, class_code, name, object_id, colo FROM follow_slot WHERE name = ? AND colo = ? AND verified_at_ms IS NULL",
  // Never moves the time back (stampVerified says why); a slot not yet
  // verified takes the stamp as it is.
  stampVerified:
    "UPDATE follow_slot SET verified_at_ms = max(ifnull(verified_at_ms, 0), ?) WHERE name = ? AND colo = ? RETURNING name",
  // Each of an unregister's statements matches the slot only while its
  // verification is the one the pass decided on (unregisterSlot says why), and
  // the ledger row and the release-queue row are copied from the slot ahead of
  // the delete, while it is still there.
  recordUnregistered:
    "INSERT INTO follow_ledger (op_id, at_ms, kind, class_code, name, object_id, colo, detail) SELECT ?, ?, ?, class_code, name, object_id, colo, ? FROM follow_slot WHERE name = ? AND verified_at_ms IS ?",
  deleteSlot:
    "DELETE FROM follow_slot WHERE name = ? AND verified_at_ms IS ? RETURNING name",
  // A slot kept where it moved: its row changes colo, recorded as leaving the
  // old colo and seeded in the new, since the ledger's kinds are fixed.
  moveSlot:
    "UPDATE follow_slot SET colo = ?, verified_at_ms = ? WHERE name = ? AND verified_at_ms IS ? RETURNING name",
  recordMovedIn:
    "INSERT INTO follow_ledger (op_id, at_ms, kind, class_code, name, object_id, colo, detail) SELECT ?, ?, ?, class_code, name, object_id, colo, ? FROM follow_slot WHERE name = ? AND colo = ? AND verified_at_ms = ?",
  readModes: "SELECT subject_kind, subject_code, mode FROM follow_mode",
  readLaneModeChanges: `SELECT at_ms, mode FROM follow_ledger WHERE kind = ${LEDGER_KIND.mode_changed} AND lane_code = ? ORDER BY at_ms DESC LIMIT ?`,
  setMode:
    "INSERT INTO follow_mode (subject_kind, subject_code, mode, changed_at_ms) VALUES (?, ?, ?, ?) ON CONFLICT (subject_kind, subject_code) DO UPDATE SET mode = excluded.mode, changed_at_ms = excluded.changed_at_ms",
  // The conflict target names schema/creator.sql's partial index, whose
  // WHERE has to match it.
  copyLaneChange: `INSERT INTO follow_ledger (op_id, at_ms, kind, name, lane_code, lane_seq, from_name, changed_by) VALUES (?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT (lane_code, lane_seq) WHERE kind = ${LEDGER_KIND.lane_changed} DO NOTHING`,
  lastCopiedLaneSeq: `SELECT max(lane_seq) AS seq FROM follow_ledger WHERE kind = ${LEDGER_KIND.lane_changed} AND lane_code = ?`,
  openIntent:
    "INSERT INTO follow_open_intent (op_id, class_code, name, at_ms) VALUES (?, ?, ?, ?)",
  closeIntent: "DELETE FROM follow_open_intent WHERE op_id = ?",
  readOpenIntents:
    "SELECT op_id, class_code, name, at_ms FROM follow_open_intent WHERE at_ms < ? ORDER BY at_ms",
  holdForRelease:
    "INSERT INTO follow_release_pending (name, class_code, object_id, unregistered_at_ms) SELECT name, class_code, object_id, ? FROM follow_slot WHERE name = ? AND verified_at_ms IS ?",
  readReleasePending:
    "SELECT name, class_code, object_id, unregistered_at_ms FROM follow_release_pending ORDER BY unregistered_at_ms",
  readReleaseDue:
    "SELECT name, class_code, object_id, unregistered_at_ms FROM follow_release_pending WHERE class_code = ? AND unregistered_at_ms <= ? AND name NOT IN (SELECT value FROM json_each(?)) ORDER BY attempted_at_ms, unregistered_at_ms LIMIT ?",
  stampReleaseAttempt:
    "UPDATE follow_release_pending SET attempted_at_ms = ? WHERE name = ?",
  dropReleasePending: "DELETE FROM follow_release_pending WHERE name = ?",
  readBackoff:
    "SELECT class_code, wait_ms, next_attempt_at_ms FROM follow_backoff",
  setBackoff:
    "INSERT INTO follow_backoff (class_code, wait_ms, next_attempt_at_ms) VALUES (?, ?, ?) ON CONFLICT (class_code) DO UPDATE SET wait_ms = excluded.wait_ms, next_attempt_at_ms = excluded.next_attempt_at_ms",
  clearBackoff: "DELETE FROM follow_backoff WHERE class_code = ?",
} as const;

export type Mode = "dry_run" | "act";
export type SubjectKind = "class" | "lane";

const MODE_CODE: Readonly<Record<Mode, number>> = { dry_run: 1, act: 2 };
const SUBJECT_KIND_CODE: Readonly<Record<SubjectKind, number>> = {
  class: 1,
  lane: 2,
};

export interface Slot {
  readonly classCode: number;
  readonly colo: Colo;
  readonly name: string;
  readonly objectId: string;
  readonly registeredAtMs: number;
  // Null until the slot is first verified: a base slot by an answer from its
  // colo, a spare as creator-spares.ts decides.
  readonly verifiedAtMs: number | null;
}

// One ledger row. Which fields a kind carries is schema/creator.sql's per-kind
// CHECK, so a row missing its identity is refused rather than written.
export interface LedgerEntry {
  readonly opId: string;
  readonly atMs: number;
  readonly kind: LedgerKind;
  readonly classCode?: number;
  readonly name?: string;
  readonly objectId?: string;
  readonly colo?: Colo;
  readonly laneCode?: number;
  readonly laneSeq?: number;
  readonly fromName?: string;
  readonly changedBy?: LaneChangedBy;
  readonly mode?: Mode;
  // Reason text for a person. Nothing parses it.
  readonly detail?: string;
}

export function field(row: unknown, key: string): unknown {
  if (typeof row !== "object" || row === null) {
    throw new CreatorStoreError(`row is not an object: ${String(row)}`);
  }
  return (row as Record<string, unknown>)[key];
}

export function integerField(row: unknown, key: string): number {
  const value = field(row, key);
  if (typeof value !== "number" || !Number.isSafeInteger(value)) {
    throw new CreatorStoreError(`${key} is not an integer: ${String(value)}`);
  }
  return value;
}

export function stringField(row: unknown, key: string): string {
  const value = field(row, key);
  if (typeof value !== "string") {
    throw new CreatorStoreError(`${key} is not a string: ${String(value)}`);
  }
  return value;
}

export function slotFromRow(row: unknown): Slot {
  const colo = parseColo(field(row, "colo"));
  if (colo === null) {
    throw new CreatorStoreError(
      `colo is not a colo: ${String(field(row, "colo"))}`,
    );
  }
  const verified = field(row, "verified_at_ms");
  return {
    classCode: integerField(row, "class_code"),
    colo,
    name: stringField(row, "name"),
    objectId: stringField(row, "object_id"),
    registeredAtMs: integerField(row, "registered_at_ms"),
    verifiedAtMs:
      verified === null ? null : integerField(row, "verified_at_ms"),
  };
}

export async function readSlots(db: SqlDatabase): Promise<Slot[]> {
  const { results } = await db.prepare(CREATOR_SQL.readSlots).all();
  return results.map(slotFromRow);
}

// The kind of the latest ledger row naming each of `objectIds`, for those the
// ledger names at all: what the ledger last said happened to the object.
export async function readLedgerKinds(
  db: SqlDatabase,
  objectIds: readonly string[],
): Promise<Map<string, LedgerKind>> {
  const { results } = await db
    .prepare(CREATOR_SQL.readLedgerByObjects)
    .bind(JSON.stringify(objectIds))
    .all();
  const latest = new Map<string, { id: number; kind: LedgerKind }>();
  for (const row of results) {
    const id = integerField(row, "id");
    const objectId = stringField(row, "object_id");
    const code = integerField(row, "kind");
    const kind = (Object.keys(LEDGER_KIND) as LedgerKind[]).find(
      (k) => LEDGER_KIND[k] === code,
    );
    if (kind === undefined) {
      throw new CreatorStoreError(`kind is not a ledger kind: ${code}`);
    }
    const seen = latest.get(objectId);
    if (seen === undefined || id > seen.id) latest.set(objectId, { id, kind });
  }
  return new Map([...latest].map(([objectId, { kind }]) => [objectId, kind]));
}

// A statement that appends one ledger row, for a caller to batch with the act
// the row records.
export function ledgerStatement(
  db: SqlDatabase,
  entry: LedgerEntry,
): SqlStatement {
  return db
    .prepare(CREATOR_SQL.appendLedger)
    .bind(
      entry.opId,
      entry.atMs,
      LEDGER_KIND[entry.kind],
      entry.classCode ?? null,
      entry.name ?? null,
      entry.objectId ?? null,
      entry.colo ?? null,
      entry.laneCode ?? null,
      entry.laneSeq ?? null,
      entry.fromName ?? null,
      entry.changedBy === undefined ? null : LANE_CHANGED_BY[entry.changedBy],
      entry.mode === undefined ? null : MODE_CODE[entry.mode],
      entry.detail ?? null,
    );
}

// Starts a creation attempt, intent before act. It takes the class's next name
// number, then writes the attempt's intent under the exact name `nameOf` makes
// of it - the name format is the app's - and only then hands the name back for
// the caller to address. An attempt whose intent cannot be written does not
// run, and its number stays taken: a number is taken once whatever then happens
// to the name, so a name is never reused. `nameOf` must give names no other
// class's gives, since a name keys the registry and the open intents across
// classes.
export async function beginCreation(
  db: SqlDatabase,
  attempt: {
    readonly classCode: number;
    readonly opId: string;
    readonly atMs: number;
    readonly nameOf: (number: number) => string;
  },
): Promise<{ readonly number: number; readonly name: string }> {
  const { results } = await db
    .prepare(CREATOR_SQL.takeNameNumber)
    .bind(attempt.classCode)
    .all();
  const [row] = results;
  if (row === undefined) {
    throw new CreatorStoreError(
      `no name number returned for class ${attempt.classCode}`,
    );
  }
  const number = integerField(row, "last_number");
  const name = attempt.nameOf(number);
  // The open-intent row goes with the intent, so an attempt whose answer is
  // lost is found by a later pass without reading the ledger.
  await db.batch([
    ledgerStatement(db, {
      opId: attempt.opId,
      atMs: attempt.atMs,
      kind: "creation_intent",
      classCode: attempt.classCode,
      name,
    }),
    db
      .prepare(CREATOR_SQL.openIntent)
      .bind(attempt.opId, attempt.classCode, name, attempt.atMs),
  ]);
  return { number, name };
}

// Records a creation attempt's name as spent: the object landed where the
// creator did not keep it, holds no storage, and ceases on its own.
export async function recordSpentName(
  db: SqlDatabase,
  spent: {
    readonly opId: string;
    readonly atMs: number;
    readonly classCode: number;
    readonly name: string;
    readonly objectId: string;
    // Where the object answered from, or null when it could not say.
    readonly colo: Colo | null;
  },
): Promise<void> {
  await db.batch([
    ledgerStatement(db, {
      opId: spent.opId,
      atMs: spent.atMs,
      kind: "name_spent",
      classCode: spent.classCode,
      name: spent.name,
      objectId: spent.objectId,
      ...(spent.colo === null ? {} : { colo: spent.colo }),
    }),
    db.prepare(CREATOR_SQL.closeIntent).bind(spent.opId),
  ]);
}

// Registers a slot with the ledger row that records why, in one batch, so a
// registry row never exists without its record. `kind` is `created` for a
// slot the creator made and `seeded` for an object that was serving already.
export async function registerSlot(
  db: SqlDatabase,
  slot: Slot,
  record: { readonly opId: string; readonly kind: "created" | "seeded" },
): Promise<void> {
  await db.batch([
    holdIdentity(db, slot),
    db
      .prepare(CREATOR_SQL.insertSlot)
      .bind(
        slot.classCode,
        slot.colo,
        slot.name,
        slot.objectId,
        slot.registeredAtMs,
        slot.verifiedAtMs,
      ),
    ledgerStatement(db, {
      opId: record.opId,
      atMs: slot.registeredAtMs,
      kind: record.kind,
      classCode: slot.classCode,
      name: slot.name,
      objectId: slot.objectId,
      colo: slot.colo,
    }),
    // A created slot is its attempt's outcome and closes it. A seeded one is
    // no attempt's outcome, so it closes nothing, whatever its op id.
    ...(record.kind === "created"
      ? [db.prepare(CREATOR_SQL.closeIntent).bind(record.opId)]
      : []),
  ]);
}

// Stamps a slot's latest answer from `colo`, its own, and true when the slot
// was still registered there. Only the first stamp is a verification change,
// so only it writes a ledger row, in the same batch; later stamps refresh the
// time, and never move it back, since a pass stamps without holding its lease
// and a stale one can land after a newer answer. The colo binds the stamp to
// the row the answer was about: a pass that lost its lease can stamp after
// another pass moved the slot's row to a new colo, and an answer from the old
// colo says nothing about the new one. A slot that stops answering from its
// colo leaves the registry through unregisterSlot, which records that change.
export async function stampVerified(
  db: SqlDatabase,
  stamp: {
    readonly name: string;
    readonly colo: Colo;
    readonly opId: string;
    readonly atMs: number;
  },
): Promise<boolean> {
  const results = await db.batch([
    // Ahead of the update, which is what makes "first" observable.
    db
      .prepare(CREATOR_SQL.recordFirstVerification)
      .bind(
        stamp.opId,
        stamp.atMs,
        LEDGER_KIND.verified,
        stamp.name,
        stamp.colo,
      ),
    db
      .prepare(CREATOR_SQL.stampVerified)
      .bind(stamp.atMs, stamp.name, stamp.colo),
  ]);
  return returnedRows(results[1], "stamp's update").length > 0;
}

// Takes a slot out of the registry with the ledger row that says why, in one
// batch, and true when it did. `slot` is the slot as the caller read it, and
// the batch acts only while the slot still carries that verification: a pass
// stamps without holding its lease, so one that lost it can verify a slot
// after the lease's holder read it, and that holder's decision to unregister
// was made on the older answer. A slot verified since is left registered,
// with no record, for the next pass to judge.
export async function unregisterSlot(
  db: SqlDatabase,
  slot: Pick<Slot, "name" | "verifiedAtMs">,
  record: {
    readonly opId: string;
    readonly atMs: number;
    readonly detail: string;
  },
): Promise<boolean> {
  const results = await db.batch([
    db
      .prepare(CREATOR_SQL.recordUnregistered)
      .bind(
        record.opId,
        record.atMs,
        LEDGER_KIND.unregistered,
        record.detail,
        slot.name,
        slot.verifiedAtMs,
      ),
    // Out of the registry is not released: the release rule decides when.
    db
      .prepare(CREATOR_SQL.holdForRelease)
      .bind(record.atMs, slot.name, slot.verifiedAtMs),
    releaseIdentity(db, "base", slot),
    db.prepare(CREATOR_SQL.deleteSlot).bind(slot.name, slot.verifiedAtMs),
  ]);
  return returnedRows(results[3], "unregister's delete").length > 0;
}

// Keeps a slot that moved where it now is: its registry row takes the new colo
// and a fresh verification, with the ledger recording it out of the old colo
// and seeded in the new, in one batch. Like an unregister it goes ahead only
// while the slot carries the verification the pass read, and the registry's
// key refuses a colo where the class already has its slot, failing the batch
// whole. True when the slot moved.
export async function moveSlot(
  db: SqlDatabase,
  slot: Pick<Slot, "name" | "colo" | "verifiedAtMs">,
  to: { readonly colo: Colo; readonly atMs: number; readonly opId: string },
): Promise<boolean> {
  const results = await db.batch([
    db
      .prepare(CREATOR_SQL.recordUnregistered)
      .bind(
        to.opId,
        to.atMs,
        LEDGER_KIND.unregistered,
        `moved to ${to.colo}`,
        slot.name,
        slot.verifiedAtMs,
      ),
    db
      .prepare(CREATOR_SQL.moveSlot)
      .bind(to.colo, to.atMs, slot.name, slot.verifiedAtMs),
    db
      .prepare(CREATOR_SQL.recordMovedIn)
      .bind(
        to.opId,
        to.atMs,
        LEDGER_KIND.seeded,
        `moved from ${slot.colo}`,
        slot.name,
        to.colo,
        to.atMs,
      ),
  ]);
  return returnedRows(results[1], "move's update").length > 0;
}

// The rows a batch statement returned, from D1's result shape.
export function returnedRows(result: unknown, statement: string): unknown[] {
  const rows = (result as { results?: unknown } | undefined)?.results;
  if (!Array.isArray(rows)) {
    throw new CreatorStoreError(`${statement} returned no result rows`);
  }
  return rows;
}

export interface ModeTable {
  // A class or lane with no row is in dry-run: nothing acts until a mode is
  // set.
  modeOf(kind: SubjectKind, code: number): Mode;
}

export async function readModes(db: SqlDatabase): Promise<ModeTable> {
  const { results } = await db.prepare(CREATOR_SQL.readModes).all();
  const modes = new Map<string, Mode>();
  for (const row of results) {
    modes.set(
      `${integerField(row, "subject_kind")}:${integerField(row, "subject_code")}`,
      modeField(row),
    );
  }
  return {
    modeOf: (kind, code) =>
      modes.get(`${SUBJECT_KIND_CODE[kind]}:${code}`) ?? "dry_run",
  };
}

function modeField(row: unknown): Mode {
  const code = integerField(row, "mode");
  if (code === MODE_CODE.act) return "act";
  if (code === MODE_CODE.dry_run) return "dry_run";
  throw new CreatorStoreError(`mode is not a mode code: ${code}`);
}

export interface ModeChange {
  readonly atMs: number;
  readonly mode: Mode;
}

// A lane's newest mode changes from the ledger, at most `limit`, oldest first:
// the mode table says what a lane's mode is, and only these say what it was.
// With no row, it never left dry-run. The ledger keeps them for the life of the
// environment, so the caller says how far back it needs to reach; a caller
// asking what the mode was at an instant older than every row returned does
// not know, and must not read that as dry-run having been proved.
export async function readLaneModeChanges(
  db: SqlDatabase,
  laneCode: number,
  limit: number,
): Promise<readonly ModeChange[]> {
  const { results } = await db
    .prepare(CREATOR_SQL.readLaneModeChanges)
    .bind(laneCode, limit)
    .all();
  return results
    .map((row) => ({
      atMs: integerField(row, "at_ms"),
      mode: modeField(row),
    }))
    .reverse();
}

// Sets a class's or lane's mode with its ledger row, in one batch.
export async function setMode(
  db: SqlDatabase,
  change: {
    readonly kind: SubjectKind;
    readonly code: number;
    readonly mode: Mode;
    readonly opId: string;
    readonly atMs: number;
    // Why, for whoever reads the ledger later.
    readonly detail?: string;
  },
): Promise<void> {
  await db.batch([
    db
      .prepare(CREATOR_SQL.setMode)
      .bind(
        SUBJECT_KIND_CODE[change.kind],
        change.code,
        MODE_CODE[change.mode],
        change.atMs,
      ),
    ledgerStatement(db, {
      opId: change.opId,
      atMs: change.atMs,
      kind: "mode_changed",
      ...(change.kind === "class"
        ? { classCode: change.code }
        : { laneCode: change.code }),
      mode: change.mode,
      ...(change.detail === undefined ? {} : { detail: change.detail }),
    }),
  ]);
}

// Copies one row of the app's lane change log (schema/lane.sql) into the
// ledger. A row already copied is left as it is, so a pass that repeats a copy
// after a lost answer writes nothing new.
export async function recordLaneChange(
  db: SqlDatabase,
  change: {
    readonly opId: string;
    readonly laneCode: number;
    readonly seq: number;
    // Null for the change that seeded the lane.
    readonly fromHolder: string | null;
    readonly toHolder: string;
    readonly changedAtMs: number;
    readonly changedBy: LaneChangedBy;
  },
): Promise<void> {
  await db
    .prepare(CREATOR_SQL.copyLaneChange)
    .bind(
      change.opId,
      change.changedAtMs,
      LEDGER_KIND.lane_changed,
      change.toHolder,
      change.laneCode,
      change.seq,
      change.fromHolder,
      LANE_CHANGED_BY[change.changedBy],
    )
    .run();
}

// The highest lane change sequence number the ledger holds for a lane, or null
// before its first copy: the creator copies the change log's rows above it.
export async function lastCopiedLaneSeq(
  db: SqlDatabase,
  laneCode: number,
): Promise<number | null> {
  const { results } = await db
    .prepare(CREATOR_SQL.lastCopiedLaneSeq)
    .bind(laneCode)
    .all();
  const [row] = results;
  return row === undefined || field(row, "seq") === null
    ? null
    : integerField(row, "seq");
}

// A creation attempt whose outcome is not recorded yet.
export interface OpenIntent {
  readonly opId: string;
  readonly classCode: number;
  readonly name: string;
  readonly atMs: number;
}

// The attempts begun before `beforeMs` that have no outcome: a pass resolves
// them by observing the name, leaving its own attempts alone.
export async function readOpenIntents(
  db: SqlDatabase,
  beforeMs: number,
): Promise<OpenIntent[]> {
  const { results } = await db
    .prepare(CREATOR_SQL.readOpenIntents)
    .bind(beforeMs)
    .all();
  return results.map((row) => ({
    opId: stringField(row, "op_id"),
    classCode: integerField(row, "class_code"),
    name: stringField(row, "name"),
    atMs: integerField(row, "at_ms"),
  }));
}

// An object out of the registry and not released yet.
export interface PendingRelease {
  readonly name: string;
  readonly classCode: number;
  readonly objectId: string;
  readonly unregisteredAtMs: number;
}

export async function readReleasePending(
  db: SqlDatabase,
): Promise<PendingRelease[]> {
  const { results } = await db.prepare(CREATOR_SQL.readReleasePending).all();
  return results.map((row) => ({
    name: stringField(row, "name"),
    classCode: integerField(row, "class_code"),
    objectId: stringField(row, "object_id"),
    unregisteredAtMs: integerField(row, "unregistered_at_ms"),
  }));
}

// Up to `limit` of a class's releases that are due: out of the registry since
// `unregisteredByMs` or earlier and not named in `keep`, least recently
// attempted first.
export async function readReleaseDue(
  db: SqlDatabase,
  due: {
    readonly classCode: number;
    readonly unregisteredByMs: number;
    readonly keep: readonly string[];
    readonly limit: number;
  },
): Promise<PendingRelease[]> {
  const { results } = await db
    .prepare(CREATOR_SQL.readReleaseDue)
    .bind(
      due.classCode,
      due.unregisteredByMs,
      JSON.stringify(due.keep),
      due.limit,
    )
    .all();
  return results.map((row) => ({
    name: stringField(row, "name"),
    classCode: integerField(row, "class_code"),
    objectId: stringField(row, "object_id"),
    unregisteredAtMs: integerField(row, "unregistered_at_ms"),
  }));
}

// A release's intent, written before the object is asked to empty itself, with
// the attempt stamped on the pending row in the same batch. A release whose
// intent cannot be written does not run.
export async function beginRelease(
  db: SqlDatabase,
  release: PendingRelease & { readonly opId: string; readonly atMs: number },
): Promise<void> {
  await db.batch([
    ledgerStatement(db, {
      opId: release.opId,
      atMs: release.atMs,
      kind: "release_intent",
      classCode: release.classCode,
      name: release.name,
      objectId: release.objectId,
    }),
    db
      .prepare(CREATOR_SQL.stampReleaseAttempt)
      .bind(release.atMs, release.name),
  ]);
}

// A release's outcome, with the object leaving the pending set in one batch.
export async function recordReleased(
  db: SqlDatabase,
  release: PendingRelease & { readonly opId: string; readonly atMs: number },
): Promise<void> {
  await db.batch([
    ledgerStatement(db, {
      opId: release.opId,
      atMs: release.atMs,
      kind: "released",
      classCode: release.classCode,
      name: release.name,
      objectId: release.objectId,
    }),
    db.prepare(CREATOR_SQL.dropReleasePending).bind(release.name),
  ]);
}

// A class's creation backoff. A class with none attempts on every pass.
export interface Backoff {
  readonly waitMs: number;
  readonly nextAttemptAtMs: number;
}

export async function readBackoff(
  db: SqlDatabase,
): Promise<ReadonlyMap<number, Backoff>> {
  const { results } = await db.prepare(CREATOR_SQL.readBackoff).all();
  return new Map(
    results.map((row) => [
      integerField(row, "class_code"),
      {
        waitMs: integerField(row, "wait_ms"),
        nextAttemptAtMs: integerField(row, "next_attempt_at_ms"),
      },
    ]),
  );
}

export async function setBackoff(
  db: SqlDatabase,
  classCode: number,
  backoff: Backoff,
): Promise<void> {
  await db
    .prepare(CREATOR_SQL.setBackoff)
    .bind(classCode, backoff.waitMs, backoff.nextAttemptAtMs)
    .run();
}

export async function clearBackoff(
  db: SqlDatabase,
  classCode: number,
): Promise<void> {
  await db.prepare(CREATOR_SQL.clearBackoff).bind(classCode).run();
}
