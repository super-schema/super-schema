// tests/unit/lib/events/document/parse-objects-strings.test.ts
// The `strings(true)` reader (server variable enums) de-duplicates with a Set: same result as the list scan it replaced, linear time.
import { describe, expect, it } from "vitest";
import { createObjectReaders } from "@/lib/events/document/parse-objects";

function readVariables(variables: unknown) {
  const problems: Array<{ pointer: string; message: string }> = [];
  const ax = createObjectReaders((pointer, message) => problems.push({ pointer, message }));
  const read = ax.variables(variables, "/servers/0/variables");
  return { read, problems };
}

describe("server variable enum (strings(true))", () => {
  it("keeps the first of each value in order and reports each repeat at its own index", () => {
    const { read, problems } = readVariables({ v: { enum: ["a", "b", "a", " a ", "c", "b"], default: "a" } });
    expect(read).toEqual({ v: { enum: ["a", "b", "c"], default: "a" } });
    expect(problems).toEqual([
      { pointer: "/servers/0/variables/v/enum/2", message: 'Duplicate value "a" in enum' },
      { pointer: "/servers/0/variables/v/enum/3", message: 'Duplicate value "a" in enum' },
      { pointer: "/servers/0/variables/v/enum/5", message: 'Duplicate value "b" in enum' },
    ]);
  });

  it("still reports entries that are not non-empty strings, and does not count them as values", () => {
    const { read, problems } = readVariables({ v: { enum: ["a", "", 3, "  ", "a"] } });
    expect(read).toEqual({ v: { enum: ["a"] } });
    expect(problems.map((p) => p.pointer)).toEqual(["/servers/0/variables/v/enum/1", "/servers/0/variables/v/enum/2", "/servers/0/variables/v/enum/3", "/servers/0/variables/v/enum/4"]);
  });

  it("examples (strings without the unique check) keep repeats", () => {
    const { read, problems } = readVariables({ v: { examples: ["a", "a"] } });
    expect(read).toEqual({ v: { examples: ["a", "a"] } });
    expect(problems).toEqual([]);
  });

  it("an enum of 115,000 different strings is read in well under a second (the list scan took 11 s)", () => {
    const enumeration = Array.from({ length: 115_000 }, (_, i) => `e${i}`);
    const started = performance.now();
    const { read, problems } = readVariables({ v: { enum: enumeration } });
    expect(performance.now() - started).toBeLessThan(1000);
    expect((read?.v.enum ?? []).length).toBe(115_000);
    expect(problems).toEqual([]);
  });

  it("and one of 100,000 repeats of a single string reports 99,999 repeats just as fast", () => {
    const started = performance.now();
    const { read, problems } = readVariables({ v: { enum: Array.from({ length: 100_000 }, () => "same") } });
    expect(performance.now() - started).toBeLessThan(1000);
    expect(read?.v.enum).toEqual(["same"]);
    expect(problems).toHaveLength(99_999);
  });
});
