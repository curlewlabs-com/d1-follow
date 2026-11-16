// The world the creator's pass tests run in: real SQLite, the creator's schema
// in one database and the lane tables in the app's, and a class whose calls
// are scripted - where each new name lands, which objects answer and from
// where. Everything the pass decides and records is the real code. Test-only:
// the published package leaves it out (package.json `files`).
import { Database, type SQLQueryBindings } from "bun:sqlite";
import type { Colo } from "./colo";
import {
  runCreatorPass,
  type CreatorClass,
  type CreatorConfig,
  type CreatorPassReport,
  type ObserveResult,
} from "./creator";
import {
  registerSlot,
  setMode,
  type SqlDatabase,
  type SqlStatement,
} from "./creator-store";

export const ORD = "ORD" as Colo;
export const MIA = "MIA" as Colo;
export const IAD = "IAD" as Colo;
export const DEN = "DEN" as Colo;
export const AMS = "AMS" as Colo;
export const HOUR_MS = 3_600_000;
export const T0_MS = Date.UTC(2026, 9, 6, 3, 0, 0);
export const SCHEDULER = 1;

// Sees each read's statement and the rows it returned.
export type ReadObserver = (query: string, rows: unknown[]) => void;

// The meta D1 would return for a statement, or undefined for none.
type MetaOf = (query: string) => unknown;

function sqliteHandle(
  sqlite: Database,
  onRead?: ReadObserver,
  metaOf?: MetaOf,
): SqlDatabase {
  const statement = (
    query: string,
    values: unknown[],
  ): SqlStatement & { rows(): unknown[] } => ({
    bind: (...next: unknown[]) => statement(query, next),
    all: async () => {
      const meta = metaOf?.(query);
      const results = statement(query, values).rows();
      onRead?.(query, results);
      return meta === undefined ? { results } : { results, meta };
    },
    run: async () => statement(query, values).rows(),
    rows: () => sqlite.query(query).all(...(values as SQLQueryBindings[])),
  });
  return {
    prepare: (query) => statement(query, []),
    batch: async (statements) =>
      sqlite.transaction(() =>
        statements.map((s) => ({
          results: (s as ReturnType<typeof statement>).rows(),
        })),
      )(),
  };
}

async function database(schema: string): Promise<Database> {
  const sqlite = new Database(":memory:");
  sqlite.exec(
    await Bun.file(new URL(`../schema/${schema}`, import.meta.url)).text(),
  );
  return sqlite;
}

export type ScriptedClass = CreatorClass & {
  where: Map<string, Colo>;
  marked: Map<string, Colo>;
  silent: Set<string>;
  // Objects that cannot answer the mark-in-place call, as an older build's.
  unmarkable: Set<string>;
  // A scripted answer to the mark-in-place call, for an object that answers
  // without taking the mark; nothing is written for it.
  markAnswers: Map<string, ObserveResult>;
  placed: string[];
  releasedNames: string[];
};

