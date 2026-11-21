// The spares' part of the creator's pass (README sec."Spare slots in a table of
// their own"): which spares stay, which a base slot's departure promotes, and
// which the primary's move takes out. A spare is verified only while it
// answers from its colo holding the placement marker written for that colo: a
// spare's name is refused by placement only in builds that read the spare
// table, so one an older build emptied can still answer from its colo, and
// only its missing marker says it is no longer held ready.
import type { Colo } from "./colo";
import type { CreatorClass, ObserveResult, ReportedObject } from "./creator";
import {
  restampReleasePending,
  type Slot,
  type SqlDatabase,
} from "./creator-store";
import {
  promoteSpare,
  readSpares,
  stampSpareVerified,
  unregisterSpare,
} from "./spare-store";

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

// Why an answer does not keep the spare: it came from another colo, or it
// held no marker for the spare's own.
function unkept(spare: { readonly colo: Colo }, seen: ObserveResult): string {
  if (seen.colo !== null && seen.colo !== spare.colo) {
    return `answered from ${seen.colo}`;
  }
  const from = seen.colo ?? "a colo it could not name";
  return seen.markedColo === null
    ? `answered from ${from} holding no marker`
    : `answered from ${from} holding a marker for ${seen.markedColo}`;
}

// Observes each registered spare, and takes out of the spare table, for
// release, one that answered without its colo's marker and did not take a new
// one, or that has not answered for longer than a slot may. Observing acts on
// nothing, so the lease is renewed only before a step that acts: an
// unregistration, which goes ahead only while the spare carries the
// verification the pass read, and a mark-in-place call, after which the lease
// is checked again whether the call answered or failed.
export async function observeSpares(pass: {
  readonly db: SqlDatabase;
  readonly classOf: ReadonlyMap<number, CreatorClass>;
  readonly verifiedMaxAgeMs: number;
  // Whether a class acts: re-marking a spare writes to the object.
  readonly acts: (classCode: number) => boolean;
  readonly now: () => number;
  readonly newOpId: () => string;
  readonly hold: () => Promise<void>;
  // The deadline a call that acts carries (CreatorClass.place).
  readonly deadline: () => number;
  readonly fail: (line: string) => void;
  readonly log: (line: string) => void;
}): Promise<{
  verified: string[];
  unregistered: ReportedObject[];
  // Spares re-marked in their colo, which then verified.
  remarked: string[];
  // The spares still in the table, with the pass's own stamps applied.
  kept: Slot[];
}> {
  const { db } = pass;
  const verified: string[] = [];
  const unregistered: ReportedObject[] = [];
  const remarked: string[] = [];
  const kept: Slot[] = [];
  // A spare still answering from its colo without that colo's marker, as an
  // older build's placement leaves one, is asked to mark itself there rather
  // than be released for a creation to replace. True when it took.
  const remark = async (cls: CreatorClass, spare: Slot): Promise<boolean> => {
    await pass.hold();
    let answer: ObserveResult | null = null;
    try {
      answer = await cls.markInPlace(spare.name, pass.deadline());
    } catch (error) {
      pass.fail(`mark spare ${spare.name} in place: ${message(error)}`);
    }
    // Checked again whether the call answered or failed, as every call that
    // acts on an object is.
    await pass.hold();
    return answer?.colo === spare.colo && answer.markedColo === spare.colo;
  };
  for (const spare of await readSpares(db)) {
    const cls = pass.classOf.get(spare.classCode);
    if (cls === undefined) {
      continue;
    }
    let seen: ObserveResult | null;
    try {
      seen = await cls.observe(spare.name, null);
    } catch (error) {
      pass.fail(`observe spare ${spare.name}: ${message(error)}`);
      seen = null;
    }
    const atMs = pass.now();
    if (
      seen !== null &&
      seen.colo === spare.colo &&
      seen.markedColo === spare.colo
    ) {
      const stamped = await stampSpareVerified(db, {
        name: spare.name,
        colo: spare.colo,
        opId: pass.newOpId(),
        atMs,
      });
      if (!stamped) {
        pass.log(
          `[follow] ${cls.label} spare ${spare.name} is no longer registered in ${spare.colo} - left for the next pass`,
        );
        continue;
      }
      verified.push(spare.name);
      kept.push({ ...spare, verifiedAtMs: atMs });
      continue;
    }
    const lastAnswerMs = spare.verifiedAtMs ?? spare.registeredAtMs;
    // An object that could not name its colo still says what its marker
    // names: a missing or foreign marker is as definite as a wrong colo, so
    // only a failed call, or an unnamed colo beside the right marker, waits.
    const silent =
      seen === null || (seen.colo === null && seen.markedColo === spare.colo);
    if (silent && atMs - lastAnswerMs < pass.verifiedMaxAgeMs) {
      pass.log(
        `[follow] ${cls.label} spare ${spare.name} did not answer this pass`,
      );
      kept.push(spare);
      continue;
    }
    if (
      seen?.colo === spare.colo &&
      pass.acts(spare.classCode) &&
      (await remark(cls, spare))
    ) {
      const markedAtMs = pass.now();
      const stamped = await stampSpareVerified(db, {
        name: spare.name,
        colo: spare.colo,
        opId: pass.newOpId(),
        atMs: markedAtMs,
      });
      if (!stamped) {
        pass.log(
          `[follow] ${cls.label} spare ${spare.name} is no longer registered in ${spare.colo} - left for the next pass`,
        );
        continue;
      }
      verified.push(spare.name);
      remarked.push(spare.name);
      kept.push({ ...spare, verifiedAtMs: markedAtMs });
      pass.log(
        `[follow] ${cls.label} spare ${spare.name} marked again in ${spare.colo}`,
      );
      continue;
    }
    const detail =
      seen === null || silent
        ? `no answer from ${spare.colo} since ${new Date(lastAnswerMs).toISOString()}`
        : unkept(spare, seen);
    await pass.hold();
    // Stamped when it leaves, not when it was observed: the release's settle
    // time runs from here, and a slow re-mark above must not use it up while
    // the spare was still registered.
    const left = await unregisterSpare(db, spare, {
      opId: pass.newOpId(),
      atMs: pass.now(),
      detail,
    });
    if (!left) {
      pass.log(
        `[follow] ${cls.label} spare ${spare.name} was verified again since this pass read it - left for the next pass`,
      );
      kept.push(spare);
      continue;
    }
    await restampReleasePending(db, spare.name, pass.now());
    unregistered.push({
      classCode: spare.classCode,
      name: spare.name,
      colo: spare.colo,
    });
    pass.log(
      `[follow] ${cls.label} spare ${spare.name} left the spare table - ${detail}`,
    );
  }
  return { verified, unregistered, remarked, kept };
}

