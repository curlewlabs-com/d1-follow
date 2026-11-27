-- The creator's own database (README sec."Where the state lives"): the registry,
-- the ledger, the modes and the creator's working state. Nothing reads these on
-- a hot path. An app binds this database for its background reads.
--
-- Integer codes, never names, for every enum-like field. Class and lane codes
-- are the app's to assign and are never reused.
--
-- The creator's deploy applies this whole file every time, so every statement
-- creates only what is missing (README sec."Schema changes").

-- The registry: at most one slot per class and colo, and when it last answered
-- from its colo. A slot is verified while that answer is less than two hours old.
-- A name identifies one object across every class the creator keeps, so each
-- class names its objects with a prefix no other class uses.
CREATE TABLE IF NOT EXISTS follow_slot (
  class_code INTEGER NOT NULL CHECK (class_code > 0),
  colo TEXT NOT NULL CHECK (colo GLOB '[A-Z][A-Z][A-Z]'),
  name TEXT NOT NULL UNIQUE CHECK (length(name) > 0),
  -- The object's id as the namespace computes it from the name, which is the
  -- id a namespace listing returns.
  object_id TEXT NOT NULL UNIQUE CHECK (length(object_id) > 0),
  registered_at_ms INTEGER NOT NULL,
  -- Null until the slot first answers from its colo.
  verified_at_ms INTEGER,
  PRIMARY KEY (class_code, colo)
) STRICT;

-- The spares: slots of a class kept beside its base slot in the colo the app's
-- primary is in (README sec."Spare slots in a table of their own"). Keyed by
-- name, since follow_slot's key holds a single slot per class and colo.
CREATE TABLE IF NOT EXISTS follow_spare (
  name TEXT PRIMARY KEY CHECK (length(name) > 0),
  class_code INTEGER NOT NULL CHECK (class_code > 0),
  colo TEXT NOT NULL CHECK (colo GLOB '[A-Z][A-Z][A-Z]'),
  -- As follow_slot's: the id the namespace listing returns.
  object_id TEXT NOT NULL UNIQUE CHECK (length(object_id) > 0),
  registered_at_ms INTEGER NOT NULL,
  -- Null until the spare is first verified, which src/creator-spares.ts
  -- decides: an answer from its colo holding that colo's marker.
  verified_at_ms INTEGER
) STRICT;

CREATE INDEX IF NOT EXISTS follow_spare_by_class_colo
  ON follow_spare (class_code, colo, registered_at_ms, name);

-- Every registered slot's identity, base slot or spare: a name and an object
-- id are each held once across follow_slot and follow_spare together, which
-- the census relies on when it reconciles objects by id. Each registration
-- writes its row in the batch that registers it, so a name or id already held
-- fails the batch whole; each unregistration removes it in the same way; a
-- promotion moves a slot between the tables and leaves its identity alone.
CREATE TABLE IF NOT EXISTS follow_slot_name (
  name TEXT PRIMARY KEY CHECK (length(name) > 0),
  object_id TEXT NOT NULL UNIQUE CHECK (length(object_id) > 0)
) STRICT;

-- A base slot a creator build without this table registered holds no identity
-- row. The deploy applies this file every time, so the next deploy fills it.
INSERT OR IGNORE INTO follow_slot_name (name, object_id)
  SELECT name, object_id FROM follow_slot;

-- Each class's highest name number, spent names included, so a name is never
-- reused.
CREATE TABLE IF NOT EXISTS follow_name_counter (
  class_code INTEGER PRIMARY KEY CHECK (class_code > 0),
  last_number INTEGER NOT NULL CHECK (last_number >= 0)
) STRICT;

-- One row per class or lane that has left dry-run. A missing row reads as
-- dry-run, so nothing acts until a mode is set.
CREATE TABLE IF NOT EXISTS follow_mode (
  -- 1 a class, 2 a lane.
  subject_kind INTEGER NOT NULL CHECK (subject_kind IN (1, 2)),
  subject_code INTEGER NOT NULL CHECK (subject_code > 0),
  -- 1 dry-run, 2 act.
  mode INTEGER NOT NULL CHECK (mode IN (1, 2)),
  changed_at_ms INTEGER NOT NULL,
  PRIMARY KEY (subject_kind, subject_code)
) STRICT;

