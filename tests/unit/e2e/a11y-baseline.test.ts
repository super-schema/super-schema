import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  BASELINE_PATH, compareToBaseline, describeComparison, describeElement, elementSignature, entriesOfState, readBaseline, serializeBaseline, signatureOf, targetOf, toEntries,
  writeBaselineState, type AxeFinding, type BaselineEntry, type ElementInfo,
} from "../../e2e/helpers/a11y-baseline";

const finding = (rule: string, target: string, html = "<button>", impact = "serious"): AxeFinding => ({ rule, target, html, impact, help: "help", helpUrl: "https://dequeuniversity.com/rules/axe/4.11/x" });
const entry = (state: string, rule: string, target: string): BaselineEntry => ({ state, rule, target, impact: "serious" });

describe("signatureOf: the kind of element, not where axe found it in one page", () => {
  it("keeps the element's own compound selector and drops the ancestors axe added to make it unique", () => {
    expect(signatureOf(".text-xs.bg-secondary > .justify-end > span.badge")).toBe("span.badge");
    expect(signatureOf('a[href$="playground"] > .justify-end.mb-space-3 > .text-xs')).toBe(".text-xs");
    expect(signatureOf("div > ul > li:nth-child(7)")).toBe("li:nth-child(*)");
  });

  it("is the same whatever order axe wrote the classes in (it differs from one page to the next)", () => {
    expect(signatureOf(".flex-1.text-body-small.text-muted-foreground")).toBe(signatureOf(".text-body-small.flex-1.text-muted-foreground"));
    expect(signatureOf(".text-body-small.flex-1.text-muted-foreground")).toBe(".flex-1.text-body-small.text-muted-foreground");
  });

  it("keeps the value of the attributes that say what the element is, and drops the others (a slug, an id, a field name)", () => {
    expect(signatureOf('div[data-testid="compliance-results-table"] > .overflow-auto.flex-1')).toBe(".flex-1.overflow-auto");
    expect(signatureOf('button[data-testid="nav-glossary"]')).toBe('button[data-testid="nav-glossary"]');
    expect(signatureOf('div[data-domain-slug="e2e-ws-dom-abc"]')).toBe("div[data-domain-slug=*]");
    expect(signatureOf('div[data-field="email"]')).toBe("div[data-field=*]");
    expect(signatureOf('a[href="/schemas/x"]')).toBe("a[href=*]");
    expect(signatureOf('button[title="Search (Ctrl+K)"] > .flex-1.text-body-small')).toBe(".flex-1.text-body-small");
    expect(signatureOf('input[type="text"][name="email"]')).toBe('input[name="email"][type="text"]');
  });

  it("stars generated ids and sibling positions, and keeps a stable id", () => {
    expect(signatureOf("#base-ui-_R_69ebrb_")).toBe("#*");
    expect(signatureOf("#radix-_r_3_ > button")).toBe("button");
    expect(signatureOf("div#radix-_r_3_")).toBe("div#*");
    expect(signatureOf('[id=":r1a:"]')).toBe("[id=*]");
    expect(signatureOf("#field-editor-dnd")).toBe("#field-editor-dnd");
    expect(signatureOf("tr:nth-of-type(12)")).toBe("tr:nth-of-type(*)");
    expect(signatureOf("li:not(.x):nth-child(2)")).toBe("li:not(.x):nth-child(*)");
  });

  it("reads escaped class names (Tailwind's `hover:bg-accent`) and quoted values with spaces or `>` in them whole", () => {
    expect(signatureOf(".p-1.hover\\:bg-accent")).toBe(".hover\\:bg-accent.p-1");
    expect(signatureOf('main > button[aria-label="Go > there now"]')).toBe('button[aria-label="Go > there now"]');
    expect(signatureOf(".bg-secondary.\\[a\\]\\:hover\\:bg-secondary\\/80[data-variant=\"secondary\"]")).toBe('.\\[a\\]\\:hover\\:bg-secondary\\/80.bg-secondary[data-variant="secondary"]');
  });

  it("keeps each piece of a shadow DOM path, reduced the same way", () => {
    expect(signatureOf("my-app > my-widget >> div > .b.a")).toBe("my-widget >> .a.b");
  });
});

