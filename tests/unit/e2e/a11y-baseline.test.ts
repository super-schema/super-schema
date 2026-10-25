import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  BASELINE_PATH, MAX_CONDITIONAL_ENTRIES, MAX_COUNT_VARIES_ENTRIES, assertUpdateAllowed, compareToBaseline, describeComparison, describeElement, elementSignature, entriesOfState, readBaseline, serializeBaseline, signatureOf, targetOf, toEntries,
  writeBaselineState, type AxeFinding, type BaselineEntry, type ElementInfo,
} from "../../e2e/helpers/a11y-baseline";

const finding = (rule: string, target: string, html = "<button>", impact = "serious"): AxeFinding => ({ rule, target, html, impact, help: "help", helpUrl: "https://dequeuniversity.com/rules/axe/4.11/x" });
const entry = (state: string, rule: string, target: string, count = 1): BaselineEntry => ({ state, rule, target, impact: "serious", count });

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
  it("is one entry per (rule, signature) in a fixed order, with the number of elements of that kind and the first one's opening tag as a hint", () => {
    const entries = toEntries("route:/x", [
      finding("link-name", "#base-ui-_R_1_", '<a data-testid="nav-a" id="base-ui-_R_1_">'),
      finding("link-name", "#base-ui-_R_2_", '<a data-testid="nav-b" id="base-ui-_R_2_">'),
      finding("button-name", "li:nth-child(2) > .p-1", '<button class="p-1">x</button>'),
      finding("button-name", "li:nth-child(5) > .p-1", '<button class="p-1">y</button>'),
      finding("button-name", ".p-1", '<button class="p-1">z</button>'),
    ]);
    expect(entries.map((e) => [e.rule, e.target, e.count])).toEqual([
      ["button-name", ".p-1", 3],
      ["link-name", 'a[data-testid="nav-a"]', 1],
      ["link-name", 'a[data-testid="nav-b"]', 1],
    ]);
    expect(entries[0].element).toBe('<button class="p-1">');
  });

  it("gives the same entries for the same page found with different selectors (another page's data around it)", () => {
    const first = toEntries("s", [finding("color-contrast", 'a[href$="playground"] > .justify-end > .text-xs.bg-secondary', '<span class="text-xs bg-secondary">')]);
    const second = toEntries("s", [finding("color-contrast", 'div[data-domain-slug="x"] > .block > .bg-secondary.text-xs', '<span class="bg-secondary text-xs">')]);
    expect(first.map((e) => [e.target, e.count])).toEqual(second.map((e) => [e.target, e.count]));
  });
});

describe("compareToBaseline: per kind of element, with how many", () => {
  const recorded = [entry("s", "color-contrast", ".a", 3), entry("s", "button-name", ".b", 1)];

  it("is empty when the page has what the baseline says: the same kinds, the same number of each", () => {
    expect(compareToBaseline(recorded, [entry("s", "color-contrast", ".a", 3), entry("s", "button-name", ".b", 1)])).toEqual({ added: [], removed: [] });
  });

  it("MORE elements of a recorded kind than recorded fail as new: a fourth unlabeled button next to three known ones is a regression", () => {
    const result = compareToBaseline(recorded, [entry("s", "color-contrast", ".a", 4), entry("s", "button-name", ".b", 1)]);
    expect(result.removed).toEqual([]);
    expect(result.added.map(({ entry: e, extra }) => [e.rule, e.target, extra])).toEqual([["color-contrast", ".a", 1]]);
  });

  it("FEWER elements of a recorded kind fail as a shrink to record: fix one of three and the baseline says two", () => {
    const result = compareToBaseline(recorded, [entry("s", "color-contrast", ".a", 2), entry("s", "button-name", ".b", 1)]);
    expect(result.added).toEqual([]);
    expect(result.removed.map(({ entry: e, fewer }) => [e.rule, e.target, fewer])).toEqual([["color-contrast", ".a", 1]]);
  });

  it("a kind that is not in the baseline is added, with its whole count; one that is gone is removed, with its whole count", () => {
    const result = compareToBaseline(recorded, [entry("s", "color-contrast", ".a", 3), entry("s", "link-name", "#x", 2)]);
    expect(result.added.map(({ entry: e, extra }) => [e.rule, e.target, extra])).toEqual([["link-name", "#x", 2]]);
    expect(result.removed.map(({ entry: e, fewer }) => [e.rule, e.target, fewer])).toEqual([["button-name", ".b", 1]]);
  });

  it("an entry without a count is one element (a file written before the counts)", () => {
    const old = { state: "s", rule: "r", impact: "serious", target: ".o" } as BaselineEntry;
    expect(compareToBaseline([old], [entry("s", "r", ".o", 1)])).toEqual({ added: [], removed: [] });
    expect(compareToBaseline([old], [entry("s", "r", ".o", 2)]).added).toHaveLength(1);
  });

  it("the same selector under another rule is another violation, and so is the same rule under another state", () => {
    expect(compareToBaseline(recorded, [entry("s", "link-name", ".a", 3)]).added).toHaveLength(1);
    expect(compareToBaseline([entry("s", "color-contrast", ".a")], [entry("t", "color-contrast", ".a")]).added).toHaveLength(1);
  });

  it("the message of a difference says how many, and what to do about each side", () => {
    const comparison = compareToBaseline(recorded, [entry("s", "color-contrast", ".a", 5), entry("s", "link-name", "#x")]);
    const text = describeComparison("s", comparison, [finding("link-name", "#x", "<a href='/'>")]);
    expect(text).toContain('NEW accessibility violation(s) in "s"');
    expect(text).toContain("+ link-name (serious) x1  #x");
    expect(text).toContain("+ color-contrast (serious) x2  .a");
    expect(text).toContain("<a href='/'>");
    expect(text).toContain("the baseline only shrinks");
    expect(text).toContain("- button-name (serious) x1  .b");
    expect(text).toContain("UPDATE_A11Y_BASELINE=1");
  });
});

