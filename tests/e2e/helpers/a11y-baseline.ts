/**
 * The accessibility baseline (tests/e2e/a11y-baseline.json): the violations the product is known to have, per state of the app (a route, a
 * dialog), which a11y.spec.ts compares every scan to. A violation that is not in it fails the test (a regression, or something nobody has
 * looked at); an entry that no longer occurs fails it too, with "remove this entry", so the file can only shrink. Free of Playwright and of
 * axe-core, so a unit test (tests/unit/e2e/a11y-baseline.test.ts) covers the comparison and the normalization. How it is used, and how to
 * shrink it: docs/testing/a11y.md.
 *
 * A violation is identified by (state, rule id, element signature): the same KIND of element failing the same rule in the same state. The
 * signature is the element's own selector, made independent of the page around it (`signatureOf`): axe's selector is the shortest one that is
 * unique in THIS page, so it names ancestors, list positions, a domain's slug or a different class order whenever the data of the shared test
 * database differs, and a baseline keyed by it would fail on a run that changed nothing. Two elements of one kind in one state (every
 * domain card's badge) are one entry: the entry says "this kind of element fails here"; fixing one of them does not remove it, fixing all does.
 */
import { readFileSync, renameSync, writeFileSync } from "node:fs";
import path from "node:path";

export interface AxeFinding {
  rule: string;
  impact: string;
  help: string;
  helpUrl: string;
  /** One selector path, the shadow DOM pieces joined by ` >> `; as axe gave it. */
  target: string;
  html: string;
  /** The element itself, read in the page (its own tag, id, classes and attributes), when it could be: what the signature is made of. */
  element?: ElementInfo;
}

/** What the page says about the element that failed: its own markup, nothing of where it is. */
export interface ElementInfo {
  tag: string;
  id: string;
  classes: string[];
  attributes: Record<string, string>;
}

/** One entry of the baseline: where, which rule, which kind of element. `element` is for the reader and is not part of the identity. */
export interface BaselineEntry {
  state: string;
  rule: string;
  impact: string;
  /** The element's signature (`signatureOf`). */
  target: string;
  /** The opening tag of the first element of this kind that failed, as a hint of which one it is. */
  element?: string;
}

export interface BaselineFile {
  /** What the file is, for the person who opens it. */
  readme: string;
  /** The axe-core version that produced it: a newer ruleset that finds more is then visible as a version change. */
  axe: string;
  tags: string[];
  violations: BaselineEntry[];
}

export const BASELINE_PATH = path.resolve(__dirname, "../a11y-baseline.json");

export const BASELINE_README =
  "Known accessibility violations, by state of the app. a11y.spec.ts fails on a violation that is not listed and on an entry that no longer occurs: remove it. Rewrite with UPDATE_A11Y_BASELINE=1; see docs/testing/a11y.md.";

// ---------------------------------------------------------------------------
// The signature of an element
// ---------------------------------------------------------------------------

/** The attributes whose VALUE says what kind of element it is; every other attribute keeps its name and loses its value (`[href=*]`). */
const KIND_ATTRIBUTES = new Set(["data-testid", "data-slot", "data-variant", "data-size", "data-orientation", "role", "type", "name", "aria-label", "aria-roledescription"]);

/** The attributes of an element that go into its signature (what kind of element it is; a label or a name is the data on the page, so not those). */
const SIGNATURE_ATTRIBUTES = ["data-testid", "data-slot", "data-variant", "data-size", "data-orientation", "role", "type"];

const escapeCss = (name: string): string => name.replace(/([^\w-])/g, "\\$1");

/**
 * The signature of an element from its own markup (read in the page): the tag, a stable id, its classes in sorted order, and the attributes
 * that say what kind of element it is. Nothing of the page around it, and nothing that axe chose to make a selector unique: the same element has
 * the same signature in every run, whatever else is on the page.
 */