describe("elementSignature: the element's own markup, whatever else is on the page", () => {
  const span = { tag: "span", id: "", classes: ["text-body-small", "text-muted-foreground", "flex-1"], attributes: { class: "x", style: "y" } };

  it("is the tag, the classes in sorted order and the attributes that say what kind of element it is", () => {
    expect(elementSignature(span)).toBe("span.flex-1.text-body-small.text-muted-foreground");
    expect(elementSignature({ tag: "span", id: "", classes: ["badge", "bg-secondary"], attributes: { "data-slot": "badge", "data-variant": "secondary", role: "status", href: "/x", "aria-label": "Collapse e2e-ws-dom-abc" } })).toBe(
      'span.badge.bg-secondary[data-slot="badge"][data-variant="secondary"][role="status"]',
    );
  });

  it("escapes class names like a selector (Tailwind's brackets, colons and slashes) and sorts the escaped names", () => {
    expect(elementSignature({ tag: "div", id: "", classes: ["text-[10px]", "text-muted-foreground/70"], attributes: {} })).toBe("div.text-\\[10px\\].text-muted-foreground\\/70");
  });

  it("keeps a stable id and drops a generated one", () => {
    expect(elementSignature({ tag: "div", id: "field-editor-dnd", classes: [], attributes: {} })).toBe("div#field-editor-dnd");
    expect(elementSignature({ tag: "a", id: "base-ui-_R_69ebrb_", classes: ["w-10"], attributes: { "data-testid": "nav-glossary" } })).toBe('a.w-10[data-testid="nav-glossary"]');
  });

  it("is its own signature when read back as a selector (the baseline file keeps it as it is)", () => {
    const elements: ElementInfo[] = [span, { tag: "div", id: "", classes: ["text-[10px]", "a/b"], attributes: { role: "region" } }, { tag: "button", id: "x", classes: ["p-1", "hover:bg-accent"], attributes: { type: "button" } }];
    for (const element of elements) {
      expect(signatureOf(elementSignature(element))).toBe(elementSignature(element));
    }
  });

  it("is what targetOf uses when the page gave the element, whatever selector axe wrote for it", () => {
    const a = targetOf({ target: ".flex-1.text-body-small", html: "<span>", element: span });
    const b = targetOf({ target: "button[title=x] > .flex-1.text-body-small.text-muted-foreground", html: "<span>", element: span });
    expect(a).toBe(b);
    expect(a).toBe("span.flex-1.text-body-small.text-muted-foreground");
  });
});

describe("targetOf", () => {
  it("names an element whose only selector is a generated id by its tag and test id, role or slot", () => {
    expect(targetOf({ target: "#base-ui-_R_69ebrb_", html: '<a data-testid="nav-glossary" class="x" id="base-ui-_R_69ebrb_">' })).toBe('a[data-testid="nav-glossary"]');
    expect(targetOf({ target: "#base-ui-_R_5pb_", html: '<button type="button" id="base-ui-_R_5pb_" role="combobox" data-slot="select-trigger">' })).toBe('button[role="combobox"]');
    expect(targetOf({ target: "#base-ui-_R_5pb_", html: '<div id="base-ui-_R_5pb_">' })).toBe("div");
    expect(targetOf({ target: ".p-1", html: "<button>" })).toBe(".p-1");
  });
});

describe("describeElement", () => {
  it("is the opening tag, shortened, with generated ids starred and the fixture's names replaced", () => {
    expect(describeElement('<a href="/schemas/e2e-dom-1" id="base-ui-_R_1_" class="x">link</a>', { "e2e-dom-1": "<domain>" })).toBe('<a href="/schemas/<domain>" id="*" class="x">');
    expect(describeElement("<span ".padEnd(400, "x")).length).toBeLessThanOrEqual(160);
  });
});

describe("toEntries", () => {
  it("is one entry per (rule, signature) in a fixed order, with the first element's opening tag as a hint", () => {
    const entries = toEntries("route:/x", [
      finding("link-name", "#base-ui-_R_1_", '<a data-testid="nav-a" id="base-ui-_R_1_">'),
      finding("link-name", "#base-ui-_R_2_", '<a data-testid="nav-b" id="base-ui-_R_2_">'),
      finding("button-name", "li:nth-child(2) > .p-1", '<button class="p-1">x</button>'),
      finding("button-name", "li:nth-child(5) > .p-1", '<button class="p-1">y</button>'),
      finding("button-name", ".p-1", '<button class="p-1">z</button>'),
    ]);
    expect(entries.map((e) => [e.rule, e.target])).toEqual([
      ["button-name", ".p-1"],
      ["link-name", 'a[data-testid="nav-a"]'],
      ["link-name", 'a[data-testid="nav-b"]'],
    ]);
    expect(entries[0].element).toBe('<button class="p-1">');
  });

  it("gives the same entries for the same page found with different selectors (another page's data around it)", () => {
    const first = toEntries("s", [finding("color-contrast", 'a[href$="playground"] > .justify-end > .text-xs.bg-secondary', '<span class="text-xs bg-secondary">')]);
    const second = toEntries("s", [finding("color-contrast", 'div[data-domain-slug="x"] > .block > .bg-secondary.text-xs', '<span class="bg-secondary text-xs">')]);
    expect(first.map((e) => e.target)).toEqual(second.map((e) => e.target));
  });
});

