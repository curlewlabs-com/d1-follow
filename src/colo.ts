// A Cloudflare colo: the code of the data center a Worker, a Durable Object or
// a D1 database runs in. Every colo this package sees arrives as untyped text,
// from /cdn-cgi/trace or from a D1 result's metadata, so the type is branded: a
// value reaches a decision only after parseColo has accepted it.
export type Colo = string & { readonly __brand: "Colo" };

// Cloudflare names each colo by a three-letter airport code in upper case. A
// value of any other shape is no reading rather than something to coerce, so a
// malformed field leaves the object serving where it is.
const COLO_PATTERN = /^[A-Z]{3}$/;

export function parseColo(value: unknown): Colo | null {
  return typeof value === "string" && COLO_PATTERN.test(value)
    ? (value as Colo)
    : null;
}
