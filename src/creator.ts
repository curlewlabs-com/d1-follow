// The creator's pass (README sec."The creator: making and keeping slots"): one
// run of the loop that keeps a verified object of each class in each candidate
// colo. It reads where the app's primary is, observes the registered slots,
// resolves attempts whose answers were lost, probes through each region hint,
// fills a gap beside the primary, releases what the release rule allows,
// copies the app's lane changes into the ledger, and reports the gaps.
//
// The app supplies each class's calls and names and the databases; this owns
// the decisions and their records. Observing and recording run in either mode.
// Creating and releasing objects run only in act mode, and dry-run logs what
// they would do.
import { readLaneChangesAfter, readLaneHolders } from "./app-lane-reads";
import type { Colo } from "./colo";
import { PassCandidates, syncRegionHints } from "./creator-candidates";
import { observeSlots } from "./creator-slots";
import { observeSpares, settleSpares } from "./creator-spares";
import {
  beginCreation,
  beginRelease,
  clearBackoff,
  lastCopiedLaneSeq,
  readBackoff,
  readModes,
  readOpenIntents,
  readReleaseDue,
  readSlots,
  recordLaneChange,
  recordReleased,
  recordSpentName,
  registerSlot,
  setBackoff,
  stampVerified,
  type Backoff,
  type Slot,
  type SqlDatabase,
} from "./creator-store";
import { claimPass, releasePass, renewPass } from "./pass-lease";
import { registerSpare, stampSpareVerified } from "./spare-store";
import { readPrimary, type PrimaryPlacement } from "./primary-colo";

// What the creator needs from one of the app's object classes.
export interface CreatorClass {
  // The class's code in the registry and the ledger, assigned by the app.
  readonly code: number;
  // How the class appears in log lines.
  readonly label: string;
  // How long an object stays out of the registry before it may be released:
  // a day for a stateless class, whose callers may still hold its name in a
  // cache, and none for a lane's class, whose callers follow the lane record.
  readonly releaseAfterMs: number;
  // The class's next number as the name of an object born through
  // `regionHint`, with a prefix no other class uses.
  readonly nameOf: (number: number, regionHint: string) => string;
  // The object id the namespace computes from a name.
  readonly objectIdOf: (name: string) => string;
  // How many spares the class keeps beside its base slot in the primary's
  // colo (README sec."Spare slots in a table of their own").
  readonly spares: number;
  // The app's observe call on a name, which never changes the object. With a
  // hint, a name that does not exist yet is born through it. Resolves what the
  // object answered; rejects when the call itself failed.
  readonly observe: (
    name: string,
    hint: string | null,
  ) => Promise<ObserveResult>;
  // Has the object write its placement marker for `colo`, so it does not
  // cease once idle. Rejects when the object refused or the call failed.
  //
  // This call, markInPlace and release each carry `deadlineMs`, and the
  // object must refuse the call once its own clock reads past it. The pass
  // checks its lease after every call, but cannot undo a call that takes
  // effect after the lease lapsed and another pass took over; the deadline
  // ends inside the lease, so a late call is refused instead of undoing the
  // newer pass's work.
  readonly place: (
    name: string,
    colo: Colo,
    deadlineMs: number,
  ) => Promise<void>;
  // Has the object write its placement marker for the colo it answers from
  // now, and resolves what it then answers; it never empties the object. The
  // mark took only when the answer's marker names the colo it answered from.
  // Rejects when the call failed, as it does against an older build.
  readonly markInPlace: (
    name: string,
    deadlineMs: number,
  ) => Promise<ObserveResult>;
  // Has the object clear the storage the placement protocol owns, and only
  // that: storage the app keeps on the object for itself stays. Rejects when
  // it refused or failed. For a class a lane can hand off to, the pass's
  // holder check cannot see a handoff still committing, so the class's
  // release delay must outlast any handoff the app can still commit, or the
  // app must exclude handoffs through this call (README sec."Release").
  readonly release: (name: string, deadlineMs: number) => Promise<void>;
}

// An object's answer to an observe call.
export interface ObserveResult {
  // The colo it answered from, or null when it could not say.
  readonly colo: Colo | null;
  // The colo its placement marker was written for, or null when it holds none,
  // as a new or emptied object does.
  readonly markedColo: Colo | null;
}