describe("a count that depends on the shared data (countVaries): only its presence is compared", () => {
  const rows = { ...entry("s", "color-contrast", ".row-badge", 7), countVaries: "one per row of a list the shared database fills" };

  it("a different number of a kind that is a row of a global list is neither new nor a shrink, while its absence still is", () => {
    expect(compareToBaseline([rows], [entry("s", "color-contrast", ".row-badge", 25)])).toEqual({ added: [], removed: [] });
    expect(compareToBaseline([rows], [entry("s", "color-contrast", ".row-badge", 1)])).toEqual({ added: [], removed: [] });
    expect(compareToBaseline([rows], []).removed).toHaveLength(1);
  });
});

describe("conditional entries (an element that exists only with data the shared database may not hold)", () => {
  const conditional = { ...entry("s", "color-contrast", ".needs-data"), conditional: "exists only when another spec has made a deployment" };

  it("is not reported as removed when it is absent, and is not new when it is found", () => {
    expect(compareToBaseline([conditional], [])).toEqual({ added: [], removed: [] });
    expect(compareToBaseline([conditional], [entry("s", "color-contrast", ".needs-data")])).toEqual({ added: [], removed: [] });
    expect(compareToBaseline([conditional], [entry("s", "color-contrast", ".other")]).added).toHaveLength(1);
  });

  it("a rewrite keeps a conditional entry the scan did not meet, and the reasons on the entries it found again", () => {
    const dir = mkdtempSync(path.join(tmpdir(), "a11y-baseline-"));
    const file = path.join(dir, "baseline.json");
    const meta = { axe: "4.11.2", tags: ["wcag2a"] };
    const both = { ...entry("s", "link-name", ".both"), conditional: "needs data", countVaries: "rows" };
    writeFileSync(file, serializeBaseline({ readme: "", axe: meta.axe, tags: meta.tags, violations: [conditional, both, entry("s", "button-name", ".gone")] }));
    writeBaselineState("s", [entry("s", "link-name", ".both", 4), entry("s", "button-name", ".new")], meta, file);
    const after = readBaseline(file).violations.map((e) => [e.rule, e.target, e.count, e.conditional ?? null, e.countVaries ?? null]);
    expect(after.sort()).toEqual([
      ["button-name", ".new", 1, null, null],
      ["color-contrast", ".needs-data", 1, "exists only when another spec has made a deployment", null],
      ["link-name", ".both", 4, "needs data", "rows"],
    ]);
  });
});

describe("a baseline is never rewritten on CI", () => {
  it("assertUpdateAllowed refuses UPDATE_A11Y_BASELINE=1 whenever CI is set to anything", () => {
    for (const ci of ["true", "1", "yes", "false"]) {
      expect(() => assertUpdateAllowed({ UPDATE_A11Y_BASELINE: "1", CI: ci }), ci).toThrow(/CI/);
    }
    expect(() => assertUpdateAllowed({ UPDATE_A11Y_BASELINE: "1" })).not.toThrow();
    expect(() => assertUpdateAllowed({ UPDATE_A11Y_BASELINE: "1", CI: "" })).not.toThrow();
    expect(() => assertUpdateAllowed({ CI: "true" })).not.toThrow();
    expect(() => assertUpdateAllowed({ UPDATE_A11Y_BASELINE: "0", CI: "true" })).not.toThrow();
    expect(() => assertUpdateAllowed({})).not.toThrow();
  });
});