export function elementSignature(element: ElementInfo): string {
  const id = element.id && !GENERATED_ID.test(element.id) ? `#${escapeCss(element.id)}` : "";
  const classes = element.classes.map((name) => `.${escapeCss(name)}`).sort().join("");
  const attributes = SIGNATURE_ATTRIBUTES.filter((name) => name in element.attributes).map((name) => `[${name}="${element.attributes[name]}"]`).sort().join("");
  return `${element.tag}${id}${classes}${attributes}`;
}

/** An id that a framework makes up (React `:r1:`, Radix, Base UI, Headless UI): it differs from one render to the next. */
const GENERATED_ID = /^(:r[0-9a-z]+:|«r[0-9a-z]+»|_r_[0-9a-z]+_|radix-[\w:«»-]+|base-ui-[\w:«»-]+|headlessui-[\w:-]+)$/i;

/** Split a selector at its top-level combinators (`>`, `+`, `~`, a space), keeping quotes, brackets and parentheses whole; returns the compounds. */
function compoundsOf(selector: string): string[] {
  const parts: string[] = [];
  let current = "";
  let depth = 0;
  let quote = "";
  for (let i = 0; i < selector.length; i += 1) {
    const char = selector[i];
    if (char === "\\") {
      current += char + (selector[i + 1] ?? "");
      i += 1;
    } else if (quote) {
      if (char === quote) quote = "";
      current += char;
    } else if (char === '"' || char === "'") {
      quote = char;
      current += char;
    } else if (char === "[" || char === "(") {
      depth += 1;
      current += char;
    } else if (char === "]" || char === ")") {
      depth -= 1;
      current += char;
    } else if (depth === 0 && (char === ">" || char === "+" || char === "~" || char === " ")) {
      if (current) parts.push(current);
      current = "";
    } else current += char;
  }
  if (current) parts.push(current);
  return parts;
}

/** Normalize one compound selector (`button.b.a[data-x="1"]:nth-child(3)`): classes sorted, generated ids and positions starred, attribute values kept only for the kind attributes. */
function compoundSignature(compound: string): string {
  let tag = "";
  let id = "";
  const classes: string[] = [];
  const attributes: string[] = [];
  const pseudos: string[] = [];
  let i = 0;
  const readName = (): string => {
    let name = "";
    while (i < compound.length && !".#[:".includes(compound[i])) {
      if (compound[i] === "\\") {
        name += compound[i] + (compound[i + 1] ?? "");
        i += 2;
      } else {
        name += compound[i];
        i += 1;
      }
    }
    return name;
  };
  tag = readName();
  while (i < compound.length) {
    const char = compound[i];
    i += 1;
    if (char === ".") classes.push(readName());
    else if (char === "#") {
      const value = readName();
      id = GENERATED_ID.test(value) ? "#*" : `#${value}`;
    } else if (char === "[") {
      let depth = 1;
      let quote = "";
      let body = "";
      while (i < compound.length && depth > 0) {
        const inner = compound[i];
        if (quote) {
          if (inner === quote) quote = "";
        } else if (inner === '"' || inner === "'") quote = inner;
        else if (inner === "[") depth += 1;
        else if (inner === "]") depth -= 1;
        if (depth > 0) body += inner;
        i += 1;
      }
      const match = /^([\w:-]+)\s*([~|^$*]?=)\s*(?:"([^"]*)"|'([^']*)'|(\S*))$/.exec(body.trim());
      if (!match) attributes.push(`[${body}]`);
      else {
        const [, name, , doubleQuoted, singleQuoted, bare] = match;
        const value = doubleQuoted ?? singleQuoted ?? bare ?? "";
        if (name === "id" && GENERATED_ID.test(value)) attributes.push("[id=*]");
        else attributes.push(KIND_ATTRIBUTES.has(name) ? `[${name}="${value}"]` : `[${name}=*]`);
      }
    } else if (char === ":") {
      let pseudo = ":";
      while (i < compound.length && !".#[:(".includes(compound[i])) {
        pseudo += compound[i];
        i += 1;
      }
      if (compound[i] === "(") {
        let depth = 0;
        let argument = "";
        while (i < compound.length) {
          const inner = compound[i];
          if (inner === "(") depth += 1;
          if (inner === ")") depth -= 1;
          argument += inner;
          i += 1;
          if (depth === 0) break;
        }
        pseudo += /^:nth-/.test(pseudo) ? "(*)" : argument;
      }
      pseudos.push(pseudo);
    }
  }
  return `${tag}${id}${classes.sort().map((name) => `.${name}`).join("")}${attributes.sort().join("")}${pseudos.join("")}`;
}

