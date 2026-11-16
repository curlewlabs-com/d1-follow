// The pass's observation of the base slots (README sec."The creator: making
// and keeping slots"): each registered slot observed, and kept where it is,
// kept where it moved to, or taken out of the registry. A slot that answers
// from a candidate colo where its class has no slot is kept there, re-marked
// in place, instead of being released for a creation to replace.
import type { Colo } from "./colo";
import type { CreatorClass, ObserveResult, ReportedObject } from "./creator";
import {
  moveSlot,
  stampVerified,
  unregisterSlot,
  type Slot,
  type SqlDatabase,
} from "./creator-store";

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

// Observes every registered slot. Its answer keeps it, moves it, or takes it
// out; when it cannot answer, it stays until its last answer is too old.
// Observing acts on nothing, so the lease is renewed only before a step that
// acts, and an unregister or a move goes ahead only while the slot carries
// the verification the pass read. `registry` is the pass's copy, updated with
// each stamp, move and removal.
export async function observeSlots(pass: {
  readonly db: SqlDatabase;
  readonly classOf: ReadonlyMap<number, CreatorClass>;
  readonly registry: Map<string, Slot>;
  readonly verifiedMaxAgeMs: number;
  // Whether a colo is one the pass keeps slots in.
  readonly isCandidate: (colo: Colo) => boolean;
  // Whether a class acts: keeping a slot where it moved writes to the object.
  readonly acts: (classCode: number) => boolean;
  readonly now: () => number;
  readonly newOpId: () => string;
  // Renews the lease, throwing when another pass has taken it.
  readonly hold: () => Promise<void>;
  readonly fail: (line: string) => void;
  readonly log: (line: string) => void;
}): Promise<{
  verified: string[];
  unregistered: ReportedObject[];
  moved: ReportedObject[];
  // Classes that gained or lost a slot in a colo.
  changed: Set<number>;
}> {
  const { db, registry } = pass;
  const verified: string[] = [];
  const unregistered: ReportedObject[] = [];
  const moved: ReportedObject[] = [];
  const changed = new Set<number>();
  const holdsBase = (classCode: number, colo: Colo): boolean =>
    [...registry.values()].some(
      (s) => s.classCode === classCode && s.colo === colo,
    );

  // Keeps `slot` in `colo`, where it now answers from, by having it mark
  // itself there and moving its row. False when the call failed (an older
  // build cannot answer it), when the answer's colo or marker does not name
  // `colo`, or when the slot's verification changed since the pass read it;
  // the slot then goes to the take-out as before, which leaves a slot
  // verified since for the next pass.
  const keepWhereMoved = async (
    cls: CreatorClass,
    slot: Slot,
    colo: Colo,
  ): Promise<boolean> => {
    await pass.hold();
    let answer: ObserveResult | null = null;
    try {
      answer = await cls.markInPlace(slot.name);
    } catch (error) {
      pass.fail(`mark ${slot.name} in place: ${message(error)}`);
    }
    // Checked again whether the call answered or failed, as every call that
    // acts on an object is: a lost lease outranks the call's own outcome.
    await pass.hold();
    if (answer === null || answer.colo !== colo || answer.markedColo !== colo) {
      return false;
    }
    const atMs = pass.now();
    if (!(await moveSlot(db, slot, { colo, atMs, opId: pass.newOpId() }))) {
      return false;
    }
    registry.set(slot.name, { ...slot, colo, verifiedAtMs: atMs });
    moved.push({ classCode: slot.classCode, name: slot.name, colo });
    changed.add(slot.classCode);
    pass.log(
      `[follow] ${cls.label} slot ${slot.name} kept in ${colo}, where it moved from ${slot.colo}`,
    );
    return true;
  };

  for (const slot of [...registry.values()]) {
    const cls = pass.classOf.get(slot.classCode);
    if (cls === undefined) {
      continue;
    }
    let colo: Colo | null;
    try {
      colo = (await cls.observe(slot.name, null)).colo;
    } catch (error) {
      pass.fail(`observe ${slot.name}: ${message(error)}`);
      colo = null;
    }
    const atMs = pass.now();
    if (colo === slot.colo) {
      await stampVerified(db, { name: slot.name, opId: pass.newOpId(), atMs });
      registry.set(slot.name, { ...slot, verifiedAtMs: atMs });
      verified.push(slot.name);
      continue;
    }
    const lastAnswerMs = slot.verifiedAtMs ?? slot.registeredAtMs;
    if (colo === null && atMs - lastAnswerMs < pass.verifiedMaxAgeMs) {
      pass.log(
        `[follow] ${cls.label} slot ${slot.name} did not answer this pass`,
      );
      continue;
    }
    if (
      colo !== null &&
      pass.acts(slot.classCode) &&
      pass.isCandidate(colo) &&
      !holdsBase(slot.classCode, colo) &&
      (await keepWhereMoved(cls, slot, colo))
    ) {
      continue;
    }
    const detail =
      colo === null
        ? `no answer from ${slot.colo} since ${new Date(lastAnswerMs).toISOString()}`
        : `answered from ${colo}`;
    // A pass that lost its lease stops here rather than act on its reading.
    // One that holds it may still have read the slot before a pass that lost
    // the lease stamped it, which the unregister itself checks.
    await pass.hold();
    const left = await unregisterSlot(db, slot, {
      opId: pass.newOpId(),
      atMs,
      detail,
    });
    if (!left) {
      pass.log(
        `[follow] ${cls.label} slot ${slot.name} was verified again since this pass read it - left for the next pass`,
      );
      continue;
    }
    registry.delete(slot.name);
    unregistered.push({
      classCode: slot.classCode,
      name: slot.name,
      colo: slot.colo,
    });
    changed.add(slot.classCode);
    pass.log(
      `[follow] ${cls.label} slot ${slot.name} left the registry - ${detail}`,
    );
  }
  return { verified, unregistered, moved, changed };
}
