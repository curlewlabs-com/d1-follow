// The creator's reads of the app database's lane tables (schema/lane.sql).
import {
  CreatorStoreError,
  field,
  integerField,
  stringField,
  type LaneChangedBy,
  type SqlDatabase,
} from "./creator-store";
import { LANE_CHANGED_BY } from "./lane";

// Planned against schema/lane.sql rather than creator.sql. Each reads by the
// change log's key or the record's.
export const CREATOR_APP_SQL = {
  laneChangesAfter:
    "SELECT lane, seq, from_holder, to_holder, changed_at_ms, changed_by FROM follow_lane_change WHERE lane = ? AND seq > ? ORDER BY seq LIMIT ?",
  laneHolders: "SELECT holder FROM follow_lane",
} as const;

// One row of the app's lane change log (schema/lane.sql).
export interface LaneChangeRow {
  readonly laneCode: number;
  readonly seq: number;
  readonly fromHolder: string | null;
  readonly toHolder: string;
  readonly changedAtMs: number;
  readonly changedBy: LaneChangedBy;
}

const CHANGED_BY_OF_CODE: ReadonlyMap<number, LaneChangedBy> = new Map(
  Object.entries(LANE_CHANGED_BY).map(([by, code]) => [
    code,
    by as LaneChangedBy,
  ]),
);

// A lane's change-log rows after `afterSeq`, in order, at most `limit` of them:
// what the ledger has not copied yet.
export async function readLaneChangesAfter(
  appDb: SqlDatabase,
  laneCode: number,
  afterSeq: number,
  limit: number,
): Promise<LaneChangeRow[]> {
  const { results } = await appDb
    .prepare(CREATOR_APP_SQL.laneChangesAfter)
    .bind(laneCode, afterSeq, limit)
    .all();
  return results.map((row) => {
    const code = integerField(row, "changed_by");
    const changedBy = CHANGED_BY_OF_CODE.get(code);
    if (changedBy === undefined) {
      throw new CreatorStoreError(`changed_by is not a change code: ${code}`);
    }
    const from = field(row, "from_holder");
    return {
      laneCode: integerField(row, "lane"),
      seq: integerField(row, "seq"),
      fromHolder: from === null ? null : stringField(row, "from_holder"),
      toHolder: stringField(row, "to_holder"),
      changedAtMs: integerField(row, "changed_at_ms"),
      changedBy,
    };
  });
}

// Every lane's current holder, which the release rule never releases.
export async function readLaneHolders(appDb: SqlDatabase): Promise<string[]> {
  const { results } = await appDb.prepare(CREATOR_APP_SQL.laneHolders).all();
  return results.map((row) => stringField(row, "holder"));
}
