// Read-only standby discovery for a single request. The creator's spare table
// supplies the destination. A caller-supplied hint also needs a registered
// base, so a stale hint cannot authorize a retry after its slot is gone.
import type { Colo } from "./colo";
import { integerField, stringField, type SqlDatabase } from "./creator-store";

export interface StandbyLookup {
  readonly classCode: number;
  readonly primaryColo: Colo;
  readonly attemptedName: string;
  // The issuer loads this from its own configuration, independently of the edge.
  readonly configuredServingName: string;
  readonly nowMs: number;
  readonly verifiedMaxAgeMs: number;
  readonly releaseAfterMs: number;
}

export interface VerifiedStandby {
  readonly name: string;
  // Exclusive on receipt and at use. The app applies its own clock-skew margin.
  readonly expiresAtMs: number;
}

const candidate = `s.class_code = ? AND s.colo = ? AND s.name <> ?
  AND s.verified_at_ms > ? AND s.verified_at_ms <= ?
  ORDER BY s.registered_at_ms, s.name LIMIT 1`;

// Registration can change while a request is overdue. A hint and its spare
// must qualify in the same snapshot. A configured base can stay unreachable
// beyond unregistration, so its lookup needs only the spare index.
const fromConfig = `SELECT s.name, s.verified_at_ms AS spare_verified, s.verified_at_ms AS verified
  FROM follow_spare s WHERE ${candidate}`;
const fromHint = `SELECT s.name, s.verified_at_ms AS spare_verified, min(b.verified_at_ms, s.verified_at_ms) AS verified
  FROM follow_slot b JOIN follow_spare s ON b.class_code = s.class_code
  WHERE b.name = ? AND b.verified_at_ms > ? AND b.verified_at_ms <= ?
  AND ${candidate}`;

export async function readVerifiedStandby(
  db: SqlDatabase,
  input: StandbyLookup,
): Promise<VerifiedStandby | null> {
  const { nowMs, verifiedMaxAgeMs, releaseAfterMs, attemptedName } = input;
  if (
    ![nowMs, verifiedMaxAgeMs, releaseAfterMs].every(
      (n) => Number.isSafeInteger(n) && n >= 0,
    )
  ) {
    throw new RangeError("standby lookup requires nonnegative integer times");
  }
  if (!attemptedName || !verifiedMaxAgeMs || !releaseAfterMs) return null;

  const earliest = Math.max(-1, nowMs - verifiedMaxAgeMs);
  // An unregister can commit after this read with an earlier decision time.
  // Its release hold covers the spare's verification, never a later lookup.
  const spareLifetimeMs = Math.min(verifiedMaxAgeMs, releaseAfterMs);
  const slots = [
    input.classCode,
    input.primaryColo,
    attemptedName,
    Math.max(-1, nowMs - spareLifetimeMs),
    nowMs,
  ];
  const statement =
    attemptedName === input.configuredServingName
      ? db.prepare(fromConfig).bind(...slots)
      : db.prepare(fromHint).bind(attemptedName, earliest, nowMs, ...slots);
  const {
    results: [row],
  } = await statement.all();
  if (row === undefined) return null;

  const expiresAtMs = Math.min(
    integerField(row, "verified") + verifiedMaxAgeMs,
    integerField(row, "spare_verified") + releaseAfterMs,
  );
  if (!Number.isSafeInteger(expiresAtMs)) {
    throw new RangeError("standby expiry exceeds the integer time range");
  }
  return { name: stringField(row, "name"), expiresAtMs };
}