// A class whose objects live in `where`. A name addressed with a hint for the
// first time lands in the next colo of that hint's list in `byHint`, or of
// `landings` for a hint it does not list; a name that does not answer is
// listed in `silent`.
export function scriptedClass(
  landings: Colo[],
  byHint: Record<string, Colo[]> = {},
): ScriptedClass {
  const where = new Map<string, Colo>();
  const silent = new Set<string>();
  const unmarkable = new Set<string>();
  const markAnswers = new Map<string, ObserveResult>();
  // The colo each object's placement marker names, as the scripted world's
  // place writes it; an object observed before any placement holds none.
  const marked = new Map<string, Colo>();
  const placed: string[] = [];
  const releasedNames: string[] = [];
  return {
    code: SCHEDULER,
    label: "scheduler",
    releaseAfterMs: 0,
    nameOf: (n, hint) => `scheduler-test-${hint}-${n}`,
    objectIdOf: (name) => `id-${name}`,
    spares: 0,
    observe: async (name, hint) => {
      if (silent.has(name)) throw new Error("no answer");
      if (!where.has(name) && hint !== null) {
        const colo = (byHint[hint] ?? landings).shift();
        if (colo === undefined) throw new Error("no landing scripted");
        where.set(name, colo);
      }
      return {
        colo: where.get(name) ?? null,
        markedColo: marked.get(name) ?? null,
      };
    },
    markInPlace: async (name) => {
      if (silent.has(name) || unmarkable.has(name)) {
        throw new Error("no answer");
      }
      const scripted = markAnswers.get(name);
      if (scripted !== undefined) return scripted;
      const colo = where.get(name) ?? null;
      if (colo !== null) marked.set(name, colo);
      return { colo, markedColo: marked.get(name) ?? null };
    },
    place: async (name, colo) => {
      placed.push(name);
      marked.set(name, colo);
    },
    release: async (name) => {
      releasedNames.push(name);
    },
    where,
    marked,
    silent,
    unmarkable,
    markAnswers,
    placed,
    releasedNames,
  };
}

function config(cls: CreatorClass, overrides: Partial<CreatorConfig> = {}) {
  return {
    classes: [cls],
    regionHint: "enam",
    attemptsPerClassPerPass: 4,
    passIntervalMs: HOUR_MS,
    maxBackoffMs: 24 * HOUR_MS,
    verifiedMaxAgeMs: 2 * HOUR_MS,
    protectedNames: new Set<string>(),
    laneCodes: [1],
    ...overrides,
  } satisfies CreatorConfig;
}

// One test's databases and clock. A pass reads the clock as it stands, so a
// test moves time by adding to `clock`. Where the app's primary is comes from
// `primary`: the colo and region its read names, null for a read that names
// none, or "fails" for a read that throws.
export class CreatorWorld {
  clock = T0_MS;
  ops = 0;
  primary: { colo: Colo; region: string } | null | "fails" = null;

  private constructor(
    readonly creator: Database,
    readonly app: Database,
  ) {}

  static async open(): Promise<CreatorWorld> {
    return new CreatorWorld(
      await database("creator.sql"),
      await database("lane.sql"),
    );
  }

  handle(onRead?: ReadObserver): SqlDatabase {
    return sqliteHandle(this.creator, onRead);
  }

  async pass(
    cls: CreatorClass,
    overrides: Partial<CreatorConfig> = {},
    onRead?: ReadObserver,
  ): Promise<CreatorPassReport> {
    return await runCreatorPass({
      db: this.handle(onRead),
      appDb: sqliteHandle(this.app, undefined, (query) => this.appMeta(query)),
      config: config(cls, overrides),
      now: () => this.clock,
      newOpId: () => `op-${++this.ops}`,
      log: () => {},
    });
  }

  private appMeta(query: string): unknown {
    // The pass's primary read, the one app statement that names no table.
    if (query !== "SELECT 1") {
      return undefined;
    }
    if (this.primary === "fails") {
      throw new Error("D1 unavailable");
    }
    return this.primary === null
      ? {}
      : {
          served_by_primary: true,
          served_by_colo: this.primary.colo,
          served_by_region: this.primary.region,
        };
  }

  async act(): Promise<void> {
    await setMode(this.handle(), {
      kind: "class",
      code: SCHEDULER,
      mode: "act",
      opId: "mode",
      atMs: T0_MS,
    });
  }

  async seed(
    name: string,
    colo: Colo,
    verifiedAtMs: number | null,
  ): Promise<void> {
    await registerSlot(
      this.handle(),
      {
        classCode: SCHEDULER,
        colo,
        name,
        objectId: `id-${name}`,
        registeredAtMs: T0_MS - 3 * HOUR_MS,
        verifiedAtMs,
      },
      { opId: `seed-${name}`, kind: "seeded" },
    );
  }
}