/**
 * What identifies the KIND of element in a selector axe gave: the last compound of each shadow-DOM piece, without ancestors (they are
 * whatever made the selector unique in that page), its classes in sorted order, generated ids and sibling positions starred, and attribute
 * values dropped except for the ones that say what the element is (`data-testid`, `role`, `type`, `name`, `aria-label` ...).
 */
export function signatureOf(selector: string): string {
  return selector
    .split(" >> ")
    .map((piece) => {
      const compounds = compoundsOf(piece.trim());
      return compoundSignature(compounds[compounds.length - 1] ?? piece.trim());
    })
    .join(" >> ");
}

/** The signature of a finding. An element whose only selector is a generated id (`#*`) is named by its tag and the first of `data-testid`, `role`, `data-slot` it has. */
export function targetOf(finding: Pick<AxeFinding, "target" | "html"> & { element?: ElementInfo }): string {
  if (finding.element) return elementSignature(finding.element);
  const signature = signatureOf(finding.target);
  if (signature !== "#*") return signature;
  const tag = /^<([a-z][\w-]*)/i.exec(finding.html.trim())?.[1]?.toLowerCase() ?? "*";
  for (const attribute of ["data-testid", "role", "data-slot"]) {
    const value = new RegExp(`\\s${attribute}="([^"]*)"`).exec(finding.html)?.[1];
    if (value) return `${tag}[${attribute}="${value}"]`;
  }
  return tag;
}

/** The opening tag of an element's HTML, shortened, with the names a fixture made up replaced by placeholders: a hint of which element it was. */
export function describeElement(html: string, names: Readonly<Record<string, string>> = {}): string {
  let tag = /^<[^>]*>/.exec(html.trim())?.[0] ?? html.trim();
  // The longest name first: a slug that contains another must not be cut by it.
  for (const [value, placeholder] of Object.entries(names).sort((a, b) => b[0].length - a[0].length)) if (value) tag = tag.split(value).join(placeholder);
  return tag.replace(/\s+/g, " ").replace(/\s(id|aria-controls|aria-labelledby|aria-describedby|for)="[^"]*"/g, ` $1="*"`).slice(0, 160);
}

export const baselineKey = (entry: Pick<BaselineEntry, "state" | "rule" | "target">): string => `${entry.state}\u0001${entry.rule}\u0001${entry.target}`;

/** The findings of one state as baseline entries: one per (rule, signature), in a fixed order. `names` only shapes the hint. */
export function toEntries(state: string, findings: readonly AxeFinding[], names: Readonly<Record<string, string>> = {}): BaselineEntry[] {
  const byKey = new Map<string, BaselineEntry>();
  for (const finding of findings) {
    const entry: BaselineEntry = { state, rule: finding.rule, impact: finding.impact, target: targetOf(finding), element: describeElement(finding.html, names) };
    if (!byKey.has(baselineKey(entry))) byKey.set(baselineKey(entry), entry);
  }
  return [...byKey.values()].sort((a, b) => a.rule.localeCompare(b.rule) || a.target.localeCompare(b.target));
}

// ---------------------------------------------------------------------------
// Comparing, and the file
// ---------------------------------------------------------------------------

export interface BaselineComparison {
  /** In the page now and not in the baseline: a regression, or a violation nobody has accepted yet. */
  added: BaselineEntry[];
  /** In the baseline and not in the page any more: the baseline only shrinks, so it says so. */
  removed: BaselineEntry[];
}