// Settles the kept spares against the primary, the registry and each class's
// count. While the pass knows where the primary is, a spare outside the
// primary's colo leaves the spare table for release first, since spares are
// kept only beside the primary; a colo the primary has left therefore never
// takes one as its base slot. A verified spare in a colo whose base slot of the
// class has left is promoted to it, with no creation. A class with more spares
// there than it keeps takes the surplus out, unverified ones first and then the
// latest registered, so an interrupted creation never leaves the cost above what
// was sized and never costs a verified spare its place. These are records the
// pass makes in either mode: no object is called. Returns, for each class, how
// many spares the primary's colo holds after (`occupied`, which bounds
// creation) and how many of those are verified (`ready`, which says whether the
// class has the spares it keeps), and adds each promoted spare to `registry`.
export async function settleSpares(pass: {
  readonly db: SqlDatabase;
  readonly classOf: ReadonlyMap<number, CreatorClass>;
  readonly kept: readonly Slot[];
  readonly registry: Map<string, Slot>;
  readonly primaryColo: Colo | null;
  readonly now: () => number;
  readonly newOpId: () => string;
  readonly hold: () => Promise<void>;
  readonly log: (line: string) => void;
}): Promise<{
  promoted: ReportedObject[];
  unregistered: ReportedObject[];
  occupied: Map<number, number>;
  ready: Map<number, number>;
}> {
  const { db, registry } = pass;
  const promoted: ReportedObject[] = [];
  const unregistered: ReportedObject[] = [];
  const occupied = new Map<number, number>();
  const ready = new Map<number, number>();
  const bump = (counts: Map<number, number>, classCode: number): void => {
    counts.set(classCode, (counts.get(classCode) ?? 0) + 1);
  };
  const hasBase = (classCode: number, colo: Colo): boolean =>
    [...registry.values()].some(
      (s) => s.classCode === classCode && s.colo === colo,
    );
  // Spares a take-out found verified again since this pass read them: still in
  // the table, so each counts against its class's creation for the rest of the
  // pass, and the next pass reads it afresh.
  const lingering: Slot[] = [];
  const takeOut = async (spare: Slot, detail: string): Promise<void> => {
    await pass.hold();
    const left = await unregisterSpare(db, spare, {
      opId: pass.newOpId(),
      atMs: pass.now(),
      detail,
    });
    const label = pass.classOf.get(spare.classCode)?.label ?? "class";
    if (!left) {
      pass.log(
        `[follow] ${label} spare ${spare.name} was verified again since this pass read it - left for the next pass`,
      );
      lingering.push(spare);
      return;
    }
    await restampReleasePending(db, spare.name, pass.now());
    unregistered.push({
      classCode: spare.classCode,
      name: spare.name,
      colo: spare.colo,
    });
    pass.log(
      `[follow] ${label} spare ${spare.name} left the spare table - ${detail}`,
    );
  };
  // Verified spares ahead of unverified ones within each class and colo, each
  // in registration order, so the ones a class keeps are its verified ones.
  const order = [...pass.kept].sort(
    (a, b) =>
      a.classCode - b.classCode ||
      a.colo.localeCompare(b.colo) ||
      Number(a.verifiedAtMs === null) - Number(b.verifiedAtMs === null),
  );
  for (const spare of order) {
    const cls = pass.classOf.get(spare.classCode);
    if (pass.primaryColo !== null && spare.colo !== pass.primaryColo) {
      await takeOut(spare, `the primary moved to ${pass.primaryColo}`);
      continue;
    }
    if (spare.verifiedAtMs !== null && !hasBase(spare.classCode, spare.colo)) {
      await pass.hold();
      if (
        await promoteSpare(db, spare.name, {
          opId: pass.newOpId(),
          atMs: pass.now(),
        })
      ) {
        registry.set(spare.name, spare);
        promoted.push({
          classCode: spare.classCode,
          name: spare.name,
          colo: spare.colo,
        });
        pass.log(
          `[follow] ${cls?.label ?? "class"} spare ${spare.name} promoted to the base slot in ${spare.colo}`,
        );
        continue;
      }
    }
    const held = occupied.get(spare.classCode) ?? 0;
    if (cls !== undefined && held >= cls.spares) {
      await takeOut(spare, `the class keeps ${cls.spares} beside the primary`);
      continue;
    }
    if (spare.colo === pass.primaryColo) {
      bump(occupied, spare.classCode);
      if (spare.verifiedAtMs !== null) bump(ready, spare.classCode);
    }
  }
  // Counted after the loop, so a lingering spare blocks a creation without
  // pushing out a spare the class keeps.
  for (const spare of lingering) bump(occupied, spare.classCode);
  return { promoted, unregistered, occupied, ready };
}
