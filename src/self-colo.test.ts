import { describe, expect, test } from "bun:test";
import type { Colo } from "./colo";
import {
  parseTraceColo,
  readTraceColo,
  readTraceColoWithin,
  SelfColoCache,
  type TraceFetch,
  type TraceReading,
} from "./self-colo";

// A body the endpoint returned on 2026-10-05, with the caller's address
// replaced by a documentation address.
const TRACE_BODY = [
  "fl=731f181",
  "h=cloudflare.com",
  "ip=192.0.2.1",
  "ts=1791238396.000",
  "visit_scheme=https",
  "uag=curl/8.7.1",
  "colo=SEA",
  "sliver=050-tier1",
  "http=http/2",
  "loc=US",
  "tls=TLSv1.3",
  "sni=plaintext",
  "warp=off",
  "gateway=off",
  "rbi=off",
  "kex=X25519",
  "",
].join("\n");

const SEA = "SEA" as Colo;
const ORD = "ORD" as Colo;
const MIA = "MIA" as Colo;

function answering(status: number, body: string): TraceFetch {
  return async () => ({ ok: status === 200, status, text: async () => body });
}

describe("parseTraceColo", () => {
  test("reads the colo line of a real trace body", () => {
    expect(parseTraceColo(TRACE_BODY)).toBe(SEA);
  });

  // `loc=` is the caller's country and sits beside `colo=`; reading the wrong
  // key would place every object in its caller's country code.
  test("a body without a colo line yields no colo", () => {
    expect(parseTraceColo("loc=US\nh=cloudflare.com\n")).toBeNull();
  });

  test("a malformed colo value yields no colo rather than a coerced one", () => {
    expect(parseTraceColo("colo=sea\n")).toBeNull();
    expect(parseTraceColo("colo=\n")).toBeNull();
  });
});

describe("readTraceColo", () => {
  test("a successful read yields the colo", async () => {
    expect(await readTraceColo(answering(200, TRACE_BODY))).toEqual({
      kind: "colo",
      colo: SEA,
    });
  });

  test("an error status is a failed reading, not a throw", async () => {
    const reading = await readTraceColo(answering(503, ""));
    expect(reading.kind).toBe("failed");
  });

  test("a fetch that throws is a failed reading naming the error", async () => {
    const throwing: TraceFetch = async () => {
      throw new Error("network lost");
    };
    expect(await readTraceColo(throwing)).toEqual({
      kind: "failed",
      reason: "trace read: network lost",
    });
  });

  // The timeout is what keeps a stalled trace read from holding up the work the
  // object was called for; the signal has to reach the fetch to do that.
  test("the fetch is given a signal that aborts at the timeout", async () => {
    const hanging: TraceFetch = (_url, init) =>
      new Promise((_resolve, reject) => {
        init.signal.addEventListener("abort", () =>
          reject(new Error("aborted")),
        );
      });
    const reading = await readTraceColoWithin(hanging, 5);
    expect(reading).toEqual({ kind: "failed", reason: "trace read: aborted" });
  });
});

describe("SelfColoCache", () => {
  test("a successful reading is kept for the isolate's life", async () => {
    const cache = new SelfColoCache();
    let reads = 0;
    const read = async (): Promise<TraceReading> => {
      reads += 1;
      return { kind: "colo", colo: ORD };
    };
    await cache.resolve(read);
    const second = await cache.resolve(read);
    expect(second).toEqual({ kind: "colo", colo: ORD });
    expect(reads).toBe(1);
  });

  // A cached failure would leave the isolate unable to observe for its whole
  // life, and so unable to follow the primary.
  test("a failed reading is not kept, so the next call reads again", async () => {
    const cache = new SelfColoCache();
    const readings: TraceReading[] = [
      { kind: "failed", reason: "trace status 503" },
      { kind: "colo", colo: MIA },
    ];
    const read = async (): Promise<TraceReading> => {
      const next = readings.shift();
      if (next === undefined) {
        throw new Error("read more often than the test expects");
      }
      return next;
    };
    expect((await cache.resolve(read)).kind).toBe("failed");
    expect(await cache.resolve(read)).toEqual({
      kind: "colo",
      colo: MIA,
    });
  });
});
