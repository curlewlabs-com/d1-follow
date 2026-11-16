-- The lane tables an app applies to its own database, beside the data its lanes
-- work on (README sec."Where the state lives"). A lane reads its record from the
-- primary in the first query of every unit of work, so these never live in the
-- creator's database.
--
-- Integer codes, never names, for every enum-like field. A lane's code is the
-- app's to assign and is never reused.

-- One row per singleton lane: who holds it, and the run of observations that
-- puts the primary in another colo.
CREATE TABLE follow_lane (
  lane INTEGER PRIMARY KEY CHECK (lane > 0),
  holder TEXT NOT NULL CHECK (length(holder) > 0),
  -- Every change to the holder compares this and sets it one higher.
  seq INTEGER NOT NULL CHECK (seq >= 1),
  -- The other colo the current run points at, and how far it has got.
  run_colo TEXT CHECK (run_colo IS NULL OR run_colo GLOB '[A-Z][A-Z][A-Z]'),
  run_count INTEGER NOT NULL DEFAULT 0 CHECK (run_count >= 0),
  run_last_at_ms INTEGER,
  changed_at_ms INTEGER NOT NULL,
  -- 1 seeded, 2 handed off by the lane, 3 handed off by an operator.
  changed_by INTEGER NOT NULL CHECK (changed_by IN (1, 2, 3))
) STRICT;

-- One row per change of holder, appended in the batch that makes the change.
-- The creator copies each row into its ledger. Rows are kept for the life of the
-- environment, like the ledger: a change happens at most once per handoff
-- threshold, and no row may go before its copy has been made, whatever the
-- creator was doing when it was written.
-- Its identity columns carry follow_lane's own checks, so the log cannot hold a
-- change the record could not.
CREATE TABLE follow_lane_change (
  lane INTEGER NOT NULL CHECK (lane > 0),
  seq INTEGER NOT NULL CHECK (seq >= 1),
  from_holder TEXT CHECK (from_holder IS NULL OR length(from_holder) > 0),
  to_holder TEXT NOT NULL CHECK (length(to_holder) > 0),
  changed_at_ms INTEGER NOT NULL,
  changed_by INTEGER NOT NULL CHECK (changed_by IN (1, 2, 3)),
  PRIMARY KEY (lane, seq)
) STRICT;