export interface CreatorConfig {
  readonly classes: readonly CreatorClass[];
  // The region hint the pass probes through. A hint for each region the app's
  // primary is later seen in joins it, and stays.
  readonly regionHint: string;
  // Each class's attempts per pass beyond its probes, shared between resolving
  // attempts whose answers were lost and filling a gap in the primary's colo;
  // releases take the same bound. The cost bound is sized from it.
  readonly attemptsPerClassPerPass: number;
  // The time between passes, the creator's cron period.
  readonly passIntervalMs: number;
  // The longest a class waits between passes that attempt the primary's gap.
  readonly maxBackoffMs: number;
  // A slot or a spare stays registered while its last verification is younger
  // than this; one that cannot answer for longer leaves its table.
  readonly verifiedMaxAgeMs: number;
  // Names the creator's own passes never release, whatever the registry says,
  // such as each deployment's default holder. It scopes the creator's
  // automatic actions only; whether an operator may retire one is the app's
  // call at its own receivers.
  readonly protectedNames: ReadonlySet<string>;
  // The app's lanes, whose change logs are copied into the ledger and whose
  // holders are never released.
  readonly laneCodes: readonly number[];
}

export interface CreatorPassDeps {
  // The creator's own database (schema/creator.sql).
  readonly db: SqlDatabase;
  // The app's database, read only for where its primary is and for its lane
  // tables (schema/lane.sql).
  readonly appDb: SqlDatabase;
  readonly config: CreatorConfig;
  readonly now: () => number;
  // A fresh id for each act, grouping its intent with its outcome.
  readonly newOpId: () => string;
  readonly log: (line: string) => void;
}

// An object a pass acted on, with the colo it answered from or was registered
// in, where the act learned one: a release targets the object wherever it is,
// so a released entry has none.
export interface ReportedObject {
  readonly classCode: number;
  readonly name: string;
  readonly colo: Colo | null;
}

export interface CreatorPassReport {
  // Where the app's primary was as the pass began, or null when the pass could
  // not read it.
  readonly primary: PrimaryPlacement | null;
  // The region hints the pass probed through, or would have in dry-run.
  readonly regionHints: readonly string[];
  // Hints this pass added because the primary was seen in their region.
  readonly regionHintsAdded: readonly string[];
  // The colos the pass judged its gaps over: every candidate colo, and the
  // primary's colo while it is no candidate.
  readonly candidateColos: readonly Colo[];
  // Colos that became candidates this pass because a creation landed there.
  readonly learnedColos: readonly Colo[];
  readonly verified: readonly string[];
  readonly unregistered: readonly ReportedObject[];
  // Slots kept where they moved to, each with its new colo.
  readonly moved: readonly ReportedObject[];
  readonly sparesVerified: readonly string[];
  // Spares marked again in their colo, after answering there without its
  // marker.
  readonly sparesRemarked: readonly string[];
  readonly sparesUnregistered: readonly ReportedObject[];
  readonly sparesCreated: readonly ReportedObject[];
  readonly sparesPromoted: readonly ReportedObject[];
  // Each class with fewer verified spares in the primary's colo than it keeps,
  // after the pass.
  readonly spareGaps: readonly {
    readonly classCode: number;
    readonly colo: Colo;
  }[];
  // Each class's candidate colos with no verified slot, after the pass.
  readonly gaps: readonly { readonly classCode: number; readonly colo: Colo }[];
  readonly created: readonly ReportedObject[];
  readonly spent: readonly ReportedObject[];
  readonly released: readonly ReportedObject[];
  readonly laneChangesCopied: number;
  // What dry-run would have done.
  readonly wouldCreate: readonly number[];
  readonly wouldRelease: readonly string[];
  // Calls that failed; each leaves its record to a later pass.
  readonly failures: readonly string[];
  // True when another pass held the lease, so this one did nothing.
  readonly skipped: boolean;
  // True when another pass took the lease while this one ran, so this one
  // stopped before its next step; what it did before then is reported.
  readonly leaseLost: boolean;
}

// What a kept object becomes: its colo's base slot, or a spare beside the
// primary's.
type Role = "base" | "spare";

// Raised when the pass finds another pass holding its lease.
class LeaseLost extends Error {}