/** What changed for one state: `recorded` are the baseline entries of that state, `found` what the scan found now. */
export function compareToBaseline(recorded: readonly BaselineEntry[], found: readonly BaselineEntry[]): BaselineComparison {
  const recordedKeys = new Set(recorded.map(baselineKey));
  const foundKeys = new Set(found.map(baselineKey));
  return {
    added: found.filter((entry) => !recordedKeys.has(baselineKey(entry))),
    removed: recorded.filter((entry) => !foundKeys.has(baselineKey(entry))),
  };
}

/** The failure message of a comparison that is not empty: every difference on a line of its own, and what to do about it. */
export function describeComparison(state: string, comparison: BaselineComparison, findings: readonly AxeFinding[] = []): string {
  const lines: string[] = [];
  if (comparison.added.length > 0) {
    lines.push(`${comparison.added.length} NEW accessibility violation(s) in "${state}" (fix the page; do not add them to the baseline):`);
    for (const entry of comparison.added) {
      const finding = findings.find((f) => f.rule === entry.rule && targetOf(f) === entry.target);
      lines.push(`  + ${entry.rule} (${entry.impact})  ${entry.target}`);
      if (finding) lines.push(`      ${finding.help}: ${finding.helpUrl}`, `      ${finding.html.slice(0, 200)}`);
    }
  }
  if (comparison.removed.length > 0) {
    lines.push(`${comparison.removed.length} entr${comparison.removed.length === 1 ? "y" : "ies"} of tests/e2e/a11y-baseline.json no longer occur in "${state}": remove them (the baseline only shrinks):`);
    for (const entry of comparison.removed) lines.push(`  - ${entry.rule} (${entry.impact})  ${entry.target}`);
    lines.push("  Edit the file by hand, or run this test with UPDATE_A11Y_BASELINE=1 (docs/testing/a11y.md).");
  }
  return lines.join("\n");
}

export function readBaseline(file: string = BASELINE_PATH): BaselineFile {
  return JSON.parse(readFileSync(file, "utf8")) as BaselineFile;
}

/** The entries of one state. */
export const entriesOfState = (baseline: BaselineFile, state: string): BaselineEntry[] => baseline.violations.filter((entry) => entry.state === state);

/** The file's text: a stable order (state, rule, target), one entry per line, so a change is a readable diff. */
export function serializeBaseline(baseline: BaselineFile): string {
  const entries = [...baseline.violations].sort((a, b) => a.state.localeCompare(b.state) || a.rule.localeCompare(b.rule) || a.target.localeCompare(b.target));
  const lines = entries.map((entry) => `    ${JSON.stringify({ state: entry.state, rule: entry.rule, impact: entry.impact, target: entry.target, ...(entry.element ? { element: entry.element } : {}) })}`);
  return [
    "{",
    `  "readme": ${JSON.stringify(baseline.readme)},`,
    `  "axe": ${JSON.stringify(baseline.axe)},`,
    `  "tags": ${JSON.stringify(baseline.tags)},`,
    `  "violations": [${lines.length ? `\n${lines.join(",\n")}\n  ` : ""}]`,
    "}",
    "",
  ].join("\n");
}

/** Replace the entries of `state` in the file with `entries`, and write it (atomically). Not safe for two writers: the spec runs serially to update. */
export function writeBaselineState(state: string, entries: readonly BaselineEntry[], meta: { axe: string; tags: readonly string[] }, file: string = BASELINE_PATH): void {
  let current: BaselineFile;
  try {
    current = readBaseline(file);
  } catch {
    current = { readme: BASELINE_README, axe: meta.axe, tags: [...meta.tags], violations: [] };
  }
  const next: BaselineFile = {
    readme: BASELINE_README,
    axe: meta.axe,
    tags: [...meta.tags],
    violations: [...current.violations.filter((entry) => entry.state !== state), ...entries],
  };
  const temporary = `${file}.${process.pid}.tmp`;
  writeFileSync(temporary, serializeBaseline(next));
  renameSync(temporary, file);
}
