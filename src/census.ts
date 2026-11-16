// The census (README sec."Census"): every object of an app's placed classes
// that holds stored data, reconciled with the registry, the spares and the
// ledger by object id, and with the names the app can put to them. A namespace listing returns
// ids without names, and an object nobody recorded is otherwise findable only
// by guessing names, so the census is how an object made some other way, or one
// whose record never landed, comes to light.
//
// Pure: the app reads its namespace listings, the creator's tables and the
// names it knows, and hands them here. Nothing is released; a sweep would be a
// decision of its own.
import type { LedgerKind, PendingRelease, Slot } from "./creator-store";

// One object from a namespace listing, under the app's name for its class.
export interface ListedObject {
  readonly classLabel: string;
  readonly id: string;
  readonly hasStoredData: boolean;
}

// Why an object holding data is expected to.
export type CensusReason =
  // A registered slot.
  | "slot"
  // A spare kept beside its class's base slot in the primary's colo.
  | "spare"
  // Out of the registry and waiting for its release.
  | "release_pending"
  // Created or seeded by the ledger's account, and not released since.
  | "ledger"
  // A name the app itself keeps alive: a lane's holder, a serving name, an
  // anchor.
  | "named";

export interface CensusObject {
  readonly classLabel: string;
  readonly id: string;
  // The name the app could put to it, or null.
  readonly name: string | null;
}

export interface CensusReport {
  // How many objects holding data each class keeps, and why.
  readonly alive: ReadonlyArray<{
    readonly classLabel: string;
    readonly reason: CensusReason;
    readonly count: number;
  }>;
  // Objects holding data that nothing accounts for.
  readonly unnamed: readonly CensusObject[];
  // Objects holding data that nothing else accounts for - no slot, no pending
  // release, no name the app keeps alive - and whose latest ledger record is an
  // intent with no outcome after it: an attempt whose answer was lost, or one
  // the object refused. The intent says someone tried, not that the object is
  // theirs, so it accounts for nothing. An object one of those accounts for is
  // counted there, whatever its latest record.
  readonly unresolved: readonly CensusObject[];
  // Objects the ledger last recorded as released or spent, still holding data:
  // a release that did not take, or a record that is wrong.
  readonly releasedButHolding: readonly CensusObject[];
  // Registered slots and spares whose object holds no data: one that lost its
  // marker, which the next idle period would take.
  readonly slotsWithoutData: ReadonlyArray<{
    readonly classCode: number;
    readonly name: string;
  }>;
}

export interface CensusInput {
  readonly objects: readonly ListedObject[];
  readonly slots: readonly Slot[];
  readonly spares: readonly Slot[];
  readonly pending: readonly PendingRelease[];
  // The latest ledger kind for each object id the ledger names.
  readonly ledgerKinds: ReadonlyMap<string, LedgerKind>;
  // The name for each object id, as far as the app knows one.
  readonly names: ReadonlyMap<string, string>;
  // Whether the app keeps an object of this class under this name alive for
  // reasons of its own.
  readonly recognized: (classLabel: string, name: string) => boolean;
}

// The ledger kinds that leave an object gone.
const GONE: ReadonlySet<LedgerKind> = new Set(["released", "name_spent"]);

// The ledger kinds written before an act, which settle nothing on their own.
const INTENT: ReadonlySet<LedgerKind> = new Set([
  "creation_intent",
  "release_intent",
]);

export function takeCensus(input: CensusInput): CensusReport {
  const slotIds = new Set(input.slots.map((s) => s.objectId));
  const spareIds = new Set(input.spares.map((s) => s.objectId));
  const pendingIds = new Set(input.pending.map((p) => p.objectId));
  const counts = new Map<string, number>();
  const unnamed: CensusObject[] = [];
  const unresolved: CensusObject[] = [];
  const releasedButHolding: CensusObject[] = [];
  const holding = new Set<string>();

  for (const object of input.objects) {
    if (!object.hasStoredData) continue;
    holding.add(object.id);
    const name = input.names.get(object.id) ?? null;
    const kind = input.ledgerKinds.get(object.id);
    const found: CensusObject = {
      classLabel: object.classLabel,
      id: object.id,
      name,
    };
    if (kind !== undefined && GONE.has(kind)) {
      releasedButHolding.push(found);
      continue;
    }
    const named = name !== null && input.recognized(object.classLabel, name);
    const settled = kind !== undefined && !INTENT.has(kind);
    const reason: CensusReason | null = slotIds.has(object.id)
      ? "slot"
      : spareIds.has(object.id)
        ? "spare"
        : pendingIds.has(object.id)
          ? "release_pending"
          : settled
            ? "ledger"
            : named
              ? "named"
              : null;
    if (reason === null && kind !== undefined) {
      unresolved.push(found);
      continue;
    }
    if (reason === null) {
      unnamed.push(found);
      continue;
    }
    const key = `${object.classLabel}\u0000${reason}`;
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }

  return {
    alive: [...counts]
      .map(([key, count]) => {
        const [classLabel = "", reason] = key.split("\u0000");
        return { classLabel, reason: reason as CensusReason, count };
      })
      .sort(
        (a, b) =>
          a.classLabel.localeCompare(b.classLabel) ||
          a.reason.localeCompare(b.reason),
      ),
    unnamed,
    unresolved,
    releasedButHolding,
    slotsWithoutData: [...input.slots, ...input.spares]
      .filter((s) => !holding.has(s.objectId))
      .map((s) => ({ classCode: s.classCode, name: s.name })),
  };
}
