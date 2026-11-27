// The creator's pass (README sec."The creator: making and keeping slots"): one
// run of the loop that keeps a verified object of each class in each candidate
// colo. It reads where the app's primary is, observes the registered slots,
// resolves attempts whose answers were lost, probes through each region hint
// as the hint's wait and the class's gaps pace it, fills a gap beside the
// primary, releases what the release rule allows, copies the app's lane
// changes into the ledger, and reports the gaps.
//
// The app supplies each class's calls and names and the databases; this owns
// the decisions and their records. Observing and recording run in either mode.
// Creating and releasing objects run only in act mode, and dry-run logs what
// they would do.
import { readLaneChangesAfter, readLaneHolders } from "./app-lane-reads";
import type { Colo } from "./colo";
import { PassCandidates, syncRegionHints } from "./creator-candidates";
import {
  keepsProbing,
  paceAttempts,
  passReading,
  untrustedGap,
  type AttemptPacing,
} from "./creator-gaps";
import { nextHintWait, paceHint } from "./creator-hints";
import { observeSlots } from "./creator-slots";
import { observeSpares, settleSpares } from "./creator-spares";
import {
  beginCreation,
  beginRelease,
  lastCopiedLaneSeq,
  readModes,
  readOpenIntents,
  readReleaseDue,
  readSlots,
  recordLaneChange,
  recordReleased,
  recordSpentName,
  registerSlot,
  stampVerified,
  type Slot,
  type SqlDatabase,
} from "./creator-store";
import {
  deleteGap,
  readGaps,
  writeGap,
  type GapKind,
  type GapRecord,
} from "./gap-store";
import {
  deleteHintWait,
  readHintWaits,
  writeHintWait,
} from "./hint-wait-store";
import { LANE_HANDOFF_SETTLE_MS } from "./lane";
import { claimPass, LeaseLost, releasePass, renewPass } from "./pass-lease";
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
  // The creator never releases sooner than LANE_HANDOFF_SETTLE_MS (lane.ts),
  // whatever this says.
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
  // it refused or failed. The pass calls it no sooner than
  // LANE_HANDOFF_SETTLE_MS after unregistering, so a handoff still committing
  // lands before its holder check; one that can commit later than that needs
  // the app to exclude handoffs through this call (README sec."Release").
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
  // The app's own region hint, which the pass probes through in its rounds. A
  // hint for each region the app's primary is later seen in joins it, and
  // stays.
  readonly regionHint: string;
  // Each class's attempts per pass beyond its probes, shared between resolving
  // attempts whose answers were lost and filling a gap in the primary's colo;
  // releases take the same bound. The cost bound is sized from it.
  readonly attemptsPerClassPerPass: number;
  // The time between passes, the creator's cron period.
  readonly passIntervalMs: number;
  // The cap on the creator's pacing (README sec."Pacing the probes" and
  // sec."Pacing the attempts"): how long a gap keeps its class probing through
  // every hint, and its attempts in the primary's colo running, on every pass
  // from its first creation; how far apart an old gap's attempts are; and the
  // longest wait between a hint's rounds of probes.
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
  // tables (schema/lane.sql). Its lane reads must reach the primary uncached:
  // the release step's holder check is what a handoff's settle time protects,
  // and a replica could hide a swap that has already committed.
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
  // The region hints the creator holds: the app's own, and each added since.
  // Each is probed through in its rounds, so a pass may probe through fewer of
  // them (regionHintsProbed).
  readonly regionHints: readonly string[];
  // Hints this pass added because the primary was seen in their region.
  readonly regionHintsAdded: readonly string[];
  // The region hints a class that acts probed through this pass, in
  // regionHints' order; what dry-run would probe through is in its log.
  readonly regionHintsProbed: readonly string[];
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

