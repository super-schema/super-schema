import { describe, it, expect } from "vitest";
import fs from "fs";
import path from "path";

const globalsCss = fs.readFileSync(
  path.resolve(__dirname, "../../../src/app/globals.css"),
  "utf-8"
);

describe("Font-scale CSS integration", () => {
  it("html rule includes font-size with --font-scale variable", () => {
    expect(globalsCss).toContain(
      "font-size: calc(16px * var(--font-scale, 1))"
    );
  });
});
