// An object's own colo, read from the edge's /cdn-cgi/trace and cached for the
// life of one isolate.
//
// No runtime API tells a Worker or a Durable Object which colo it runs in: a
// request's `cf.colo` is the caller's colo, and RPC and scheduled calls carry
// no request at all. The trace endpoint is answered by the edge nearest its
// caller, which is the colo the calling isolate runs in.
//
// The cache's scope is the correctness argument. An isolate cannot change colo:
// when Cloudflare moves an object, the old isolate ends and a new one starts in
// the new colo. A cache that dies with its isolate therefore never reports a
// colo its holder has left, while one that outlives it, such as durable
// storage, pins a reading that a move silently falsifies. So the caller keeps
// one SelfColoCache per isolate, in memory, and nothing here persists a colo.
import { parseColo, type Colo } from "./colo";

// A host other than any Worker's own zone, so the read cannot loop back into
// the Worker making it.
export const TRACE_URL = "https://cloudflare.com/cdn-cgi/trace";

// Bounds the one read per isolate that goes to the network. A read in the
// isolate's own colo answers in tens of milliseconds; a slower one fails, is
// not cached, and is tried again on the next call.
export const TRACE_TIMEOUT_MS = 2000;

export type TraceReading =
  | { readonly kind: "colo"; readonly colo: Colo }
  | { readonly kind: "failed"; readonly reason: string };

export interface TraceResponse {
  readonly ok: boolean;
  readonly status: number;
  text(): Promise<string>;
}

// The runtime's own fetch satisfies this shape; tests supply their own.
export type TraceFetch = (
  url: string,
  init: { signal: AbortSignal },
) => Promise<TraceResponse>;

// The body is newline-separated `key=value` lines, one of them `colo=`.
export function parseTraceColo(body: string): Colo | null {
  for (const line of body.split("\n")) {
    if (line.startsWith("colo=")) {
      return parseColo(line.slice("colo=".length).trim());
    }
  }
  return null;
}

// Never throws: a failed read is a reading of its own, so the caller can log it
// in its own convention and the object serves where it is.
export async function readTraceColo(
  fetchTrace: TraceFetch,
  timeoutMs: number = TRACE_TIMEOUT_MS,
): Promise<TraceReading> {
  let body: string;
  try {
    const response = await fetchTrace(TRACE_URL, {
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (!response.ok) {
      return { kind: "failed", reason: `trace status ${response.status}` };
    }
    body = await response.text();
  } catch (error) {
    return {
      kind: "failed",
      reason: `trace read: ${error instanceof Error ? error.message : String(error)}`,
    };
  }
  const colo = parseTraceColo(body);
  return colo === null
    ? { kind: "failed", reason: "trace body has no well-formed colo line" }
    : { kind: "colo", colo };
}

// Caches a successful reading only, so a transient failure is retried on the
// next call instead of leaving the isolate without a colo for its whole life.
export class SelfColoCache {
  #colo: Colo | null = null;

  async resolve(read: () => Promise<TraceReading>): Promise<TraceReading> {
    if (this.#colo !== null) {
      return { kind: "colo", colo: this.#colo };
    }
    const reading = await read();
    if (reading.kind === "colo") {
      this.#colo = reading.colo;
    }
    return reading;
  }
}
