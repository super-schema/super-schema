/**
 * `unique(prefix)` names what a spec creates (domains, products, entities) so two runs, two workers or two specs never collide:
 * the prefix, then 8 random base36 characters (36^8 values: no clock in it, so two calls in the same millisecond differ).
 */
import { describe, expect, it } from "vitest";
import { unique } from "../../e2e/helpers/unique";

describe("unique", () => {
  it("is the prefix followed by 8 lowercase base36 characters", () => {
    expect(unique("e2e-domain-")).toMatch(/^e2e-domain-[0-9a-z]{8}$/);
    expect(unique("")).toMatch(/^[0-9a-z]{8}$/);
  });

  it("adds no separator of its own", () => {
    expect(unique("Ent")).toMatch(/^Ent[0-9a-z]{8}$/);
  });

  it("does not repeat, not even in a tight loop", () => {
    const seen = new Set(Array.from({ length: 5000 }, () => unique("x-")));
    expect(seen.size).toBe(5000);
  });

  it("is usable as a TypeSpec identifier and as a slug once its prefix is", () => {
    expect(unique("Order")).toMatch(/^[A-Za-z][A-Za-z0-9]*$/);
    expect(unique("e2e-p-").toLowerCase()).toMatch(/^[a-z0-9-]+$/);
  });
});