// The most change-log rows copied per lane per pass. A handoff happens at most
// once per threshold, so a pass that finds more is catching up after an outage
// and finishes over the following passes.
const LANE_CHANGES_PER_PASS = 100;

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

// Runs one pass under the creator's pass lease. Overlapping invocations, a slow
// pass or a cron that fires twice, would otherwise read the same gap and fill
// it twice. The lease runs half a period from each renewal, so a pass that dies
// leaves the next one free, and a pass that finishes gives it up at once. A
// running pass renews it before every step that acts, and only while it still
// holds it, and checks it again after every call to an object that acts: a pass
// that finds it taken stops before recording anything more. Observing a
// registered slot acts on nothing, so the lease is not renewed around it: the
// stamp an answer leads to never moves a slot's verification back, and taking a
// slot out of the registry renews the lease first and goes ahead only while the
// slot carries the verification the pass read. A call slower than the lease would
// otherwise still land while the next pass runs, so each call that acts
// carries a deadline inside the lease, which the object refuses once past
// (CreatorClass.place); what a refused or unanswered call began stays open in
// the ledger, for the pass holding the lease to resolve.
export async function runCreatorPass(
  deps: CreatorPassDeps,
): Promise<CreatorPassReport> {
  const holder = deps.newOpId();
  const leaseMs = deps.config.passIntervalMs / 2;
  const report = emptyReport();
  const claimedAtMs = deps.now();
  const claimed = await claimPass(deps.db, {
    holder,
    nowMs: claimedAtMs,
    leaseMs,
  });
  if (!claimed) {
    deps.log("[follow] creator pass skipped - another pass holds the lease");
    return { ...report, skipped: true };
  }
  // When the lease this pass holds lapses: set by the claim, moved by each
  // renewal.
  let leaseUntilMs = claimedAtMs + leaseMs;
  const hold = async (): Promise<void> => {
    const untilMs = deps.now() + leaseMs;
    const held = await renewPass(deps.db, { holder, untilMs });
    if (!held) {
      throw new LeaseLost();
    }
    leaseUntilMs = untilMs;
  };
  // A tenth of the lease before it lapses, which leaves room for the creator's
  // clock and an object's to disagree.
  const deadline = (): number => leaseUntilMs - leaseMs / 10;
  // A call that acts and fails here may still be in flight, and may land at
  // the object any time before its deadline. Giving the lease up early would
  // let the next pass resolve the same name first, and the late call would
  // then undo that pass's work. So a pass with such a call keeps the lease
  // until it lapses on its own, which is after every deadline it issued.
  // For the same reason, no path empties a name in the pass whose call to it
  // failed: the late call could land after the release and leave a marker
  // nothing records. A later pass, once the deadline has passed, empties it.
  const unsettled = new Set<string>();
  const settled = async <T>(
    name: string,
    call: () => Promise<T>,
  ): Promise<T> => {
    try {
      return await call();
    } catch (error) {
      unsettled.add(name);
      throw error;
    }
  };
  // Each member delegates to the app's own object, so a class instance keeps
  // its prototype methods, getters and receiver.
  const fenced = deps.config.classes.map((cls): CreatorClass => ({
    get code() {
      return cls.code;
    },
    get label() {
      return cls.label;
    },
    get releaseAfterMs() {
      return cls.releaseAfterMs;
    },
    get spares() {
      return cls.spares;
    },
    nameOf: (number, regionHint) => cls.nameOf(number, regionHint),
    objectIdOf: (name) => cls.objectIdOf(name),
    observe: (name, hint) => cls.observe(name, hint),
    place: (name, colo, deadlineMs) =>
      settled(name, () => cls.place(name, colo, deadlineMs)),
    markInPlace: (name, deadlineMs) =>
      settled(name, () => cls.markInPlace(name, deadlineMs)),
    release: (name, deadlineMs) =>
      settled(name, () => cls.release(name, deadlineMs)),
  }));
  try {
    await runLeasedPass(
      { ...deps, config: { ...deps.config, classes: fenced } },
      report,
      hold,
      { deadline, settling: (name) => unsettled.has(name) },
    );
  } catch (error) {
    if (!(error instanceof LeaseLost)) throw error;
    report.leaseLost = true;
    deps.log("[follow] creator pass stopped - another pass took its lease");
  } finally {
    if (unsettled.size > 0) {
      deps.log(
        "[follow] creator pass keeps its lease until it lapses - a call that failed may still land",
      );
    } else {
      await releaseLease(deps, holder);
    }
  }
  return report;
}

