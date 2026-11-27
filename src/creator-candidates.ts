// What the pass learns about where Cloudflare places objects (the tables
// candidate-store.ts reads and writes): the candidate colos it judges each
// class's gaps over, which grow when a slot is registered somewhere new or a
// creation lands there, and the region hints it probes through, which grow when
// the app's primary is seen in a region none of them names.
import {
  addCandidateColo,
  addRegionHint,
  readCandidateColos,
  readRegionHints,
} from "./candidate-store";
import type { Colo } from "./colo";
import type { SqlDatabase } from "./creator-store";
import { LeaseLost } from "./pass-lease";
import type { PrimaryPlacement } from "./primary-colo";

// The candidate colos as the pass knows them: read once, and added to as the
// pass learns, so a colo learned in one pass is the next pass's to read. Each
// add is written for `holder`, the pass lease's holder, and deletes every
// hint's wait (candidate-store.ts).
export class PassCandidates {
  // Whether this pass added a colo, after which it writes no hint's wait.
  private added = false;

  private constructor(
    private readonly db: SqlDatabase,
    private readonly holder: string,
    private readonly colos: Colo[],
  ) {}

  // The stored candidates, with every colo a slot is registered in: a slot is
  // an object that landed there, so its colo joins the first time a pass reads
  // it, and stays a candidate after the slot leaves, its gap reported. Adding
  // one ends every hint's wait, which dry-run must not do, so a pass in which
  // no class acts (`acts` false) adds the colo and leaves every wait as it
  // was. While a wait stands (`waitsStand`) it reports that through `fail`,
  // since the waits then do not know of the colo; with none, as on a fresh
  // creator's first passes, the add is an ordinary one.
  static async load(
    db: SqlDatabase,
    holder: string,
    registered: Iterable<Colo>,
    pass: {
      readonly atMs: number;
      readonly acts: boolean;
      readonly waitsStand: boolean;
      readonly log: (line: string) => void;
      readonly fail: (line: string) => void;
    },
  ): Promise<PassCandidates> {
    const { atMs, log } = pass;
    const candidates = new PassCandidates(
      db,
      holder,
      await readCandidateColos(db),
    );
    for (const colo of new Set(registered)) {
      if (!pass.acts) {
        if (!(await candidates.record(colo, atMs, false))) continue;
        if (pass.waitsStand) {
          pass.fail(
            `dry-run - candidate colo ${colo} added, where a slot is registered, and every hint's wait left as it was: dry-run writes no pacing state`,
          );
        } else {
          log(
            `[follow] candidate colo ${colo} added - a slot is registered there`,
          );
        }
        continue;
      }
      if (await candidates.add(colo, atMs)) {
        log(
          `[follow] candidate colo ${colo} added - a slot is registered there`,
        );
      }
    }
    return candidates;
  }

  has(colo: Colo): boolean {
    return this.colos.includes(colo);
  }

  // A creation that lands where no creation or slot has been is how the
  // creator learns Cloudflare places objects there. True when `colo` joined;
  // throws LeaseLost, having written nothing, when the pass lost its lease.
  // The add counts as made once its batch is sent: a batch that committed
  // and lost its answer has deleted every wait, which this pass must then
  // not write again.
  async add(colo: Colo | null, atMs: number): Promise<boolean> {
    return await this.record(colo, atMs, true);
  }

  // Adds `colo`, ending every hint's wait only with `endWaits`; true when it
  // joined.
  private async record(
    colo: Colo | null,
    atMs: number,
    endWaits: boolean,
  ): Promise<boolean> {
    if (colo === null || this.colos.includes(colo)) {
      return false;
    }
    if (endWaits) this.added = true;
    if (!(await addCandidateColo(this.db, colo, atMs, this.holder, endWaits))) {
      throw new LeaseLost();
    }
    this.colos.push(colo);
    return true;
  }

  // True once this pass has sent a colo's add, which deletes every hint's
  // wait.
  get addedAny(): boolean {
    return this.added;
  }

  // The colos the pass judges its gaps over: every candidate, and the
  // primary's colo while it is no candidate, so its gap is reported until a
  // creation lands there.
  judged(primary: PrimaryPlacement | null): Colo[] {
    return primary === null || this.colos.includes(primary.colo)
      ? [...this.colos]
      : [...this.colos, primary.colo];
  }
}

// The region hints this pass probes through: the app's own, then each added
// since, in order. A primary seen in a region none of them names adds that
// region's hint, which stays, since the primary may return there; the colos
// its probes land in become candidates as the app's hint's did.
export async function syncRegionHints(pass: {
  readonly db: SqlDatabase;
  // The app's own hint, which the pass always probes through.
  readonly appHint: string;
  readonly primary: PrimaryPlacement | null;
  readonly atMs: number;
  readonly log: (line: string) => void;
  readonly report: { regionHints: string[]; regionHintsAdded: string[] };
}): Promise<string[]> {
  const { db, primary, log, report } = pass;
  const hints = [pass.appHint];
  for (const hint of await readRegionHints(db)) {
    if (!hints.includes(hint)) hints.push(hint);
  }
  const hint = primary?.regionHint ?? null;
  if (primary !== null && hint === null) {
    log(
      `[follow] the app's primary in ${primary.colo} reports region ${JSON.stringify(primary.region)}, which names no region hint`,
    );
  } else if (primary !== null && hint !== null && !hints.includes(hint)) {
    await addRegionHint(db, hint, pass.atMs);
    hints.push(hint);
    report.regionHintsAdded.push(hint);
    log(
      `[follow] region hint ${hint} added - the app's primary was seen in ${primary.colo}`,
    );
  }
  report.regionHints.push(...hints);
  return hints;
}