describe("the file", () => {
  it("is written in a stable order and read back as it was, replacing only the state that was scanned", () => {
    const dir = mkdtempSync(path.join(tmpdir(), "a11y-baseline-"));
    const file = path.join(dir, "baseline.json");
    const meta = { axe: "4.11.2", tags: ["wcag2a"] };
    writeBaselineState("b", [entry("b", "z-rule", ".z"), entry("b", "a-rule", ".a")], meta, file);
    writeBaselineState("a", [entry("a", "rule", ".r")], meta, file);
    writeBaselineState("b", [entry("b", "a-rule", ".a", 2)], meta, file);
    const read = readBaseline(file);
    expect(read.violations.map((e) => `${e.state}:${e.rule}:${e.count}`).sort()).toEqual(["a:rule:1", "b:a-rule:2"]);
    expect(entriesOfState(read, "b")).toHaveLength(1);
    expect(readFileSync(file, "utf8")).toBe(serializeBaseline(read));
    writeFileSync(file, serializeBaseline({ ...read, violations: [] }));
    expect(readBaseline(file).violations).toEqual([]);
  });

  it("writes the count of every entry, even 1, and the reasons when there are some", () => {
    const text = serializeBaseline({ readme: "r", axe: "4.11.2", tags: [], violations: [{ ...entry("s", "r", ".x"), conditional: "why", countVaries: "because" }] });
    expect(text).toContain('"count":1');
    expect(text).toContain('"conditional":"why"');
    expect(text).toContain('"countVaries":"because"');
  });

  it("the committed baseline is in canonical order, has no entry twice, and every entry names a state, a rule, a target that is its own signature, and a count", () => {
    const baseline = readBaseline(BASELINE_PATH);
    expect(baseline.axe).toMatch(/^\d+\.\d+\.\d+$/);
    expect(baseline.tags).toEqual(["wcag2a", "wcag2aa", "wcag21a", "wcag21aa"]);
    const keys = baseline.violations.map((e) => `${e.state}|${e.rule}|${e.target}`);
    expect(new Set(keys).size).toBe(keys.length);
    for (const e of baseline.violations) {
      expect(e.state.length).toBeGreaterThan(0);
      expect(e.rule).toMatch(/^[a-z0-9-]+$/);
      expect(e.target.length).toBeGreaterThan(0);
      expect(Number.isInteger(e.count) && (e.count as number) >= 1, `${e.state} ${e.rule} ${e.target}: count`).toBe(true);
      expect(signatureOf(e.target), `"${e.target}" is not a signature: it still holds what axe added to make it unique in a page`).toBe(e.target);
      expect(e.target, "a generated id is not a stable target").not.toMatch(/base-ui-|radix-|:r\d|_R_/i);
    }
    expect(readFileSync(BASELINE_PATH, "utf8"), "the file is not in the canonical order: rewrite it with UPDATE_A11Y_BASELINE=1").toBe(serializeBaseline(baseline));
  });

  it("every conditional entry and every entry whose count varies says WHY, in a sentence, and there are not many of them: an exception needs a reason, and a baseline full of exceptions is not a baseline", () => {
    const baseline = readBaseline(BASELINE_PATH);
    const conditional = baseline.violations.filter((e) => e.conditional !== undefined);
    const varies = baseline.violations.filter((e) => e.countVaries !== undefined);
    for (const e of [...conditional.map((c) => ({ ...c, reason: c.conditional })), ...varies.map((c) => ({ ...c, reason: c.countVaries }))]) {
      expect(typeof e.reason, `${e.state} ${e.rule} ${e.target}`).toBe("string");
      expect((e.reason as string).trim().length, `${e.state} ${e.rule} ${e.target}: the reason is too short to be one`).toBeGreaterThanOrEqual(20);
    }
    expect(conditional.length, "conditional entries (absence allowed)").toBeLessThanOrEqual(MAX_CONDITIONAL_ENTRIES);
    expect(varies.length, "entries whose count is not compared").toBeLessThanOrEqual(MAX_COUNT_VARIES_ENTRIES);
  });
});
