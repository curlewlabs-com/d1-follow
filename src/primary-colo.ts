// The D1 primary's colo, learned from the metadata of a query result that the
// primary served.
//
// A D1 result's meta carries `served_by_primary` and `served_by_colo`.
// Cloudflare documents the first but not the second
// (https://developers.cloudflare.com/d1/worker-api/return-object/), so the meta
// is taken as unknown and each field is narrowed here: a meta that is not an
// object, a result a replica served, and a result without a well-formed colo
// all teach nothing. A replica cannot say where the primary is.
import { parseColo, type Colo } from "./colo";
import type { SqlDatabase } from "./creator-store";

// One primary-served result, and when the caller's clock saw it.
export interface PrimarySighting {
  readonly colo: Colo;
  readonly atMs: number;
}

// `served_by_primary` is a boolean on some runtimes and 1 or 0 on others.
function servedByPrimary(value: unknown): boolean {
  return value === true || value === 1;
}

function metaField(meta: unknown, name: string): unknown {
  return typeof meta === "object" && meta !== null
    ? (meta as Record<string, unknown>)[name]
    : undefined;
}

export function primaryColoOf(meta: unknown): Colo | null {
  return servedByPrimary(metaField(meta, "served_by_primary"))
    ? parseColo(metaField(meta, "served_by_colo"))
    : null;
}

// The regions D1 runs a database in, by their location hints
// (https://developers.cloudflare.com/d1/configuration/data-location/), each of
// which is also a Durable Object location hint
// (https://developers.cloudflare.com/durable-objects/reference/data-location/).
// D1 names a result's region by the same code in upper case: `ENAM` on results
// a primary in ORD served, and `WEUR` in the example result on the page linked
// at the top of this file. These and the app's own hint are the only hints a
// creator probes through, so an app can keep a name form for objects it births
// by hand that no creation can produce.
export const D1_REGION_HINTS: readonly string[] = [
  "wnam",
  "enam",
  "weur",
  "eeur",
  "apac",
  "oc",
];

// Where a primary-served result says the primary is.
export interface PrimaryPlacement {
  readonly colo: Colo;
  // The location hint for the region the primary runs in, from the result's
  // documented `served_by_region`, or null when that names no region D1 runs
  // databases in.
  readonly regionHint: string | null;
  // `served_by_region` as the result gave it, for a log line.
  readonly region: string | null;
}

export function primaryPlacementOf(meta: unknown): PrimaryPlacement | null {
  const colo = primaryColoOf(meta);
  if (colo === null) {
    return null;
  }
  const value = metaField(meta, "served_by_region");
  const region = typeof value === "string" ? value : null;
  const hint = region?.toLowerCase() ?? null;
  return {
    colo,
    region,
    regionHint: hint !== null && D1_REGION_HINTS.includes(hint) ? hint : null,
  };
}

// The latest sighting one isolate has made, from the results of its own D1
// work, so learning where the primary is costs no query of its own. The latest
// sighting wins, so a primary that moves is followed by the next result it
// serves. Held in memory per isolate, like the object's own colo.
export class PrimaryObserver {
  #latest: PrimarySighting | null = null;

  // Takes every meta of one call, a batch's included. Any primary-served meta
  // names the primary's colo, whatever the call's other metas say: one batch
  // can report split routing, part primary and part replica.
  //
  // The clock is read only when a sighting is recorded. An app calls this from
  // every D1 result, often inside its own timing code, and most results are a
  // replica's or carry no colo, so a read per call would be a cost, and a
  // perturbation of that code's clock, for nothing.
  note(metas: Iterable<unknown>, now: () => number): void {
    for (const meta of metas) {
      const colo = primaryColoOf(meta);
      if (colo !== null) {
        this.#latest = { colo, atMs: now() };
        return;
      }
    }
  }

  latest(): PrimarySighting | null {
    return this.#latest;
  }
}

// The pass's read of where the app database's primary is. It reads no table,
// and carries no session, so the primary serves it and its meta names it.
const PRIMARY_READ_SQL = "SELECT 1";

// Where the app database's primary is, from the meta of PRIMARY_READ_SQL. A
// failed read costs the pass its sighting, never the pass: it still probes,
// and only the attempts at the primary's gap wait for a later pass.
export async function readPrimary(
  appDb: SqlDatabase,
  fail: (line: string) => void,
): Promise<PrimaryPlacement | null> {
  try {
    const { meta } = await appDb.prepare(PRIMARY_READ_SQL).all();
    return primaryPlacementOf(meta);
  } catch (error) {
    fail(
      `read where the app's primary is: ${error instanceof Error ? error.message : String(error)}`,
    );
    return null;
  }
}
