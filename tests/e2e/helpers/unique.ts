/**
 * A name no other run, worker or spec will pick: the prefix, then 8 random base36 characters (36^8, about 2.8e12 values). No clock in
 * it: `Date.now()` repeats within a millisecond and across two machines starting together.
 *
 * It adds no separator, so the prefix says how the name reads: `unique("e2e-domain-")` -> `e2e-domain-k3x9q0ab`, `unique("Order")` ->
 * `Orderk3x9q0ab` (still a TypeSpec identifier). Free of Playwright on purpose: node scripts and unit tests use it too.
 */
import { randomInt } from "node:crypto";

const ALPHABET = "0123456789abcdefghijklmnopqrstuvwxyz";

export function unique(prefix: string): string {
  let suffix = "";
  for (let i = 0; i < 8; i += 1) suffix += ALPHABET[randomInt(ALPHABET.length)];
  return `${prefix}${suffix}`;
}