describe("compareToBaseline", () => {
  const recorded = [entry("s", "color-contrast", ".a"), entry("s", "button-name", ".b")];

  it("is empty when the page has what the baseline says", () => {
    expect(compareToBaseline(recorded, [entry("s", "color-contrast", ".a"), entry("s", "button-name", ".b")])).toEqual({ added: [], removed: [] });
  });

  it("a violation that is not in the baseline is added", () => {
    const result = compareToBaseline(recorded, [entry("s", "color-contrast", ".a"), entry("s", "button-name", ".b"), entry("s", "link-name", "#x")]);
    expect(result.removed).toEqual([]);
    expect(result.added.map((e) => [e.rule, e.target])).toEqual([["link-name", "#x"]]);
  });

  it("the same selector under another rule is another violation, and so is the same rule under another state", () => {
    expect(compareToBaseline(recorded, [entry("s", "link-name", ".a")]).added).toHaveLength(1);
    expect(compareToBaseline([entry("s", "color-contrast", ".a")], [entry("t", "color-contrast", ".a")]).added).toHaveLength(1);
  });

  it("an entry that no longer occurs is removed: the baseline only shrinks", () => {
    const result = compareToBaseline(recorded, [entry("s", "button-name", ".b")]);
    expect(result.added).toEqual([]);
    expect(result.removed.map((e) => [e.rule, e.target])).toEqual([["color-contrast", ".a"]]);
  });

  it("the message of a difference says what to do about each side", () => {
    const comparison = compareToBaseline(recorded, [entry("s", "button-name", ".b"), entry("s", "link-name", "#x")]);
    const text = describeComparison("s", comparison, [finding("link-name", "#x", "<a href='/'>")]);
    expect(text).toContain('NEW accessibility violation(s) in "s"');
    expect(text).toContain("+ link-name (serious)  #x");
    expect(text).toContain("<a href='/'>");
    expect(text).toContain("the baseline only shrinks");
    expect(text).toContain("- color-contrast (serious)  .a");
    expect(text).toContain("UPDATE_A11Y_BASELINE=1");
  });
});

describe("the file", () => {
  it("is written in a stable order and read back as it was, replacing only the state that was scanned", () => {
    const dir = mkdtempSync(path.join(tmpdir(), "a11y-baseline-"));
    const file = path.join(dir, "baseline.json");
    const meta = { axe: "4.11.2", tags: ["wcag2a"] };
    writeBaselineState("b", [entry("b", "z-rule", ".z"), entry("b", "a-rule", ".a")], meta, file);
    writeBaselineState("a", [entry("a", "rule", ".r")], meta, file);
    writeBaselineState("b", [entry("b", "a-rule", ".a")], meta, file);
    const read = readBaseline(file);
    expect(read.violations.map((e) => `${e.state}:${e.rule}`).sort()).toEqual(["a:rule", "b:a-rule"]);
    expect(entriesOfState(read, "b")).toHaveLength(1);
    expect(readFileSync(file, "utf8")).toBe(serializeBaseline(read));
    writeFileSync(file, serializeBaseline({ ...read, violations: [] }));
    expect(readBaseline(file).violations).toEqual([]);
  });

  it("the committed baseline is in canonical order, has no entry twice, and every entry names a state, a rule and a target that is its own signature", () => {
    const baseline = readBaseline(BASELINE_PATH);
    expect(baseline.axe).toMatch(/^\d+\.\d+\.\d+$/);
    expect(baseline.tags).toEqual(["wcag2a", "wcag2aa", "wcag21a", "wcag21aa"]);
    const keys = baseline.violations.map((e) => `${e.state}|${e.rule}|${e.target}`);
    expect(new Set(keys).size).toBe(keys.length);
    for (const e of baseline.violations) {
      expect(e.state.length).toBeGreaterThan(0);
      expect(e.rule).toMatch(/^[a-z0-9-]+$/);
      expect(e.target.length).toBeGreaterThan(0);
      expect(signatureOf(e.target), `"${e.target}" is not a signature: it still holds what axe added to make it unique in a page`).toBe(e.target);
      expect(e.target, "a generated id is not a stable target").not.toMatch(/base-ui-|radix-|:r\d|_R_/i);
    }
    expect(readFileSync(BASELINE_PATH, "utf8"), "the file is not in the canonical order: rewrite it with UPDATE_A11Y_BASELINE=1").toBe(serializeBaseline(baseline));
  });
});
