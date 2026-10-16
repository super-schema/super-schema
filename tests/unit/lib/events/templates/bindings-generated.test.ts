import fs from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { generateBindingsModule } from "../../../../../scripts/generate-asyncapi-templates";
import { GENERATED_BINDINGS, GENERATED_FROM } from "@/lib/events/templates/bindings.generated";
import { SPECS_ROOT } from "./spec-helpers";

const COMMITTED = fileURLToPath(new URL("../../../../../src/lib/events/templates/bindings.generated.ts", import.meta.url));

describe("bindings.generated.ts", () => {
  it("is up to date: regenerating from node_modules/@asyncapi/specs yields the committed file (run `npm run gen:asyncapi-templates` if this fails)", () => {
    const committed = fs.readFileSync(COMMITTED, "utf8");
    expect(generateBindingsModule(SPECS_ROOT)).toBe(committed);
  });

  it("is deterministic", () => {
    expect(generateBindingsModule(SPECS_ROOT)).toBe(generateBindingsModule(SPECS_ROOT));
  });

  it("records the @asyncapi/specs version it was generated from", () => {
    const { version } = JSON.parse(fs.readFileSync(`${SPECS_ROOT}/package.json`, "utf8")) as { version: string };
    expect(GENERATED_FROM).toBe(`@asyncapi/specs@${version}`);
  });

  it("starts with a do-not-edit banner and imports only types (nothing at runtime depends on the package)", () => {
    const committed = fs.readFileSync(COMMITTED, "utf8");
    expect(committed.split("\n")[0]).toMatch(/AUTO-GENERATED/);
    expect(committed).not.toMatch(/from "@asyncapi/);
    expect(committed).not.toMatch(/require\(/);
    expect(committed).toMatch(/^import type \{[^}]*\} from "\.\/types";$/m);
  });

  it("holds a version and fields for every entry", () => {
    for (const [protocol, targets] of Object.entries(GENERATED_BINDINGS)) {
      for (const [target, binding] of Object.entries(targets)) {
        expect(binding?.version, `${protocol}.${target}`).toMatch(/^\d+\.\d+\.\d+$/);
        expect(binding?.fields.length, `${protocol}.${target}`).toBeGreaterThan(0);
      }
    }
  });
});
