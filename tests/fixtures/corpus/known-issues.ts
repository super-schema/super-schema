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
import { BQ_PK_OUTSIDE } from "../../helpers/corpus/emulators";
import { JAVA_ENUM_NO_PACKAGE } from "../../helpers/corpus/validators";
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

/** The names of every entity / enum / union that the case's OWN document defines or refers to, as the generator may spell them. */
export function documentNames(built: BuiltCase): Set<string> {
  const names = new Set<string>();
  const add = (n: string | undefined): void => { if (n) { names.add(n); names.add(sanitizeIdentifier(n)); } };
  for (const f of built.fields) { add(decoratorsOf(f).referencedEntityName); for (const m of decoratorsOf(f).unionMembers ?? []) add(m); }
  for (const e of built.imported?.entities ?? []) add(e.name);
  for (const e of built.imported?.enums ?? []) add(e.name);
  for (const u of built.imported?.unions ?? []) add(u.name);
  return names;
}

/** The identifiers an `Unknown identifier X` diagnostic complains about. */
export const unknownIdentifiers = (reason: string): string[] => [...reason.matchAll(/Unknown identifier ([^\s]+)/g)].map((m) => m[1]);

export const KNOWN_ISSUES: KnownIssue[] = [
  {
    id: "bigquery-pk-after-column-list", targets: ["bigquery"], disposition: "sibling", owner: "@typespec/bigquery write.ts:74-77",
    issue: "Sibling emitter defect, confirmed against BigQuery's documented CREATE TABLE grammar and not confirmable on the emulator. The emitter writes `) PRIMARY KEY (...) NOT ENFORCED` AFTER the closing paren of the column list (Spanner's form); BigQuery's grammar takes the constraint inside the element list. The LocalCloud emulator (ZetaSQL parser) rejects the emitted form (`PRIMARY KEY must be defined in the table element list as column attribute or constraint`); moved inside the list it says `Unsupported table DDL fields: ['primaryKey']` (it cannot create primary-key tables at all); without the clause the DDL is accepted. sqlglot accepts both placements, so it is no evidence either way.",
    diagnostic: { code: BQ_PK_OUTSIDE, message: /PRIMARY KEY must be defined in the table element list/ },
  },
  {
    id: "bigquery-array-not-null", targets: ["bigquery"], disposition: "sibling", owner: "@typespec/bigquery write.ts (NOT NULL on a required ARRAY column)",
    issue: "A required array field is written `col ARRAY<T> NOT NULL`. The engine's analyzer says `Columns and fields of ARRAY type do not support the NOT NULL modifier` (the message real BigQuery gives: an ARRAY column is never NULL, only empty), so the DDL cannot run. Judged without the primary-key clause so it is not hidden by bigquery-pk-after-column-list.",
    diagnostic: { code: "judged without the PRIMARY KEY clause", message: /Columns and fields of ARRAY type do not support the NOT NULL modifier/ },
  },
  {
    id: "bigquery-emulator-timestamp-array", targets: ["bigquery"], disposition: "emulator", owner: "LocalCloud BigQuery emulator",
    issue: "`ARRAY<TIMESTAMP>` is rejected by the emulator's own loader (`TIMESTAMP columns are qualified only as top-level non-repeated columns`); real BigQuery supports arrays of timestamps. Not an emitter or app defect.",
    diagnostic: { code: "judged without the PRIMARY KEY clause", message: /TIMESTAMP columns are qualified only as top-level non-repeated columns/ },
  },
  {
    id: "java-enum-without-package", targets: ["java-pojo"], disposition: "sibling", owner: "@typespec/java-pojo write.ts writeJavaEnum",
    issue: "writeJavaEnum writes `public enum X {...}` with no `package` line while the POJO is in `package com.superschema.generated;`, so the class cannot see its enum (javac: cannot find symbol). javac compiles once the package line is added to the enum file (the validator proves it).",
    diagnostic: { code: JAVA_ENUM_NO_PACKAGE, message: /compiles after adding `package [\w.]+;`/ },
  },
  {
    id: "java-javadoc-not-escaped", targets: ["java-pojo"], disposition: "sibling", owner: "@typespec/java-pojo write.ts javadoc()",
    issue: "A description containing `*/` is written into the Javadoc unescaped, closing the comment early: javac `class, interface, enum, or record expected`. Source text of a schema can therefore inject Java code into the generated file.",
    diagnostic: { code: "validate:", message: /class, interface, enum, or record expected/ },
    when: ({ built }) => built.entity.description.includes("*/") || built.fields.some((f) => f.description.includes("*/")),
  },
  {
    id: "avro-recursive-model-crash", targets: ["avro"], disposition: "sibling", owner: "@typespec/avro transform.ts mapType",
    issue: "A model that refers to itself (`children: Node[]`, `parent: Node`) makes the emitter recurse without a visited set: `RangeError: Maximum call stack size exceeded` at mapType (transform.ts:261-270), reported by the app as `The TypeSpec emitter failed.`. Avro supports recursive records by name.",
    diagnostic: { code: "The TypeSpec emitter failed", message: /The TypeSpec emitter failed/ },
    when: ({ built }) => built.fields.some((f) => decoratorsOf(f).referencedEntityName === built.entity.name),
  },
  {
    id: "multi-model-emission-gap", targets: ["json-schema", "openapi3", "avro", "protobuf", "java-pojo"], disposition: "open", owner: "this repo (documented gap: default-mappings.ts reference -> protobuf lossDescription)",
    issue: "An entity is emitted ALONE (emitOfficialTypeSpecTargetFromData takes one entity), so a field that references another entity of the same document (`$ref: #/$defs/Addr`, a oneOf of refs, a model reference) names a type that is not in the compile unit: `invalid-ref: Unknown identifier X`. Only matched when X is an entity the case's own document defines or refers to. The DB targets store a reference as text and are unaffected.",
    diagnostic: { code: "invalid-ref", message: /Unknown identifier/ },
    when: ({ outcome, built }) => {
      const unknown = unknownIdentifiers(outcome.reason ?? "");
      const names = documentNames(built);
      return unknown.length > 0 && unknown.every((id) => names.has(id));
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
    id: "openapi-internal-ref-extension", targets: ["openapi3"], disposition: "open", owner: "this repo importer (additionalProperties kept verbatim as an extension, by design)",
    issue: "`additionalProperties` is not mapped by the importer (IGNORED_SCHEMA_KEYWORDS) and is kept verbatim as an extension so a JSON Schema round trip loses nothing. When its value is a `$ref: #/$defs/V` the OpenAPI document gets `additionalProperties: {$ref: '#/$defs/V'}`, which does not resolve there. Only matched when the unresolved pointer is one the case's own source contains.",
    diagnostic: { code: "validate:", message: /Can't resolve reference: #\/\$defs\// },
    when: ({ c, outcome }) => {
      const m = /Can't resolve reference: (#\/\$defs\/[^\s|]+)/.exec(outcome.reason ?? "");
      return m !== null && typeof c.source === "string" && c.source.includes(m[1]);
    },
  },
];

const diagnosticMatches = (reason: string, d: { code: string; message: RegExp }): boolean => reason.includes(d.code) && d.message.test(reason);

export function matchKnownIssue(
  c: CorpusCase, target: TargetKey, outcome: TargetOutcome, built: BuiltCase, registry: readonly KnownIssue[] = KNOWN_ISSUES,
): { id: string; issue: string } | undefined {
  const reason = outcome.reason ?? "";
  const explicit = c.expectations.expectedFailures?.find((f) => (f.target === target || f.target === "*") && reason.includes(f.code) && f.message.test(reason));
  if (explicit) return { id: "case-expectation", issue: `${explicit.reason} (${explicit.issue})` };
  const rule = registry.find((k) => k.targets.includes(target) && diagnosticMatches(reason, k.diagnostic) && (k.when?.({ c, outcome, built }) ?? true));
  return rule ? { id: rule.id, issue: rule.issue } : undefined;
}

export interface RegistryOutcome { caseId: string; target: TargetKey; kind: string; knownId?: string }

/**
 * Staleness of the registry for a FULL run (pure): a rule that matched no (case, target), and a per-case expectation whose case no
 * longer fails. The caller skips this for a filtered run (a filter makes unmatched rules normal).
 */
export function registryProblems(cases: readonly CorpusCase[], outcomes: readonly RegistryOutcome[], registry: readonly KnownIssue[] = KNOWN_ISSUES): string[] {
  const problems: string[] = [];
  for (const rule of registry) {
    if (!outcomes.some((o) => o.knownId === rule.id)) {
      problems.push(`known issue ${rule.id} no longer reproduces for any case: remove it from known-issues.ts`);
    }
  }
  for (const c of cases) {
    for (const f of c.expectations.expectedFailures ?? []) {
      const targets = f.target === "*" ? [...new Set(outcomes.filter((o) => o.caseId === c.id).map((o) => o.target))] : [f.target];
      const stale = targets.filter((t) => !outcomes.some((o) => o.caseId === c.id && o.target === t && o.kind === "FAIL" && o.knownId === "case-expectation"));
      if (f.target !== "*" && stale.length > 0) problems.push(`known issue ${f.code} no longer reproduces for ${c.id}/${f.target}: remove it from the case's expectedFailures`);
      if (f.target === "*" && targets.length > 0 && !targets.some((t) => !stale.includes(t))) problems.push(`known issue ${f.code} no longer reproduces for ${c.id}/*: remove it from the case's expectedFailures`);
    }
  }
  return problems;
}
