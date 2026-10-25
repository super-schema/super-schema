/**
 * Known failures whose root cause is NOT a bug to fix in this repo, each with the evidence. A failing (case, target) that a rule matches
 * is shown in the matrix as FAIL (expected) and keeps the suite green; anything else fails the suite.
 *
 * Honesty rules (checked by `registryProblems`, which the CORPUS=1 run enforces):
 *  - a rule names the DIAGNOSTIC it is about: a `code` (the code the emitter / validator printed) AND a `message` pattern, plus an
 *    optional `when` that ties it to facts of the case. A different failure of the same (case, target) is NOT masked.
 *  - a rule that matched no case fails the run ("no longer reproduces"): a fixed issue must be removed from here.
 *  - a per-case `expectedFailures` entry needs code + message too, and a case that no longer fails under it fails the run.
 *
 * disposition:
 *   sibling   - defect in a sibling emitter package (~/src/my/typespec/packages/*), not modified here
 *   official  - limitation of an official @typespec package / of the target format
 *   open      - design question for the controller (behavior is documented or ambiguous, not clearly a bug)
 *   by-design - the app refuses with an actionable message on purpose
 *   emulator  - the LocalCloud emulator is narrower than the real engine (the DDL is valid there)
 */
import type { BuiltCase } from "../../helpers/corpus/build-rows";
import type { TargetOutcome } from "../../helpers/corpus/run-case";
import { sanitizeIdentifier } from "@/lib/compiler/typespec-identifiers";
import type { CorpusCase, TargetKey } from "./types";

export interface KnownIssue {
  id: string;
  targets: readonly TargetKey[];
  disposition: "sibling" | "official" | "open" | "by-design" | "emulator";
  owner: string;
  /** Evidence: what happens and why it is not fixed here. */
  issue: string;
  /** The diagnostic: its code (a substring of the printed reason) and a pattern of its message. Both must match. */
  diagnostic: { code: string; message: RegExp };
  /** Facts of the case the failure must be tied to. */
  when?: (ctx: { c: CorpusCase; outcome: TargetOutcome; built: BuiltCase }) => boolean;
}

const decoratorsOf = (f: BuiltCase["fields"][number]): { referencedEntityName?: string; unionMembers?: string[] } => (f.decorators ?? {}) as { referencedEntityName?: string; unionMembers?: string[] };

/**
 * The names the case's entities REFER to (a reference field's target, a union member) that NO entity of the case's tenant carries, as the
 * generator may spell them: a reference nothing answers to. A name some entity of the case has is resolved by the closure and is never here.
 */
export function unansweredNames(built: BuiltCase): Set<string> {
  const answered = new Set<string>();
  for (const member of built.members) { answered.add(member.entity.name); answered.add(sanitizeIdentifier(member.entity.name)); }
  for (const e of built.imported?.enums ?? []) { answered.add(e.name); answered.add(sanitizeIdentifier(e.name)); }
  for (const u of built.imported?.unions ?? []) { answered.add(u.name); answered.add(sanitizeIdentifier(u.name)); }
  const names = new Set<string>();
  const add = (n: string | undefined): void => {
    if (n && !answered.has(n) && !answered.has(sanitizeIdentifier(n))) { names.add(n); names.add(sanitizeIdentifier(n)); }
  };
  for (const member of built.members) {
    for (const f of member.fields) { add(decoratorsOf(f).referencedEntityName); for (const m of decoratorsOf(f).unionMembers ?? []) add(m); }
  }
  return names;
}

/** The union members (`unionMembers` of a field of any entity of the case) that are the name of an entity of the case's tenant, as the generator may spell them. */
export function unionEntityMembers(built: BuiltCase): Set<string> {
  const entities = new Set<string>();
  for (const member of built.members) { entities.add(member.entity.name); entities.add(sanitizeIdentifier(member.entity.name)); }
  const names = new Set<string>();
  for (const member of built.members) {
    for (const f of member.fields) {
      for (const m of decoratorsOf(f).unionMembers ?? []) {
        if (entities.has(m) || entities.has(sanitizeIdentifier(m))) { names.add(m); names.add(sanitizeIdentifier(m)); }
      }
    }
  }
  return names;
}

