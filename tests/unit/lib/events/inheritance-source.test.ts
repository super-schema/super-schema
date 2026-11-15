import { expect, it } from "vitest";
import { flattenModelInheritance, withModelBase } from "@/lib/events/inheritance-source";

it("adds or replaces a base without rewriting the author's fields and documentation", () => {
  const source = '/** model Fake { } */\nmodel Child { @doc("keep this") suffix: string; }';
  expect(withModelBase(source, "Child", "Base")).toBe(source.replace("model Child {", "model Child extends Base {"));
  expect(withModelBase("model Child extends Old { suffix: string; }", "Child", "Base")).toBe("model Child extends Base { suffix: string; }");
});
it("flattens transitive inheritance only in the emitted projection, with the nearest field winning", () => {
  const source = 'model Base { /** keep */ given: string; same: string; }\nmodel Mid extends Base { middle: string; }\nmodel Child extends Mid { suffix: string; same: int32; }';
  const result = flattenModelInheritance(source);
  const child = result.slice(result.indexOf("model Child"));
  expect(child).toContain("/** keep */ given: string;");
  expect(child).toContain("middle: string;");
  expect(child).toContain("suffix: string;");
  expect(child).toContain("same: int32;");
  expect(child).not.toContain("same: string");
  expect(result).not.toContain("extends");
  expect(source).toContain("extends Base");
});
it("does not interpret model-looking text inside a literal or comment", () => {
  const source = '@doc("model Pretend extends Nothing {}")\nmodel Base { a: string; }\nmodel Child extends Base { b: string; }';
  expect(flattenModelInheritance(source)).toContain('@doc("model Pretend extends Nothing {}")');
});
it("fails closed for a missing pinned base or an inheritance cycle", () => {
  expect(() => flattenModelInheritance("model Child extends Missing {}")).toThrow(/missing/);
  expect(() => flattenModelInheritance("model A extends B {}\nmodel B extends A {}")).toThrow(/cycle/);
});
