// The census's verdict on each object a namespace listing returns: accounted
// for, and why, or reported. A miss leaves residue unseen, which is what the
// census exists to prevent; a false report sends an operator after an object
// that is fine.
import { describe, expect, test } from "bun:test";
import { takeCensus, type CensusInput } from "./census";
import type { Colo } from "./colo";
import type { Slot } from "./creator-store";

const MIA = "MIA" as Colo;

const slot = (name: string, objectId: string): Slot => ({
  classCode: 1,
  colo: MIA,
  name,
  objectId,
  registeredAtMs: 0,
  verifiedAtMs: 0,
});

const base = (overrides: Partial<CensusInput>): CensusInput => ({
  objects: [],
  slots: [],
  spares: [],
  pending: [],
  ledgerKinds: new Map(),
  names: new Map(),
  recognized: () => false,
  ...overrides,
});

describe("takeCensus", () => {
  test("accounts for each object holding data by the first reason that holds", () => {
    const report = takeCensus(
      base({
        objects: [
          { classLabel: "CronScheduler", id: "a", hasStoredData: true },
          { classLabel: "CronScheduler", id: "b", hasStoredData: true },
          { classLabel: "Handler", id: "c", hasStoredData: true },
          { classLabel: "Handler", id: "d", hasStoredData: true },
          { classLabel: "Handler", id: "e", hasStoredData: true },
        ],
        slots: [slot("scheduler-x-1", "a")],
        spares: [slot("handler-x-9", "e")],
        pending: [
          {
            name: "scheduler-x-2",
            classCode: 1,
            objectId: "b",
            unregisteredAtMs: 0,
          },
        ],
        ledgerKinds: new Map([["c", "seeded"]]),
        names: new Map([["d", "default-ord-01"]]),
        recognized: (classLabel, name) =>
          classLabel === "Handler" && name === "default-ord-01",
      }),
    );
    expect(report.alive).toEqual([
      { classLabel: "CronScheduler", reason: "release_pending", count: 1 },
      { classLabel: "CronScheduler", reason: "slot", count: 1 },
      { classLabel: "Handler", reason: "ledger", count: 1 },
      { classLabel: "Handler", reason: "named", count: 1 },
      { classLabel: "Handler", reason: "spare", count: 1 },
    ]);
    expect(report.unnamed).toEqual([]);
  });

  // The September 2026 residue: candidates that held data with no record
  // anywhere, found only by guessing their names.
  test("reports an object holding data that nothing accounts for", () => {
    const report = takeCensus(
      base({
        objects: [
          { classLabel: "Handler", id: "e", hasStoredData: true },
          { classLabel: "Handler", id: "f", hasStoredData: true },
        ],
        names: new Map([["f", "candidate-sea-07"]]),
      }),
    );
    expect(report.unnamed).toEqual([
      { classLabel: "Handler", id: "e", name: null },
      { classLabel: "Handler", id: "f", name: "candidate-sea-07" },
    ]);
  });

  // An intent records that someone tried, not that the object is theirs: a
  // placement refused by an object that already held data, or one whose
  // answer was lost, leaves the intent latest, and counting that as owned
  // would hide a foreign object from the unnamed list for good.
  test.each(["creation_intent", "release_intent"] as const)(
    "reports an object whose latest record is a %s as unresolved, not owned",
    (kind) => {
      const report = takeCensus(
        base({
          objects: [{ classLabel: "Handler", id: "i", hasStoredData: true }],
          ledgerKinds: new Map([["i", kind]]),
        }),
      );
      expect(report.unresolved).toEqual([
        { classLabel: "Handler", id: "i", name: null },
      ]);
      expect(report.alive).toEqual([]);
      expect(report.unnamed).toEqual([]);
    },
  );

  // A settled outcome is what makes an object the ledger's.
  test("counts an object whose latest record is a creation as the ledger's", () => {
    const report = takeCensus(
      base({
        objects: [{ classLabel: "Handler", id: "j", hasStoredData: true }],
        ledgerKinds: new Map([["j", "created"]]),
      }),
    );
    expect(report.alive).toEqual([
      { classLabel: "Handler", reason: "ledger", count: 1 },
    ]);
    expect(report.unresolved).toEqual([]);
  });

  // An object the app keeps alive by name stays accounted for even when an
  // operator's attempt on that name left an open intent, as a refused
  // placement of a serving name does.
  test("counts a named object with an open intent as named", () => {
    const report = takeCensus(
      base({
        objects: [{ classLabel: "Handler", id: "k", hasStoredData: true }],
        ledgerKinds: new Map([["k", "creation_intent"]]),
        names: new Map([["k", "default-ord-01"]]),
        recognized: () => true,
      }),
    );
    expect(report.alive).toEqual([
      { classLabel: "Handler", reason: "named", count: 1 },
    ]);
    expect(report.unresolved).toEqual([]);
  });

  // An object without stored data ceases once idle, so it is no residue.
  test("leaves out objects without stored data", () => {
    const report = takeCensus(
      base({
        objects: [{ classLabel: "Handler", id: "g", hasStoredData: false }],
      }),
    );
    expect(report).toMatchObject({ alive: [], unnamed: [] });
  });

  // The ledger says it is gone; the listing says it holds data. Either the
  // release did not take or the record is wrong, and being a slot or a known
  // name does not settle which.
  test("reports an object the ledger released that still holds data", () => {
    const report = takeCensus(
      base({
        objects: [
          { classLabel: "CronScheduler", id: "h", hasStoredData: true },
          { classLabel: "CronScheduler", id: "i", hasStoredData: true },
        ],
        ledgerKinds: new Map([
          ["h", "released"],
          ["i", "name_spent"],
        ]),
        names: new Map([["h", "scheduler-x-3"]]),
        recognized: () => true,
      }),
    );
    expect(report.releasedButHolding.map((o) => o.id)).toEqual(["h", "i"]);
    expect(report.alive).toEqual([]);
  });

  // A slot keeps its colo only while it holds its marker; one without data
  // ceases at its next idle period, and the router would forward into it. A
  // spare is the same object held ready, and a failover would go to it.
  test("reports a registered slot whose object holds no data", () => {
    const report = takeCensus(
      base({
        objects: [
          { classLabel: "CronScheduler", id: "j", hasStoredData: false },
        ],
        slots: [slot("scheduler-x-4", "j"), slot("scheduler-x-5", "k")],
        spares: [slot("scheduler-x-6", "l")],
      }),
    );
    expect(report.slotsWithoutData).toEqual([
      { classCode: 1, name: "scheduler-x-4" },
      { classCode: 1, name: "scheduler-x-5" },
      { classCode: 1, name: "scheduler-x-6" },
    ]);
  });
});
