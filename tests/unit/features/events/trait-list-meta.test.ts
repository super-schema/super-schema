import { describe, expect, it } from "vitest";
import { BUNDLED_TRAITS } from "@/lib/events/bundled-traits";
import { traitListMeta } from "@/features/events/workspace/trait-list-meta";

describe("traitListMeta: what the Message properties list shows about a library set", () => {
  it("marks a built-in set and counts its properties", () => {
    const ce = BUNDLED_TRAITS.find((t) => t.name === "CloudEvents")!;
    expect(traitListMeta(ce.spec)).toEqual({ bundled: true, propertyCount: 8 });
    const tc = BUNDLED_TRAITS.find((t) => t.name === "TraceContext")!;
    expect(traitListMeta(tc.spec)).toEqual({ bundled: true, propertyCount: 2 });
  });

  it("counts the inline properties of an ordinary set and never marks it built in", () => {
    expect(traitListMeta({ headers: { type: "object", properties: { a: {}, b: {}, c: {} } } })).toEqual({ bundled: false, propertyCount: 3 });
  });

  it("is 0 properties and not built in for an operation set, an empty spec and anything that is not a spec", () => {
    expect(traitListMeta({ title: "Retry" })).toEqual({ bundled: false, propertyCount: 0 });
    expect(traitListMeta({})).toEqual({ bundled: false, propertyCount: 0 });
    expect(traitListMeta(null)).toEqual({ bundled: false, propertyCount: 0 });
    expect(traitListMeta("nope")).toEqual({ bundled: false, propertyCount: 0 });
  });

  it("does not trust an empty marker", () => {
    expect(traitListMeta({ "x-bundled": "" }).bundled).toBe(false);
  });
});