function emptyReport() {
  return {
    primary: null as PrimaryPlacement | null,
    regionHints: [] as string[],
    regionHintsAdded: [] as string[],
    candidateColos: [] as Colo[],
    learnedColos: [] as Colo[],
    verified: [] as string[],
    unregistered: [] as ReportedObject[],
    moved: [] as ReportedObject[],
    sparesVerified: [] as string[],
    sparesRemarked: [] as string[],
    sparesUnregistered: [] as ReportedObject[],
    sparesCreated: [] as ReportedObject[],
    sparesPromoted: [] as ReportedObject[],
    spareGaps: [] as { classCode: number; colo: Colo }[],
    gaps: [] as { classCode: number; colo: Colo }[],
    created: [] as ReportedObject[],
    spent: [] as ReportedObject[],
    released: [] as ReportedObject[],
    laneChangesCopied: 0,
    wouldCreate: [] as number[],
    wouldRelease: [] as string[],
    failures: [] as string[],
    skipped: false,
    leaseLost: false,
  };
}

// The lease expires on its own, so a failure to give it up only delays the
// next pass; it is logged, never allowed to replace the pass's own outcome.
async function releaseLease(
  deps: CreatorPassDeps,
  holder: string,
): Promise<void> {
  try {
    await releasePass(deps.db, { holder, nowMs: deps.now() });
  } catch (error) {
    deps.log(`[follow] failed - give up the pass lease: ${message(error)}`);
  }
}

