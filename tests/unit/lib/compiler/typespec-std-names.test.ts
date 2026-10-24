/**
 * TYPESPEC_STD_TYPE_NAMES is the list the Source tab save refuses a declared model / enum / scalar / union name against (see
 * `compileAndApplyTypeSpecSource`). It is checked against the installed compiler's own `TypeSpec` namespace, in both directions, so a
 * compiler upgrade that adds or removes a built-in scalar is noticed.
 */
import { describe, it, expect } from "vitest";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { compile, NodeHost } from "@typespec/compiler";
import { TYPESPEC_STD_TYPE_NAMES } from "@/lib/compiler/typespec-identifiers";

describe("TYPESPEC_STD_TYPE_NAMES", () => {
  it("is every std scalar of the installed compiler plus the Record and Array models", async () => {
    const dir = await mkdtemp(join(tmpdir(), "std-names-"));
    try {
      const main = join(dir, "main.tsp");
      await writeFile(main, "model M {}\n", "utf8");
      const program = await compile(NodeHost, main, { noEmit: true });
      const std = program.getGlobalNamespaceType().namespaces.get("TypeSpec");
      expect(std).toBeDefined();

      const scalars = [...(std?.scalars.keys() ?? [])];
      expect(scalars.length).toBeGreaterThan(20);
      expect(scalars.filter((name) => !TYPESPEC_STD_TYPE_NAMES.has(name))).toEqual([]);
      const models = [...(std?.models.keys() ?? [])];
      expect(models).toEqual(expect.arrayContaining(["Record", "Array"]));
      expect([...TYPESPEC_STD_TYPE_NAMES].filter((name) => !scalars.includes(name) && name !== "Record" && name !== "Array")).toEqual([]);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  }, 60_000);
});