// The attempts' pacing for the gap in the primary's colo, with the gap's
// colo and kind as the pacing read them.
interface Paced {
  readonly colo: Colo;
  readonly kind: GapKind;
  readonly pacing: AttemptPacing;
}

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
      { holder, deadline, settling: (name) => unsettled.has(name) },
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
    regionHintsProbed: [] as string[],
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
// it. `fence.holder` is the lease's holder, which a guarded write names;
// `fence.deadline` is the deadline each call that acts on an object
// carries (CreatorClass.place); `fence.settling` names an object whose call
// this pass failed and may still land, which nothing may empty this pass.
async function runLeasedPass(
  deps: CreatorPassDeps,
  report: ReturnType<typeof emptyReport>,
  hold: () => Promise<void>,
  fence: {
    readonly holder: string;
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
    fence.holder,
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

  // Probe through each region hint in its round, and through every hint while
  // the class has a young gap (creator-hints.ts, creator-gaps.ts): a probe
  // that lands where the class has no slot becomes its slot there, and one
  // landing in a new colo is how the colo is learned. Most land beside a slot
  // the class has and are spent. A class with an earlier attempt this pass
  // could not resolve makes no creation, probes included, so an outage cannot
  // grow the open attempts past one pass's worth; a pass's own failures do not
  // stop its remaining creations. A gap in the primary's colo also gets the
  // attempts left in the class's budget, through the hint for the primary's
  // region when the primary names one, as its record paces them.
  const clock = {
    passStartMs,
    capMs: config.maxBackoffMs,
    passIntervalMs: config.passIntervalMs,
  };
  const gapKey = (classCode: number, colo: Colo): string =>
    `${classCode}:${colo}`;
  const gapRecords = new Map<string, GapRecord>();
  for (const record of await readGaps(db)) {
    gapRecords.set(gapKey(record.classCode, record.colo), record);
  }
  const waits = new Map(
    (await readHintWaits(db)).map((wait) => [wait.regionHint, wait]),
  );
  const hintPacing = new Map(
    regionHints.map((hint) => [hint, paceHint(waits.get(hint), clock)]),
  );
  for (const [hint, pacing] of hintPacing) {
    if (pacing.dueAtMs !== null) {
      log(
        `[follow] region hint ${hint} waits - its next round is a pass from ${new Date(pacing.dueAtMs).toISOString()}`,
      );
    }
  }
  // Which hints are in their round is read once, as the probes begin, so
  // every class this pass is paced alike. A colo learned during the pass
  // deletes every wait, so the next pass's rounds open for all of them.
  const inRound = (hint: string): boolean =>
    hintPacing.get(hint)?.round ?? true;
  // What the probes taught, by hint: each hint a class that acts probed
  // through, each one a probe through it answered with a colo, and each one a
  // probe answered from a colo that was no candidate. A probe left open, or
  // one that answered with no colo, counts for nothing.
  const made = new Set<string>();
  const usable = new Set<string>();
  const taught = new Set<string>();
  // Reported as each probe's call is made, so a pass that stops partway
  // reports the probes it made.
  const probed = new Set<string>();
  const reportProbed = (hint: string): void => {
    probed.add(hint);
    report.regionHintsProbed.splice(
      0,
      report.regionHintsProbed.length,
      ...regionHints.filter((h) => probed.has(h)),
    );
  };
  for (const cls of config.classes) {
    // What the class lacks in `colo` as the pass stands now, or null for no
    // gap: its slot there, in a candidate colo or the primary's, or, with its
    // slot in the primary's colo, the spares it keeps there.
    const gapIn = (colo: Colo): GapKind | null => {
      if (!holds(cls.code, colo)) {
        return colo === primary?.colo || candidates.has(colo) ? "slot" : null;
      }
      return colo === primary?.colo && sparesShort(cls) ? "spares" : null;
    };
    const primaryGap = (): boolean =>
      primary !== null && gapIn(primary.colo) !== null;
    // How the attempts at the gap in the primary's colo are paced, read as
    // the pass stands when asked, so a probe that changed the gap counts.
    // The gap's record paces them only while it is of the gap's kind: a slot
    // lost where only spares were short, or the reverse, is a new gap. Null
    // with no gap, or when the pass could not read where the primary is,
    // since it cannot say which colo the attempts are for.
    const paceNow = (): Paced | null => {
      if (primary === null) return null;
      const kind = gapIn(primary.colo);
      if (kind === null) return null;
      const record = gapRecords.get(gapKey(cls.code, primary.colo));
      return {
        colo: primary.colo,
        kind,
        pacing: paceAttempts(record?.kind === kind ? record : undefined, {
          passStartMs,
          capMs: config.maxBackoffMs,
          passIntervalMs: config.passIntervalMs,
        }),
      };
    };
    // Only a hint the primary's own region names is attempted through: a
    // region that names none would leave the attempts a guess, spending them
    // for nothing, and begin a record that ages the gap before the right hint
    // could reach it.
    const primaryHint = primary?.regionHint ?? null;
    // When a waiting gap is next attempted, read when logged, so a gap a
    // probe has just filled, or one no hint can reach, names no time.
    const waitNote = (): string | null => {
      const paced = paceNow();
      return paced !== null &&
        primaryHint !== null &&
        paced.pacing.dueAtMs !== null
        ? `the gap in ${paced.colo} is next attempted by a pass from ${new Date(paced.pacing.dueAtMs).toISOString()}`
        : null;
    };
    // Whether the class has a gap that keeps it probing through every hint
    // whatever their waits: one no pass has created for, one whose record is
    // of another kind or cannot be trusted, a young one, or one in the
    // primary's colo whose record this pass's attempts will start over, since
    // it is young again from the first pass that can attempt it.
    const youngGap = (): boolean =>
      candidates.judged(primary).some((colo) => {
        const kind = gapIn(colo);
        if (kind === null) return false;
        const held = gapRecords.get(gapKey(cls.code, colo));
        const record = held?.kind === kind ? held : undefined;
        const restarts =
          record?.attemptedAtMs === null &&
          colo === primary?.colo &&
          primaryHint !== null &&
          (budget.get(cls.code) ?? 0) > 0;
        return restarts || keepsProbing(record, clock);
      });
    if (modes.modeOf("class", cls.code) !== "act") {
      report.wouldCreate.push(cls.code);
      const young = youngGap();
      const hints = regionHints.filter((hint) => young || inRound(hint));
      const paced = paceNow();
      const due = paced !== null && paced.pacing.due && primaryHint !== null;
      const note = waitNote();
      log(
        `[follow] ${cls.label} dry-run - would probe through ${hints.length > 0 ? hints.join(",") : "no hint"}${due ? ` and attempt the gap in ${paced.colo}` : ""}${note === null ? "" : `; ${note}`}`,
      );
      continue;
    }
    // A probe is a creation for every gap the class has, so before each one
    // the pass begins the record of each gap that has none of its kind, or
    // one it cannot trust, as an attempt's record comes before the attempt.
    // Such a record has no attempt, so the attempts start it over on the
    // first pass that can make one (creator-gaps.ts). A refused write means
    // the lease is gone, and the pass stops before the probe.
    const recordProbe = async (): Promise<void> => {
      for (const colo of candidates.judged(primary)) {
        const kind = gapIn(colo);
        if (kind === null) continue;
        const key = gapKey(cls.code, colo);
        const held = gapRecords.get(key);
        if (held?.kind === kind && !untrustedGap(held, passStartMs)) continue;
        const record: GapRecord = {
          classCode: cls.code,
          colo,
          kind,
          begunAtMs: passStartMs,
          attemptedAtMs: null,
        };
        if (!(await writeGap(db, record, fence.holder))) throw new LeaseLost();
        if (held?.kind === kind) {
          log(
            `[follow] ${cls.label} gap record in ${colo} cannot be trusted - replaced`,
          );
        }
        gapRecords.set(key, record);
      }
    };
    // Each attempt at the gap in the primary's colo is recorded before it is
    // made, under the lease, as a creation's intent comes before it: the
    // pass's first attempt at each kind of gap writes the record, so a pass
    // that stops partway has recorded what it attempted, and a kind no
    // creation was made for gets no record. A gap whose kind changed under
    // this pass's attempts began with them. A refused write means the lease
    // is gone, and the pass stops before the attempt.
    const recorded = new Set<GapKind>();
    const recordAttempt = async (paced: Paced): Promise<void> => {
      const kind = gapIn(paced.colo);
      if (kind === null || recorded.has(kind)) return;
      recorded.add(kind);
      const record: GapRecord = {
        classCode: cls.code,
        colo: paced.colo,
        kind,
        begunAtMs: paced.kind === kind ? paced.pacing.begunAtMs : passStartMs,
        attemptedAtMs: passStartMs,
      };
      if (!(await writeGap(db, record, fence.holder))) throw new LeaseLost();
      gapRecords.set(gapKey(cls.code, paced.colo), record);
    };
    // A gap's record goes once a pass sees the gap filled, of another kind,
    // or gone from the class: a colo that is no candidate and no longer the
    // primary's, or a shortfall of spares in a colo the primary has left. A
    // gap that returns or changes kind is then a new one. A record the pass
    // could not trust goes too when no creation replaced it. A pass that
    // could not read the primary judges only a missing slot the class now
    // holds, which is closed or a shortfall of spares, a new gap either way;
    // it leaves every other record to a pass that reads the primary. Each
    // delete is guarded on the lease, so a pass that lost it cannot remove
    // what the next one wrote, and stops on finding it lost.
    const settleGaps = async (): Promise<void> => {
      for (const record of gapRecords.values()) {
        if (record.classCode !== cls.code) continue;
        if (
          primary === null &&
          !(record.kind === "slot" && holds(cls.code, record.colo))
        ) {
          continue;
        }
        const kind = gapIn(record.colo);
        const dropped =
          kind === record.kind && untrustedGap(record, passStartMs);
        if (kind === record.kind && !dropped) continue;
        if (!(await deleteGap(db, record, fence.holder))) {
          throw new LeaseLost();
        }
        log(
          dropped
            ? `[follow] ${cls.label} gap record in ${record.colo} cannot be trusted - deleted`
            : kind === null
              ? `[follow] ${cls.label} gap in ${record.colo} closed - its record is deleted`
              : `[follow] ${cls.label} gap in ${record.colo} is now ${kind === "slot" ? "a missing slot" : "a shortfall of spares"} - its record is deleted`,
        );
      }
    };
    if (unresolved.has(cls.code)) {
      log(
        `[follow] ${cls.label} has attempts still open - no new attempts this pass`,
      );
      await settleGaps();
      continue;
    }
    // Makes one creation through `regionHint`, and resolves the colo it
    // answered from and whether that colo was already a candidate, or null
    // when its answer was lost. `dispatched` runs as the creation's call is
    // made.
    const attempt = async (
      regionHint: string,
      dispatched?: () => void,
    ): Promise<{ colo: Colo | null; known: boolean } | null> => {
      await hold();
      const opId = deps.newOpId();
      const { name } = await beginCreation(db, {
        classCode: cls.code,
        opId,
        atMs: deps.now(),
        nameOf: (n) => cls.nameOf(n, regionHint),
        objectIdOf: (name) => cls.objectIdOf(name),
      });
      let answer: { colo: Colo | null; known: boolean } | null = null;
      try {
        dispatched?.();
        const { colo } = await call(() => cls.observe(name, regionHint));
        answer = { colo, known: colo !== null && candidates.has(colo) };
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
      return answer;
    };
    for (const regionHint of regionHints) {
      if (!inRound(regionHint) && !youngGap()) continue;
      await recordProbe();
      const answer = await attempt(regionHint, () => {
        reportProbed(regionHint);
      });
      made.add(regionHint);
      if (answer === null || answer.colo === null) continue;
      usable.add(regionHint);
      if (!answer.known) taught.add(regionHint);
    }
    const paced = paceNow();
    if (paced !== null && paced.pacing.due && primaryHint !== null) {
      const attempts = budget.get(cls.code) ?? 0;
      for (let i = 0; i < attempts && primaryGap(); i++) {
        await recordAttempt(paced);
        await attempt(primaryHint);
      }
    } else {
      const note = waitNote();
      if (note !== null) log(`[follow] ${cls.label} ${note}`);
    }
    await settleGaps();
  }

  // A round with a usable answer, every one from a colo already a candidate,
  // doubles its hint's wait; a round with none leaves the wait as it was, and
  // drops one the pass could not trust. Probes through a hint outside its
  // round were made only for a young gap, and are no round. A pass that added
  // a colo deleted every wait in the batch that added it, and writes none.
  // Each write is guarded on the lease, so a pass that lost it cannot put back
  // a wait the next pass deleted.
  for (const [hint, pacing] of candidates.addedAny ? [] : hintPacing) {
    if (!pacing.round || !made.has(hint)) continue;
    const wait =
      usable.has(hint) && !taught.has(hint)
        ? nextHintWait(hint, pacing, clock)
        : null;
    if (wait !== null) {
      if (!(await writeHintWait(db, wait, fence.holder))) throw new LeaseLost();
      log(
        `[follow] region hint ${hint}'s round taught nothing - its next round is a pass from ${new Date(passReading(wait.dueAtMs, config.passIntervalMs)).toISOString()}`,
      );
    } else if (pacing.reason === "untrusted") {
      if (!(await deleteHintWait(db, hint, fence.holder))) {
        throw new LeaseLost();
      }
      log(`[follow] region hint ${hint}'s wait cannot be trusted - deleted`);
    }
  }

  // Release what has been out of the registry long enough and holds no lane.
  // Each class reads only its due releases, at most the attempts bound, so a
  // backlog costs a pass no more reads, calls or ledger rows than that.
  const keepList = [...(await keepNames())];
  for (const cls of config.classes) {
    const due = await readReleaseDue(db, {
      classCode: cls.code,
      unregisteredByMs:
        passStartMs - Math.max(cls.releaseAfterMs, LANE_HANDOFF_SETTLE_MS),
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
