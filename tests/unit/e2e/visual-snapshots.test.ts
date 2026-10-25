import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

// The committed screenshots of tests/e2e/visual.spec.ts. They are made, and compared, only inside the Playwright Docker image (Linux): a
// snapshot with another platform in its name was made on a machine of its own and would fail everywhere else.

const E2E = path.resolve(__dirname, "../../e2e");
const SNAPSHOTS = path.join(E2E, "visual.spec.ts-snapshots");
const spec = readFileSync(path.join(E2E, "visual.spec.ts"), "utf8");

/** The names the spec takes a snapshot under: `expectSnapshot(page, "login")`. */
const namesInSpec = [...spec.matchAll(/expectSnapshot\(page,\s*"([\w-]+)"\)/g)].map((match) => match[1]);

describe("visual.spec.ts and its snapshots", () => {
  it("takes at least the pages the design lists, each under a name of its own", () => {
    for (const name of ["login", "register", "domain-grid", "empty-product", "entity-editor", "admin-settings", "type-mappings", "governance-empty", "not-found-in-shell"]) {
      expect(namesInSpec, name).toContain(name);
    }
    expect(new Set(namesInSpec).size).toBe(namesInSpec.length);
  });

  it("has a snapshot for every name, made for Linux and the visual project, and none that no test uses", () => {
    expect(existsSync(SNAPSHOTS), "tests/e2e/visual.spec.ts-snapshots/ is missing: npm run test:e2e:update-snapshots makes it (docs/testing/e2e.md)").toBe(true);
    const files = readdirSync(SNAPSHOTS).filter((file) => statSync(path.join(SNAPSHOTS, file)).isFile());
    expect(files.sort()).toEqual(namesInSpec.map((name) => `${name}-visual-linux.png`).sort());
  });

  it("every snapshot is a PNG of the fixed viewport, 1280 by 800", () => {
    for (const file of readdirSync(SNAPSHOTS)) {
      const bytes = readFileSync(path.join(SNAPSHOTS, file));
      expect(bytes.subarray(1, 4).toString("ascii"), `${file} is not a PNG`).toBe("PNG");
      expect([bytes.readUInt32BE(16), bytes.readUInt32BE(20)], `${file}: width x height`).toEqual([1280, 800]);
    }
  });

  it("fixes what a screenshot depends on: the viewport, the scale, the locale, the time zone, the colour scheme and the motion", () => {
    for (const setting of ["width: 1280, height: 800", "deviceScaleFactor: 1", 'locale: "en-US"', 'timezoneId: "UTC"', 'colorScheme: "light"', 'reducedMotion: "reduce"']) {
      expect(spec, setting).toContain(setting);
    }
  });
});
