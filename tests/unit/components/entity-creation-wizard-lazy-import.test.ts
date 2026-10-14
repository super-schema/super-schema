import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, it, expect } from "vitest";

/**
 * The importers (protobufjs, yaml) must stay out of the wizard's initial client
 * chunk: EntityCreationWizard loads them with a dynamic import when the user
 * actually imports a schema.
 */
const WIZARD = readFileSync(
  path.resolve(process.cwd(), "src/components/custom/EntityCreationWizard/EntityCreationWizard.tsx"),
  "utf8"
);

const staticImports = WIZARD.split("\n").filter((line) => /^import\s(?!type\b)/.test(line));

describe("EntityCreationWizard lazy-loads the importers", () => {
  it("has no static import of the import service, the detector or a format importer", () => {
    for (const line of staticImports) {
      expect(line).not.toMatch(/@\/services\/import\.service|format-detector|\.importer"|protobufjs/);
    }
  });

  it("loads them on demand", () => {
    expect(WIZARD).toContain('import("@/services/import.service")');
    expect(WIZARD).toContain('import("@/lib/importers/format-detector")');
  });
});