/** The identifiers an `Unknown identifier X` diagnostic complains about. */
export const unknownIdentifiers = (reason: string): string[] => [...reason.matchAll(/Unknown identifier ([^\s]+)/g)].map((m) => m[1]);

export const KNOWN_ISSUES: KnownIssue[] = [
  {
    id: "bigquery-emulator-timestamp-array", targets: ["bigquery"], disposition: "emulator", owner: "LocalCloud BigQuery emulator",
    issue: "`ARRAY<TIMESTAMP>` is rejected by the emulator's own loader (`TIMESTAMP columns are qualified only as top-level non-repeated columns`); real BigQuery supports arrays of timestamps. Not an emitter or app defect.",
    diagnostic: { code: "validate:", message: /TIMESTAMP columns are qualified only as top-level non-repeated columns/ },
  },
  {
    // Re-judged against closure emission (multi-entity emission, Task 12). The old `multi-model-emission-gap` (an entity emitted ALONE
    // cannot name the other entities of its document) is gone: every reference to an entity of the tenant resolves through the closure
    // and is generated and validated as one file per entity. What is left of `invalid-ref` is a reference to a name NO entity answers to.
    id: "reference-to-missing-entity", targets: ["json-schema", "openapi3", "avro", "protobuf", "java-pojo"], disposition: "open", owner: "this repo (closure-emit.ts standalonePlan; default-mappings.ts reference -> protobuf lossDescription)",
    issue: "(KD-031, docs/testing/known-defects.md) A reference field whose target no entity of the tenant carries (a deleted entity, a name that never existed), in an entity whose closure is that entity alone, is emitted by its bare name, which the compiler refuses: `invalid-ref: Unknown identifier X`. A closure of several entities emits the same field untyped with a warning instead (case ref-dangling-in-closure): the two paths disagree. The reference resolver itself treats the field as dangling (no error). Only a name the case's own entities REFER to and none of them carries is matched. The DB targets store a reference as text and are unaffected.",
    diagnostic: { code: "invalid-ref", message: /Unknown identifier/ },
    when: ({ outcome, built }) => {
      const unknown = unknownIdentifiers(outcome.reason ?? "");
      const names = unansweredNames(built);
      return unknown.length > 0 && unknown.every((id) => names.has(id));
    },
  },
  {
    id: "union-of-entity-references", targets: ["json-schema", "openapi3", "avro", "protobuf", "java-pojo"], disposition: "open", owner: "this repo (closure.ts walks reference fields only; the importer stores a oneOf / anyOf of $refs as a union of NAMES)",
    issue: "(KD-029, docs/testing/known-defects.md) A field that is a union of entities (`oneOf` / `anyOf` of `$ref`s: `type: union`, `unionMembers: [Card, Bank]`) holds the member NAMES, not references. The reference closure walks `reference` fields (and arrays / maps of them), so the members are not in the closure and the union names models the compile unit does not declare: `invalid-ref: Unknown identifier Card`. Only matched when every unknown identifier is a union member that names an entity of the case's own tenant (a member nothing answers to is `reference-to-missing-entity`). The DB targets store the union as text and are unaffected.",
    diagnostic: { code: "invalid-ref", message: /Unknown identifier/ },
    when: ({ outcome, built }) => {
      const unknown = unknownIdentifiers(outcome.reason ?? "");
      const members = unionEntityMembers(built);
      return unknown.length > 0 && unknown.every((id) => members.has(id));
    },
  },
  {
    id: "ambiguous-reference-refusal", targets: ["json-schema", "openapi3", "avro", "protobuf", "java-pojo"], disposition: "by-design", owner: "this repo closure.ts (refusal)",
    issue: "A legacy name-only reference that more than one entity of the tenant answers to is refused with the candidates (domain / product / entity), and nothing is silently picked: only an explicit pick (the pick dialog, the TypeSpec tab) writes the qualified reference, and a generate call never does. Only matched when every candidate named is an entity of the case.",
    diagnostic: { code: "AMBIGUOUS_REFERENCE", message: /names ".+", which matches .+\/.+\/.+, .+\/.+\/.+/ },
    when: ({ outcome, built }) => {
      const m = /which matches (.+)$/.exec(outcome.reason ?? "");
      const candidates = (m?.[1] ?? "").split(", ").map((c) => c.split("/").pop());
      return candidates.length >= 2 && candidates.every((name) => built.members.some((member) => member.entity.name === name));
    },
  },
  {
    id: "protobuf-nested-array", targets: ["protobuf"], disposition: "official", owner: "@typespec/protobuf",
    issue: "`@typespec/protobuf/nested-array: nested arrays are not supported by the Protobuf emitter`: protobuf cannot express repeated repeated fields; the app does not project an array of arrays for this target (the DB targets note `declared array; stored as ARRAY<...>`).",
    diagnostic: { code: "@typespec/protobuf/nested-array", message: /nested arrays are not supported/ },
  },
  {
    id: "name-collision-guard", targets: ["avro", "protobuf", "java-pojo"], disposition: "by-design", owner: "this repo name-collisions.ts (refusal)",
    issue: "Names that the target writes as the same identifier (`a-b` / `a_b`, `😀` / `名前`) are refused before emitting with a message naming both and the identifier (the DB targets do the same in db-source.ts).",
    diagnostic: { code: "would all be written as", message: /The (fields|enum symbols) .* would all be written as ".*" in (Avro|Protobuf|Java)/ },
  },
  {
    id: "name-too-long-guard", targets: ["json-schema", "openapi3", "avro", "protobuf", "java-pojo", "postgresql", "spanner", "bigquery"], disposition: "by-design", owner: "this repo emitter.service.ts (refusal)",
    issue: "A stored entity / field name over 128 characters (a TypeSpec import or a hand-built entity bypasses the JSON Schema import limit) is refused at generation with a message naming it, instead of crashing the emitters with ENAMETOOLONG.",
    diagnostic: { code: "characters long", message: /names longer than 128 characters cannot be generated\. Rename it/ },
  },
  {
    id: "db-name-guard", targets: ["postgresql", "spanner", "bigquery"], disposition: "by-design", owner: "this repo db-source.ts (refusal)",
    issue: "A name that cannot become a column name, or that collides with another after normalisation, is refused with an actionable message naming the fields (`cannot be turned into a column name`, `would all become the column`).",
    diagnostic: { code: "The field", message: /cannot be turned into a (column|table|schema) name|would all become the (column|table)/ },
  },
  {
    // Re-judged against closure emission: still real, and now on JSON Schema too. The JSON Schema output used to be one bundle whose `$defs`
    // held `V`, so the pointer resolved by accident (nothing compiled the unreferenced `$defs`); each entity is its own file now and the
    // pointer names a node the file does not have. The importer does not map the map's value to a reference, so `V` is not in the closure.
    id: "openapi-internal-ref-extension", targets: ["openapi3", "json-schema"], disposition: "open", owner: "this repo importer (additionalProperties kept verbatim as an extension, by design)",
    issue: "`additionalProperties` is not mapped by the importer (IGNORED_SCHEMA_KEYWORDS) and is kept verbatim as an extension so a JSON Schema round trip loses nothing. When its value is a `$ref: #/$defs/V` the OpenAPI document and the JSON Schema file get `additionalProperties: {$ref: '#/$defs/V'}`, which does not resolve there (`V` is not a node of that document, nor a file of the set: the map's value is not a reference field, so `V` is not in the closure). Only matched when the unresolved pointer is one the case's own source contains.",
    diagnostic: { code: "validate:", message: /Can't resolve reference: #\/\$defs\// },
    when: ({ c, outcome }) => {
      const m = /Can't resolve reference: (#\/\$defs\/[^\s|]+)/.exec(outcome.reason ?? "");
      return m !== null && typeof c.source === "string" && c.source.includes(m[1]);
    },
  },
];

const diagnosticMatches = (reason: string, d: { code: string; message: RegExp }): boolean => reason.includes(d.code) && d.message.test(reason);

/**
 * The rule that explains a FAIL. A reason that joins several diagnostics (" | ") is judged diagnostic by diagnostic and EVERY one must be
 * explained by some rule / per-case entry: one unexplained diagnostic means the failure is not masked. The id returned is the first one's.
 */
export function matchKnownIssue(
  c: CorpusCase, target: TargetKey, outcome: TargetOutcome, built: BuiltCase, registry: readonly KnownIssue[] = KNOWN_ISSUES,
): { id: string; issue: string } | undefined {
  const diagnostics = (outcome.reason ?? "").split(" | ").map((d) => d.trim()).filter(Boolean);
  if (diagnostics.length === 0) return undefined;
  const explain = (diagnostic: string): { id: string; issue: string } | undefined => {
    const each: TargetOutcome = { ...outcome, reason: diagnostic };
    const explicit = c.expectations.expectedFailures?.find((f) => (f.target === target || f.target === "*") && diagnostic.includes(f.code) && f.message.test(diagnostic));
    if (explicit) return { id: "case-expectation", issue: `${explicit.reason} (${explicit.issue})` };
    const rule = registry.find((k) => k.targets.includes(target) && diagnosticMatches(diagnostic, k.diagnostic) && (k.when?.({ c, outcome: each, built }) ?? true));
    return rule ? { id: rule.id, issue: rule.issue } : undefined;
  };
  const explained = diagnostics.map(explain);
  return explained.every((e) => e !== undefined) ? explained[0] : undefined;
}

export interface RegistryOutcome { caseId: string; target: TargetKey; kind: string; knownId?: string; tierSkipped?: string }

/** The validator tier a target's output is judged by, when that tier is not always available. */
const TIER_OF_TARGET: Partial<Record<TargetKey, string>> = { bigquery: "bigquery", spanner: "spanner", "java-pojo": "java" };

/**
 * Staleness of the registry for a FULL run (pure): a rule that matched no (case, target), and a per-case expectation whose case no
 * longer fails. The caller skips this for a filtered run (a filter makes unmatched rules normal).
 */
export function registryProblems(cases: readonly CorpusCase[], outcomes: readonly RegistryOutcome[], registry: readonly KnownIssue[] = KNOWN_ISSUES): string[] {
  const problems: string[] = [];
  // A run that was allowed to skip a validator tier cannot reproduce what only that tier finds: those rules / entries are not judged.
  const skipped = new Set(outcomes.map((o) => o.tierSkipped).filter((t): t is string => t !== undefined));
  const tierSkipped = (t: TargetKey): boolean => skipped.has(TIER_OF_TARGET[t] ?? "\u0000");
  for (const rule of registry) {
    if (rule.targets.every(tierSkipped)) continue;
    if (!outcomes.some((o) => o.knownId === rule.id)) {
      problems.push(`known issue ${rule.id} no longer reproduces for any case: remove it from known-issues.ts`);
    }
  }
  for (const c of cases) {
    for (const f of c.expectations.expectedFailures ?? []) {
      if (f.target !== "*" && tierSkipped(f.target)) continue;
      const targets = f.target === "*" ? [...new Set(outcomes.filter((o) => o.caseId === c.id).map((o) => o.target))] : [f.target];
      const stale = targets.filter((t) => !outcomes.some((o) => o.caseId === c.id && o.target === t && o.kind === "FAIL" && o.knownId === "case-expectation"));
      if (f.target !== "*" && stale.length > 0) problems.push(`known issue ${f.code} no longer reproduces for ${c.id}/${f.target}: remove it from the case's expectedFailures`);
      if (f.target === "*" && targets.length > 0 && !targets.some((t) => !stale.includes(t))) problems.push(`known issue ${f.code} no longer reproduces for ${c.id}/*: remove it from the case's expectedFailures`);
    }
  }
  return problems;
}
