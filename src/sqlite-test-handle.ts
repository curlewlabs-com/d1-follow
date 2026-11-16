// D1's statement handle over bun:sqlite, for the store's tests: the same SQL,
// constraints and batch atomicity D1 gives, run in memory.
import type { Database, SQLQueryBindings } from "bun:sqlite";
import type { SqlDatabase, SqlStatement } from "./creator-store";

// D1's handle over bun:sqlite. A batch runs in one transaction and returns
// each statement's rows, as D1's does.
export function sqliteHandle(sqlite: Database): SqlDatabase {
  const statement = (
    query: string,
    values: unknown[],
  ): SqlStatement & {
    rows(): unknown[];
  } => ({
    bind: (...next: unknown[]) => statement(query, next),
    all: async () => ({ results: statement(query, values).rows() }),
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