// `hold` renews the lease, and throws LeaseLost when another pass has taken
// it. `fence.deadline` is the deadline each call that acts on an object
// carries (CreatorClass.place); `fence.settling` names an object whose call
// this pass failed and may still land, which nothing may empty this pass.
async function runLeasedPass(
  deps: CreatorPassDeps,
  report: ReturnType<typeof emptyReport>,
  hold: () => Promise<void>,
  fence: {
    readonly deadline: () => number;
    readonly settling: (name: string) => boolean;
  },
): Promise<void> {
  const { deadline } = fence;
  const { db, config, log } = deps;
  const passStartMs = deps.now();
  const modes = await readModes(db);
  // A failed call leaves its record for a later pass; it is logged as it
  // happens, so a failure is never only a line in a report nobody reads.
  const fail = (line: string): void => {
    report.failures.push(line);
    log(`[follow] failed - ${line}`);
  };
  const primary = await readPrimary(deps.appDb, fail);
  report.primary = primary;
  const regionHints = await syncRegionHints({
    db,
    appHint: config.regionHint,
    primary,
    atMs: deps.now(),
    log,
    report,
  });
  const classOf = new Map(config.classes.map((c) => [c.code, c]));
  // The names no release may empty: the app's protected names and each lane's
  // holder. Read once a pass, when the first release needs it, and shared by
  // every path that empties an object, so a cleanup obeys the same list as the
  // release step. A read that fails refuses the cleanups that asked and fails
  // the release step as it always has.
  let keepRead: Promise<ReadonlySet<string>> | null = null;
  const keepNames = (): Promise<ReadonlySet<string>> =>
    (keepRead ??= readLaneHolders(deps.appDb).then(
      (holders) => new Set([...config.protectedNames, ...holders]),
    ));
  // Whether a cleanup may empty `name`, logging why not when it may not.
  const mayEmpty = async (name: string): Promise<boolean> => {
    let keep: ReadonlySet<string>;
    try {
      keep = await keepNames();
    } catch (error) {
      fail(`read the names to keep before emptying ${name}: ${message(error)}`);
      return false;
    }
    if (keep.has(name)) {
      log(`[follow] ${name} is protected or holds a lane - not emptied`);
      return false;
    }
    if (fence.settling(name)) {
      log(
        `[follow] ${name} has a call this pass that failed and may still land - not emptied this pass`,
      );
      return false;
    }
    return true;
  };
  // A class that gained or lost a slot this pass starts its backoff over.
  const changed = new Set<number>();

  // Every call to an object that acts goes through here: a creation, a
  // placement, a release, and the observe that resolves an attempt, whose
  // answer the pass acts on. A call can outlast the lease, and another pass
  // may hold it by the time the call answers or fails, so the lease is
  // checked again either way before anything about the call is logged or
  // written; a lost lease outranks the call's own failure.
  const call = async <T>(act: () => Promise<T>): Promise<T> => {
    try {
      return await act();
    } finally {
      await hold();
    }
  };

  // The registry, read once. The pass applies its own stamps, registrations
  // and unregistrations to this copy rather than reading it again, so a slot
  // registered from outside the creator while the pass runs is the next
  // pass's to see.
  const registry = new Map<string, Slot>();
  for (const slot of await readSlots(db)) {
    registry.set(slot.name, slot);
  }

  const candidates = await PassCandidates.load(
    db,
    [...registry.values()].map((s) => s.colo),
    passStartMs,
    log,
  );
  const learn = async (colo: Colo | null): Promise<void> => {
    if (colo !== null && (await candidates.add(colo, deps.now()))) {
      report.learnedColos.push(colo);
      log(`[follow] candidate colo ${colo} learned - a creation landed there`);
    }
  };

  const slots = await observeSlots({
    db,
    classOf,
    registry,
    verifiedMaxAgeMs: config.verifiedMaxAgeMs,
    isCandidate: (colo) => candidates.has(colo),
    acts: (classCode) => modes.modeOf("class", classCode) === "act",
    now: deps.now,
    newOpId: deps.newOpId,
    hold,
    deadline,
    fail,
    log,
  });
  report.verified.push(...slots.verified);
  report.unregistered.push(...slots.unregistered);
  report.moved.push(...slots.moved);
  for (const code of slots.changed) changed.add(code);

  const spares = await observeSpares({
    db,
    classOf,
    verifiedMaxAgeMs: config.verifiedMaxAgeMs,
    acts: (classCode) => modes.modeOf("class", classCode) === "act",
    now: deps.now,
    newOpId: deps.newOpId,
    hold,
    deadline,
    fail,
    log,
  });
  report.sparesVerified.push(...spares.verified);
  report.sparesRemarked.push(...spares.remarked);
  report.sparesUnregistered.push(...spares.unregistered);
  const placedSpares = await settleSpares({
    db,
    classOf,
    kept: spares.kept,
    registry,
    primaryColo: primary?.colo ?? null,
    now: deps.now,
    newOpId: deps.newOpId,
    hold,
    log,
  });
  report.sparesPromoted.push(...placedSpares.promoted);
  report.sparesUnregistered.push(...placedSpares.unregistered);
  const { occupied, ready } = placedSpares;
  for (const p of placedSpares.promoted) changed.add(p.classCode);

  // Each class's registered colos, which creation fills around.
  const held = new Map<number, Set<Colo>>();
  for (const slot of registry.values()) {
    const colos = held.get(slot.classCode) ?? new Set<Colo>();
    colos.add(slot.colo);
    held.set(slot.classCode, colos);
  }
  const holds = (classCode: number, colo: Colo): boolean =>
    held.get(classCode)?.has(colo) ?? false;
  // Occupied spares bound creation, so an unverified one is never created
  // past; verified ones say whether the class has the spares it keeps.
  const sparesShort = (cls: CreatorClass): boolean =>
    (occupied.get(cls.code) ?? 0) < cls.spares;
  const sparesUnready = (cls: CreatorClass): boolean =>
    (ready.get(cls.code) ?? 0) < cls.spares;
  // What an object that landed in `colo` becomes: the class's base slot where
  // it has none, a spare in the primary's colo while the class is short of
  // them there, and otherwise nothing, so its name is spent.
  const roleOf = (cls: CreatorClass, colo: Colo | null): Role | null => {
    if (colo === null) return null;
    if (!holds(cls.code, colo)) return "base";
    return primary?.colo === colo && sparesShort(cls) ? "spare" : null;
  };
  const keep = async (
    cls: CreatorClass,
    name: string,
    colo: Colo,
    opId: string,
    role: Role,
  ): Promise<void> => {
    await learn(colo);
    // A lease lost during the call leaves the placed object alone: emptying it
    // could undo the pass now holding the lease, which may already have kept
    // it. The attempt stays open, and resolving it keeps or empties the object.
    await call(() => cls.place(name, colo, deadline()));
    const atMs = deps.now();
    const slot: Slot = {
      classCode: cls.code,
      colo,
      name,
      objectId: cls.objectIdOf(name),
      registeredAtMs: atMs,
      verifiedAtMs: null,
    };
    try {
      await (role === "base" ? registerSlot : registerSpare)(db, slot, {
        opId,
        kind: "created",
      });
    } catch (error) {
      // Placed but not registered: a marked object outside the registry would
      // never cease and never be released, so it is emptied, unless the keep
      // list names it. Its intent stays open for a later pass either way.
      if (await mayEmpty(name)) {
        await call(() =>
          cls.release(name, deadline()).catch((releaseError: unknown) => {
            log(
              `[follow] failed - empty unregistered ${name}: ${message(releaseError)}`,
            );
          }),
        );
      }
      throw error;
    }
    changed.add(cls.code);
    if (role === "spare") {
      // Counted once registered, before its stamp: a stamp that fails must not
      // leave the class short in this pass's count, or the next creation would
      // register a spare beyond the count.
      occupied.set(cls.code, (occupied.get(cls.code) ?? 0) + 1);
      if (await stampSpareVerified(db, { name, colo, opId, atMs })) {
        ready.set(cls.code, (ready.get(cls.code) ?? 0) + 1);
      }
      report.sparesCreated.push({ classCode: cls.code, name, colo });
      log(`[follow] ${cls.label} spare ${name} created in ${colo}`);
      return;
    }
    const stamped = await stampVerified(db, { name, colo, opId, atMs });
    registry.set(name, { ...slot, verifiedAtMs: stamped ? atMs : null });
    held.set(cls.code, (held.get(cls.code) ?? new Set<Colo>()).add(colo));
    report.created.push({ classCode: cls.code, name, colo });
    log(`[follow] ${cls.label} slot ${name} created in ${colo}`);
  };
  const spend = async (
    cls: CreatorClass,
    name: string,
    colo: Colo | null,
    opId: string,
  ): Promise<void> => {
    await learn(colo);
    await recordSpentName(db, {
      opId,
      atMs: deps.now(),
      classCode: cls.code,
      name,
      objectId: cls.objectIdOf(name),
      colo,
    });
    report.spent.push({ classCode: cls.code, name, colo });
    log(
      `[follow] ${cls.label} name ${name} spent - answered from ${colo ?? "nowhere"}`,
    );
  };
  // Each class's attempts this pass beyond its probes, resolutions of old ones
  // and attempts at the primary's gap together, so the calls a pass makes stay
  // at the bound the cost is sized from however many attempts are open.
  const budget = new Map(
    config.classes.map((c) => [c.code, config.attemptsPerClassPerPass]),
  );
  // A class with an attempt still open after resolving starts no new one this
  // pass, so an outage that keeps attempts open cannot grow their number.
  const unresolved = new Set<number>();

  // Resolve attempts from earlier passes whose answers were lost, by asking
  // the name where it is now. Read whole: only creation opens an attempt, and
  // only in a pass that left none of the class's earlier attempts unresolved,
  // so no class has more open than one pass's probes and attempts.
  for (const intent of await readOpenIntents(db, passStartMs)) {
    const cls = classOf.get(intent.classCode);
    if (cls === undefined) {
      continue;
    }
    if (modes.modeOf("class", cls.code) !== "act") {
      // Resolving acts on the object, so a class back in dry-run leaves its
      // attempts open until it acts again.
      unresolved.add(cls.code);
      report.wouldRelease.push(intent.name);
      log(`[follow] ${cls.label} dry-run - would resolve ${intent.name}`);
      continue;
    }
    const left = budget.get(cls.code) ?? 0;
    if (left === 0) {
      unresolved.add(cls.code);
      continue;
    }
    budget.set(cls.code, left - 1);
    await hold();
    let colo: Colo | null;
    try {
      colo = (await call(() => cls.observe(intent.name, null))).colo;
    } catch (error) {
      if (error instanceof LeaseLost) throw error;
      unresolved.add(cls.code);
      fail(`resolve ${intent.name}: ${message(error)}`);
      continue;
    }
    try {
      const role = roleOf(cls, colo);
      if (colo !== null && role !== null) {
        await keep(cls, intent.name, colo, intent.opId, role);
      } else if (await mayEmpty(intent.name)) {
        // An interrupted pass may have placed it before its answer was lost;
        // emptying an object that holds nothing is harmless.
        await call(() => cls.release(intent.name, deadline()));
        await spend(cls, intent.name, colo, intent.opId);
      } else {
        // Refused: the attempt stays open, and the class makes no new ones
        // until it resolves, as for any attempt this pass cannot resolve.
        unresolved.add(cls.code);
      }
    } catch (error) {
      if (error instanceof LeaseLost) throw error;
      unresolved.add(cls.code);
      fail(`resolve ${intent.name}: ${message(error)}`);
    }
  }

  // Probe through each region hint every pass, whatever the class's gaps: a
  // probe that lands where the class has no slot becomes its slot there, and
  // one landing in a new colo is how the colo is learned. Most land beside a
  // slot the class has and are spent. A class with an earlier attempt this
  // pass could not resolve makes no creation, probes included, so an outage
  // cannot grow the open attempts past one pass's worth; a pass's own failures
  // do not stop its remaining creations. A gap in the primary's colo also gets
  // the attempts left in the class's budget, through the hint for the
  // primary's region when the primary names one, backing off while they find
  // nothing to fill there.
  const backoffs = await readBackoff(db);
  // Classes whose backoff this loop settled, so the sweep after it leaves them.
  const settled = new Set<number>();
  for (const cls of config.classes) {
    // The primary's colo is short while the class has no base slot there or
    // fewer spares than it keeps.
    const primaryGap = (): boolean =>
      primary !== null && (!holds(cls.code, primary.colo) || sparesShort(cls));
    if (modes.modeOf("class", cls.code) !== "act") {
      report.wouldCreate.push(cls.code);
      log(
        `[follow] ${cls.label} dry-run - would probe through ${regionHints.join(",")}${primaryGap() && primary?.regionHint ? ` and attempt the gap in ${primary.colo}` : ""}`,
      );
      continue;
    }
    if (unresolved.has(cls.code)) {
      log(
        `[follow] ${cls.label} has attempts still open - no new attempts this pass`,
      );
      continue;
    }
    const attempt = async (regionHint: string): Promise<void> => {
      await hold();
      const opId = deps.newOpId();
      const { name } = await beginCreation(db, {
        classCode: cls.code,
        opId,
        atMs: deps.now(),
        nameOf: (n) => cls.nameOf(n, regionHint),
        objectIdOf: (name) => cls.objectIdOf(name),
      });
      try {
        const { colo } = await call(() => cls.observe(name, regionHint));
        const role = roleOf(cls, colo);
        if (colo !== null && role !== null) {
          await keep(cls, name, colo, opId, role);
        } else {
          await spend(cls, name, colo, opId);
        }
      } catch (error) {
        if (error instanceof LeaseLost) throw error;
        // The intent stays open for a later pass to resolve by observing.
        fail(`create ${name}: ${message(error)}`);
      }
    };
    for (const regionHint of regionHints) {
      await attempt(regionHint);
    }
    const backoff = backoffs.get(cls.code);
    let attempted = false;
    // Only a hint the primary's own region names is attempted through: a
    // region that names none would leave the attempts a guess, spending them
    // for nothing and setting a wait the right hint would then sit out.
    const primaryHint = primary?.regionHint ?? null;
    if (
      primaryHint !== null &&
      (backoff === undefined || passStartMs >= backoff.nextAttemptAtMs)
    ) {
      const attempts = budget.get(cls.code) ?? 0;
      for (let i = 0; i < attempts && primaryGap(); i++) {
        attempted = true;
        await attempt(primaryHint);
      }
    }
    // The wait belongs to a gap in the primary's colo. A pass that finds the
    // class a slot there, or that gained or lost it a slot anywhere, starts it
    // over; one that could not read where the primary is leaves it as it is.
    settled.add(cls.code);
    if (changed.has(cls.code) || (primary !== null && !primaryGap())) {
      if (backoff !== undefined) {
        await clearBackoff(db, cls.code);
      }
    } else if (attempted) {
      await setBackoff(db, cls.code, nextBackoff(backoff, config, passStartMs));
    }
  }
  for (const code of changed) {
    if (!settled.has(code) && backoffs.has(code)) {
      await clearBackoff(db, code);
    }
  }

  // Release what has been out of the registry long enough and holds no lane.
  // Each class reads only its due releases, at most the attempts bound, so a
  // backlog costs a pass no more reads, calls or ledger rows than that.
  const keepList = [...(await keepNames())];
  for (const cls of config.classes) {
    const due = await readReleaseDue(db, {
      classCode: cls.code,
      unregisteredByMs: passStartMs - cls.releaseAfterMs,
      keep: keepList,
      limit: config.attemptsPerClassPerPass,
    });
    for (const pending of due) {
      if (modes.modeOf("class", cls.code) !== "act") {
        report.wouldRelease.push(pending.name);
        log(`[follow] ${cls.label} dry-run - would release ${pending.name}`);
        continue;
      }
      // Waiting in the release queue, but a call to it failed this pass and
      // may still land (CreatorClass.place), so a later pass releases it.
      if (fence.settling(pending.name)) {
        log(
          `[follow] ${cls.label} ${pending.name} has a call this pass that failed and may still land - released by a later pass`,
        );
        continue;
      }
      await hold();
      const opId = deps.newOpId();
      await beginRelease(db, { ...pending, opId, atMs: deps.now() });
      // A lease lost during the call leaves the release unrecorded; the pass
      // now holding the lease releases it again, harmlessly, and records it.
      try {
        await call(() => cls.release(pending.name, deadline()));
      } catch (error) {
        if (error instanceof LeaseLost) throw error;
        // The release's intent stands; a later pass tries again.
        fail(`release ${pending.name}: ${message(error)}`);
        continue;
      }
      await recordReleased(db, { ...pending, opId, atMs: deps.now() });
      report.released.push({
        classCode: cls.code,
        name: pending.name,
        colo: null,
      });
      log(`[follow] ${cls.label} released ${pending.name}`);
    }
  }

  // Copy the app's lane changes the ledger does not hold yet.
  for (const laneCode of config.laneCodes) {
    await hold();
    const after = (await lastCopiedLaneSeq(db, laneCode)) ?? 0;
    const changes = await readLaneChangesAfter(
      deps.appDb,
      laneCode,
      after,
      LANE_CHANGES_PER_PASS,
    );
    for (const change of changes) {
      await recordLaneChange(db, {
        opId: deps.newOpId(),
        laneCode,
        seq: change.seq,
        fromHolder: change.fromHolder,
        toHolder: change.toHolder,
        changedAtMs: change.changedAtMs,
        changedBy: change.changedBy,
      });
      report.laneChangesCopied++;
    }
  }

  // The gaps as the pass leaves them: no verified slot of the class there.
  const verifiedNow = new Map<number, Set<Colo>>();
  const endMs = deps.now();
  for (const slot of registry.values()) {
    if (
      slot.verifiedAtMs !== null &&
      endMs - slot.verifiedAtMs < config.verifiedMaxAgeMs
    ) {
      const colos = verifiedNow.get(slot.classCode) ?? new Set<Colo>();
      colos.add(slot.colo);
      verifiedNow.set(slot.classCode, colos);
    }
  }
  const judged = candidates.judged(primary);
  report.candidateColos.push(...judged);
  for (const cls of config.classes) {
    for (const colo of judged) {
      if (!(verifiedNow.get(cls.code)?.has(colo) ?? false)) {
        report.gaps.push({ classCode: cls.code, colo });
        log(`[follow] ${cls.label} gap - no verified slot in ${colo}`);
      }
    }
    if (primary !== null && sparesUnready(cls)) {
      report.spareGaps.push({ classCode: cls.code, colo: primary.colo });
      log(
        `[follow] ${cls.label} spare gap - ${ready.get(cls.code) ?? 0} of ${cls.spares} verified in ${primary.colo}`,
      );
    }
  }
}

// After a pass whose attempts at the primary's gap filled nothing, the next
// pass to attempt it waits twice as long as the last wait, from a single
// skipped pass up to the cap.
// Half a period is taken off the target so a cron that fires a little early is
// not taken for one that came too soon.
function nextBackoff(
  previous: Backoff | undefined,
  config: CreatorConfig,
  passStartMs: number,
): Backoff {
  const waitMs = Math.min(
    previous === undefined ? 2 * config.passIntervalMs : 2 * previous.waitMs,
    config.maxBackoffMs,
  );
  return {
    waitMs,
    nextAttemptAtMs: passStartMs + waitMs - config.passIntervalMs / 2,
  };
}
