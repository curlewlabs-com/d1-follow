// D1's statement handle over bun:sqlite, for the store's tests: the same SQL,
// constraints and batch atomicity D1 gives, run in memory.
import type { Database, SQLQueryBindings } from "bun:sqlite";
import type { SqlDatabase, SqlStatement } from "./creator-store";

// D1's handle over bun:sqlite. A batch runs in one transaction and returns
// each statement's rows, as D1's does. Each method builds its promise in an
// executor so a SQL error rejects it, as it does on D1, rather than throwing
// where the call is made.
export function sqliteHandle(sqlite: Database): SqlDatabase {
  const statement = (
    query: string,
    values: unknown[],
  ): SqlStatement & {
    rows(): unknown[];
  } => ({
    bind: (...next: unknown[]) => statement(query, next),
    all: () =>
      new Promise((resolve) => {
        resolve({ results: statement(query, values).rows() });
      }),
    run: () =>
      new Promise((resolve) => {
        resolve(statement(query, values).rows());
      }),
    rows: () => sqlite.query(query).all(...(values as SQLQueryBindings[])),
  });
  return {
    prepare: (query) => statement(query, []),
    batch: (statements) =>
      new Promise((resolve) => {
        resolve(
          sqlite.transaction(() =>
            statements.map((s) => ({
              results: (s as ReturnType<typeof statement>).rows(),
            })),
          )(),
        );
      }),
  };
}
