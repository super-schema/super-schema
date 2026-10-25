import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

// The app's default theme is the dark one, and the accessibility scan (tests/e2e/a11y.spec.ts) found its muted text, its primary text on tinted
// surfaces and its PII badge under the 4.5:1 that WCAG 2.1 AA asks of small text. These are the colour pairs that were flagged, measured the way axe
// measures them (WCAG relative luminance), against the tokens as they are in src/app/globals.css: a token that goes back under the line fails here
// before a browser has to find it.

const CSS = readFileSync(path.resolve(__dirname, "../../../src/app/globals.css"), "utf8");

/** The declarations of a block that starts with `selector {`, as `--name: value`. */
function declarations(selector: string): Record<string, string> {
  const start = CSS.indexOf(`${selector} {`);
  if (start < 0) throw new Error(`no ${selector} block in globals.css`);
  const body = CSS.slice(CSS.indexOf("{", start) + 1, CSS.indexOf("}", start));
  return Object.fromEntries([...body.matchAll(/(--?[\w-]+|color)\s*:\s*([^;]+);/g)].map((match) => [match[1], match[2].trim()]));
}

const channel = (value: number) => {
  const c = value / 255;
  return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
};
const rgb = (hex: string): [number, number, number] => {
  const n = parseInt(hex.replace("#", ""), 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
};
const luminance = (hex: string) => {
  const [r, g, b] = rgb(hex);
  return 0.2126 * channel(r) + 0.7152 * channel(g) + 0.0722 * channel(b);
};
/** WCAG contrast ratio of two colours, `#rrggbb` each. */
const contrast = (foreground: string, background: string): number => {
  const [hi, lo] = [luminance(foreground), luminance(background)].sort((a, b) => b - a);
  return (hi + 0.05) / (lo + 0.05);
};
/** `foreground` at `alpha` over `background`, as a hex colour (what a `bg-x/60` is on the surface under it). */
const over = (foreground: string, alpha: number, background: string): string => {
  const mixed = rgb(foreground).map((c, i) => Math.round(alpha * c + (1 - alpha) * rgb(background)[i]));
  return `#${mixed.map((c) => c.toString(16).padStart(2, "0")).join("")}`;
};

const dark = declarations(".dark");
const AA = 4.5;

describe("the helpers", () => {
  it("compute the WCAG ratio (black on white is 21, a colour on itself is 1, the order does not matter)", () => {
    expect(contrast("#000000", "#ffffff")).toBeCloseTo(21, 5);
    expect(contrast("#ffffff", "#000000")).toBeCloseTo(21, 5);
    expect(contrast("#777777", "#777777")).toBeCloseTo(1, 5);
    // The measurement axe made of the old token on --muted: 3.99.
    expect(contrast("#8a8694", "#2a2a36")).toBeCloseTo(3.99, 2);
  });
});

describe("the dark theme's muted text", () => {
  const muted = dark["--muted-foreground"].toLowerCase();
  const surfaces = {
    "--muted (chips, badges, the top bar's search)": dark["--muted"].toLowerCase(),
    "muted/60 over --background (the explorer's tags)": over(dark["--muted"], 0.6, dark["--background"]),
    "--background": dark["--background"].toLowerCase(),
    "--card": dark["--card"].toLowerCase(),
    "the side panel surface measured by axe": "#1a1a24",
  };

  for (const [name, surface] of Object.entries(surfaces)) {
    it(`--muted-foreground on ${name} is at least 4.5:1`, () => {
      expect(contrast(muted, surface), `${muted} on ${surface}`).toBeGreaterThanOrEqual(AA);
    });
  }

  it("is lighter than it was (the old #8a8694 was 3.99:1 on --muted), and still darker than the text proper", () => {
    expect(luminance(muted)).toBeGreaterThan(luminance("#8a8694"));
    expect(luminance(muted)).toBeLessThan(luminance(dark["--foreground"]));
  });
});

describe("the dark theme's primary text (11 px labels, chips)", () => {
  const primary = dark["--primary"].toLowerCase();
  // The backgrounds axe measured under primary text: the explorer's highlighted label and the `bg-primary/10` chip.
  for (const [name, surface] of Object.entries({ "the explorer's highlighted row (#23212d)": "#23212d", "a bg-primary/10 chip (#282332)": "#282332", "--background": dark["--background"], "--card": dark["--card"] })) {
    it(`--primary on ${name} is at least 4.5:1`, () => {
      expect(contrast(primary, surface), `${primary} on ${surface}`).toBeGreaterThanOrEqual(AA);
    });
  }
});

describe("the PII badge", () => {
  it("is at least 4.5:1 on the dark theme's tint (#39242d), where it was 4.08:1", () => {
    const color = declarations(".dark .badge-pii").color.toLowerCase();
    expect(contrast(color, "#39242d"), color).toBeGreaterThanOrEqual(AA);
  });
});

describe("the text that was made faint with an opacity", () => {
  it("is the plain muted token now, in each place the scan flagged (the variants were 1.8:1 to 3.2:1 on the dark surfaces)", () => {
    const flagged: Array<[string, RegExp]> = [
      ["src/app/(dashboard)/schemas/[domainSlug]/components/DomainTypesTab.tsx", /text-caption text-muted-foreground\/60 italic py-4/],
      ["src/app/(dashboard)/schemas/[domainSlug]/[productSlug]/[entityId]/components/InlineEntityMeta.tsx", /text-caption text-muted-foreground\/50 hover/],
      ["src/app/(dashboard)/schemas/[domainSlug]/[productSlug]/[entityId]/components/InlineEntityMeta.tsx", /"text-muted-foreground\/40 italic/],
      ["src/app/(dashboard)/schemas/type-mappings/type-mapping-reference.tsx", /tracking-wider text-muted-foreground\/70/],
      ["src/components/custom/TypeSpecPreview/TypeSpecPreview.tsx", /select-none text-muted-foreground\/40/],
    ];
    for (const [file, pattern] of flagged) {
      expect(readFileSync(path.resolve(__dirname, "../../..", file), "utf8"), file).not.toMatch(pattern);
    }
  });

  it("the secondary badges no longer carry text-caption, which tailwind-merge takes for a colour and uses to drop the badge's own text colour (#e3e1e4 on pink: 1.22:1)", () => {
    for (const file of ["src/components/custom/DomainCard.tsx", "src/app/(dashboard)/schemas/[domainSlug]/product-grid.tsx", "src/features/governance/RetentionPolicyEditor/RetentionPolicyEditor.tsx"]) {
      const source = readFileSync(path.resolve(__dirname, "../../..", file), "utf8");
      expect(source, file).not.toMatch(/<Badge variant="secondary" className="text-caption"/);
    }
  });
});