-- The ledger: every creation, spent name, verification change, lane change,
-- release, seed and mode change. An act that can fail midway writes its intent
-- first under an op id, and its outcome later under the same op id. Each kind's
-- identity is in typed columns, which the CHECK below requires per kind. detail
-- is reason text for a person, never something to parse. Each identity column,
-- where set, carries the check of the table it comes from.
CREATE TABLE IF NOT EXISTS follow_ledger (
  id INTEGER PRIMARY KEY,
  op_id TEXT NOT NULL CHECK (length(op_id) > 0),
  at_ms INTEGER NOT NULL,
  -- The ledger kinds, numbered in src/creator-store.ts LEDGER_KIND.
  kind INTEGER NOT NULL CHECK (kind BETWEEN 1 AND 10),
  class_code INTEGER CHECK (class_code IS NULL OR class_code > 0),
  -- The object's name. For a lane change, the holder it changed to.
  name TEXT CHECK (name IS NULL OR length(name) > 0),
  object_id TEXT CHECK (object_id IS NULL OR length(object_id) > 0),
  colo TEXT CHECK (colo IS NULL OR colo GLOB '[A-Z][A-Z][A-Z]'),
  -- A lane change copied from the app's change log, under the lane's code and
  -- the sequence number the change set, from the holder it replaced (null for a
  -- seed), by whom (lane.sql's changed_by codes).
  lane_code INTEGER CHECK (lane_code IS NULL OR lane_code > 0),
  lane_seq INTEGER CHECK (lane_seq IS NULL OR lane_seq >= 1),
  from_name TEXT CHECK (from_name IS NULL OR length(from_name) > 0),
  changed_by INTEGER CHECK (changed_by IS NULL OR changed_by IN (1, 2, 3)),
  -- A mode change's new mode, under class_code or lane_code: 1 dry-run, 2 act.
  mode INTEGER CHECK (mode IS NULL OR mode IN (1, 2)),
  detail TEXT,
  CHECK (
    CASE kind
      WHEN 8 THEN lane_code IS NOT NULL AND lane_seq IS NOT NULL
        AND name IS NOT NULL AND changed_by IS NOT NULL
      WHEN 10 THEN mode IS NOT NULL
        AND (class_code IS NULL) <> (lane_code IS NULL)
      ELSE class_code IS NOT NULL AND name IS NOT NULL
    END
  )
) STRICT;

CREATE INDEX IF NOT EXISTS follow_ledger_by_op ON follow_ledger (op_id);

-- The census asks the ledger about the objects that hold data, by object id, so
-- it never walks the ledger.
CREATE INDEX IF NOT EXISTS follow_ledger_by_object ON follow_ledger (object_id);

-- A lane change is copied once: the creator's pass copies whatever it has not
-- yet, and a copy repeated after a lost answer finds its row here.
CREATE UNIQUE INDEX IF NOT EXISTS follow_ledger_lane_change ON follow_ledger (lane_code, lane_seq)
WHERE kind = 8;

-- A daily grade asks when a lane's mode changed, so it never walks the ledger
-- for what few rows that is.
CREATE INDEX IF NOT EXISTS follow_ledger_lane_mode ON follow_ledger (lane_code, at_ms)
WHERE kind = 10;

-- A creation whose outcome is not recorded yet: written in the batch that
-- writes its intent and removed in the batch that records its outcome, so a
-- pass finds what to resolve without reading the ledger.
CREATE TABLE IF NOT EXISTS follow_open_intent (
  op_id TEXT PRIMARY KEY CHECK (length(op_id) > 0),
  class_code INTEGER NOT NULL CHECK (class_code > 0),
  name TEXT NOT NULL UNIQUE CHECK (length(name) > 0),
  at_ms INTEGER NOT NULL
) STRICT;

-- An object that left the registry and is not released yet. It stays until the
-- release rule allows its release (README sec."The creator: making and keeping
-- slots"), and goes in the batch that records the release. `attempted_at_ms` is
-- when its last release intent was written, NULL before the first: releases are
-- tried least recently attempted first, so a release that keeps failing cannot
-- hold back the rest of its class's budget.
CREATE TABLE IF NOT EXISTS follow_release_pending (
  name TEXT PRIMARY KEY CHECK (length(name) > 0),
  class_code INTEGER NOT NULL CHECK (class_code > 0),
  object_id TEXT NOT NULL CHECK (length(object_id) > 0),
  unregistered_at_ms INTEGER NOT NULL,
  attempted_at_ms INTEGER
) STRICT;

-- A pass reads a class's releases in this order and stops at its budget, so
-- however many wait, the read walks this index no further than the budget plus
-- the rows it skips. NULL sorts first, so a release never attempted goes ahead.
CREATE INDEX IF NOT EXISTS follow_release_pending_due
  ON follow_release_pending (class_code, attempted_at_ms, unregistered_at_ms);

-- The colos the creator keeps a slot of each class in (README sec."The creator:
-- making and keeping slots"): each colo a creation attempt has landed in, and
-- each colo a slot was registered in, from the pass that first saw it. Passes
-- never remove a colo.
CREATE TABLE IF NOT EXISTS follow_colo (
  colo TEXT PRIMARY KEY CHECK (colo GLOB '[A-Z][A-Z][A-Z]'),
  added_at_ms INTEGER NOT NULL
) STRICT;

-- The region hints the creator probes through beyond the app's own: each one
-- added by the pass that first saw the app database's primary in its region,
-- and kept, since the primary may return there.
CREATE TABLE IF NOT EXISTS follow_region_hint (
  region_hint TEXT PRIMARY KEY CHECK (
    length(region_hint) > 0 AND region_hint NOT GLOB '*[^a-z]*'
  ),
  added_at_ms INTEGER NOT NULL
) STRICT;

-- Each class's wait before attempting a gap in the primary's colo again, as
-- builds before follow_gap paced those attempts. No pass reads or writes it now.
-- It stays because a schema change here is additive only, and an older build
-- deployed again reads it as before.
CREATE TABLE IF NOT EXISTS follow_backoff (
  class_code INTEGER PRIMARY KEY CHECK (class_code > 0),
  wait_ms INTEGER NOT NULL CHECK (wait_ms > 0),
  next_attempt_at_ms INTEGER NOT NULL
) STRICT;

-- The gaps a pass has made a creation for (README sec."The creator: making and
-- keeping slots"), which pace the attempts at the gap in the primary's colo. A
-- class has a gap in each candidate colo where it has no slot, and in the
-- primary's colo while it has no slot there or fewer spares than it keeps. A
-- gap no pass has created for has no row. A pass deletes the row once it sees
-- the gap filled, gone, or of another kind, so a gap that returns, or a lost
-- slot where only spares were short, is a new one.
CREATE TABLE IF NOT EXISTS follow_gap (
  class_code INTEGER NOT NULL CHECK (class_code > 0),
  colo TEXT NOT NULL CHECK (colo GLOB '[A-Z][A-Z][A-Z]'),
  -- 1 the class has no slot in the colo, 2 it has its slot there and fewer
  -- spares than it keeps, which is a gap only in the primary's colo.
  kind INTEGER NOT NULL CHECK (kind IN (1, 2)),
  -- When the pass that made the gap's first creation began. Each time is held
  -- to the integers a pass reads exactly, so no row can stop the pass that
  -- reads it (src/creator-gaps.ts drops a record it cannot trust).
  begun_at_ms INTEGER NOT NULL CHECK (begun_at_ms BETWEEN 0 AND 9007199254740991),
  -- When the pass that last attempted the gap through the hint for the
  -- primary's region began; null while none has since the row began.
  attempted_at_ms INTEGER CHECK (
    attempted_at_ms IS NULL OR attempted_at_ms BETWEEN 0 AND 9007199254740991
  ),
  PRIMARY KEY (class_code, colo)
) STRICT;

-- The creator's pass lease: one pass at a time, so overlapping invocations never
-- fill the same gap twice. A pass claims it with a conditional write, holds it
-- until the claim expires or the pass gives it up, and skips when another holds
-- it.
CREATE TABLE IF NOT EXISTS follow_pass (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  holder TEXT NOT NULL CHECK (length(holder) > 0),
  claimed_until_ms INTEGER NOT NULL
) STRICT;
