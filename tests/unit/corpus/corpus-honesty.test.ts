/**
 * The corpus judges its own results; these tests pin that judging (no real generation): a known-issue rule cannot swallow a different
 * failure, a rule that no longer reproduces fails a full run, and skipped work is never silently green.
 */
import { describe, it, expect, vi } from "vitest";
import { matchKnownIssue, registryProblems, unansweredNames, type KnownIssue } from "../../fixtures/corpus/known-issues";
import { KNOWN_ISSUES } from "../../fixtures/corpus/known-issues";
import { problemsOf, allowedSkipTiersFromEnv, type CaseResult } from "../../helpers/corpus/orchestrate";
import { isAllowedBigQueryStatement, splitStatements, stripPrimaryKey } from "../../helpers/corpus/emulators";
import type { CorpusCase } from "../../fixtures/corpus/types";
import type { BuiltCase } from "../../helpers/corpus/build-rows";
import type { TargetOutcome } from "../../helpers/corpus/run-case";

vi.mock("server-only", () => ({}));

const baseCase = (extra: Partial<CorpusCase["expectations"]> = {}, source = "{}"): CorpusCase => ({ id: "c1", title: "t", kind: "jsonschema", source, tags: [], expectations: extra });
/** A case whose entity refers to the names in `referenced`; `tenant` are the other entities of its tenant (what the closure resolves a name to). */
const built = (referenced: string[] = [], tenant: string[] = []): BuiltCase => {
  const entity = { id: "e", name: "Evt", description: "", status: "DRAFT", version: 1, domainId: "d", metadata: {} };
  const fields = referenced.map((n, i) => ({ id: `f${i}`, name: `f${i}`, type: "reference", precision: null, scale: null, nullable: false, isKey: false, fieldNumber: null, description: "", classification: null, aliases: [], decorators: { referencedEntityName: n }, sortOrder: i }));
  return {
    entity, fields, importWarnings: [], entityCount: 1 + tenant.length,
    members: [{ entity, fields, place: {}, published: [] }, ...tenant.map((name, i) => ({ entity: { ...entity, id: `t${i}`, name }, fields: [], place: {}, published: [] }))],
  };
};
const failed = (target: TargetOutcome["target"], reason: string): TargetOutcome => ({ target, kind: "FAIL", reason, warnings: [] });

describe("a known issue does not mask a different failure", () => {
  const TS = "TIMESTAMP columns are qualified only as top-level non-repeated columns";
  it("matches the rule's own diagnostic", () => {
    const hit = matchKnownIssue(baseCase(), "bigquery", failed("bigquery", `validate: INVALID_ARGUMENT: ${TS}`), built());
    expect(hit?.id).toBe("bigquery-emulator-timestamp-array");
  });

  it("stripPrimaryKey removes the in-list constraint and its comma only", () => {
    expect(stripPrimaryKey("CREATE TABLE t (\n  a INT64 NOT NULL,\n  PRIMARY KEY (a, b) NOT ENFORCED\n)")).toBe("CREATE TABLE t (\n  a INT64 NOT NULL\n)");
    expect(stripPrimaryKey("CREATE TABLE t (\n  a INT64\n)")).toBe("CREATE TABLE t (\n  a INT64\n)");
  });

  it("does not match another bigquery failure of the same case", () => {
    expect(matchKnownIssue(baseCase(), "bigquery", failed("bigquery", "validate: INVALID_ARGUMENT: Syntax error: Unexpected integer literal"), built())).toBeUndefined();
    // the right words under a different code are not the rule either
    expect(matchKnownIssue(baseCase(), "bigquery", failed("bigquery", TS), built())).toBeUndefined();
  });

  it("does not match the right diagnostic on a target the rule is not about", () => {
    expect(matchKnownIssue(baseCase(), "spanner", failed("spanner", `validate: ${TS}`), built())).toBeUndefined();
  });

  it("the multi-model emission gap is retired: a name an entity of the tenant carries is resolved by the closure, so its failure is real", () => {
    expect(KNOWN_ISSUES.map((k) => k.id)).not.toContain("multi-model-emission-gap");
    const reason = "invalid-ref: Unknown identifier Addr";
    // `Addr` is an entity of the case's tenant: the old rule would have masked this, the new one must not
    expect(matchKnownIssue(baseCase(), "json-schema", failed("json-schema", reason), built(["Addr"], ["Addr"]))).toBeUndefined();
  });

  it("reference to a missing entity: only a name the case's entities refer to and no entity of the tenant carries", () => {
    const reason = "invalid-ref: Unknown identifier Addr";
    expect(matchKnownIssue(baseCase(), "json-schema", failed("json-schema", reason), built(["Addr"]))?.id).toBe("reference-to-missing-entity");
    // an importer naming bug (the field points at `Addr`, the emitter complains about `addr_x`) is a real failure
    expect(matchKnownIssue(baseCase(), "json-schema", failed("json-schema", "invalid-ref: Unknown identifier addr_x"), built(["Addr"]))).toBeUndefined();
    expect(matchKnownIssue(baseCase(), "json-schema", failed("json-schema", `${reason}\ninvalid-ref: Unknown identifier Other`), built(["Addr"]))).toBeUndefined();
    expect(matchKnownIssue(baseCase(), "bigquery", failed("bigquery", reason), built(["Addr"]))).toBeUndefined();
  });

  it("union of entity references: only a union member that names an entity of the case's tenant (a member nothing answers to is another rule)", () => {
    const reason = "invalid-ref: Unknown identifier Card\ninvalid-ref: Unknown identifier Bank";
    const diagnostics = reason.replace("\n", " | ");
    const withUnion = (members: string[], tenant: string[]): BuiltCase => {
      const b = built([], tenant);
      const fields = [{ ...b.fields[0], id: "u", name: "method", type: "union", decorators: { unionName: "U", unionMembers: members } }].filter(Boolean);
      return { ...b, fields, members: [{ ...b.members[0], fields }, ...b.members.slice(1)] };
    };
    expect(matchKnownIssue(baseCase(), "json-schema", failed("json-schema", diagnostics), withUnion(["Card", "Bank"], ["Card", "Bank"]))?.id).toBe("union-of-entity-references");
    // a member that is no entity is the other rule's (each diagnostic is judged on its own), and a name that is no member of the union at all is nobody's
    expect(matchKnownIssue(baseCase(), "json-schema", failed("json-schema", diagnostics), withUnion(["Card", "Bank"], []))?.id).toBe("reference-to-missing-entity");
    expect(matchKnownIssue(baseCase(), "json-schema", failed("json-schema", "invalid-ref: Unknown identifier Card | invalid-ref: Unknown identifier Other"), withUnion(["Card", "Bank"], ["Card", "Bank"]))).toBeUndefined();
    expect(matchKnownIssue(baseCase(), "bigquery", failed("bigquery", diagnostics), withUnion(["Card", "Bank"], ["Card", "Bank"]))).toBeUndefined();
  });

  it("ambiguous reference refusal: only when every candidate named is an entity of the case", () => {
    const reason = 'reference-closure AMBIGUOUS_REFERENCE: field "customer" names "Customer", which matches Sales/Retail/Customer, Sales/Wholesale/Customer';
    expect(matchKnownIssue(baseCase(), "avro", failed("avro", reason), built([], ["Customer", "Customer"]))?.id).toBe("ambiguous-reference-refusal");
    // candidates the case does not have: not this refusal
    expect(matchKnownIssue(baseCase(), "avro", failed("avro", reason), built([], ["Other"]))).toBeUndefined();
    // the same words under another code, or for a DB target, are not it either
    expect(matchKnownIssue(baseCase(), "avro", failed("avro", reason.replace("AMBIGUOUS_REFERENCE", "SOMETHING_ELSE")), built([], ["Customer", "Customer"]))).toBeUndefined();
    expect(matchKnownIssue(baseCase(), "postgresql", failed("postgresql", reason), built([], ["Customer", "Customer"]))).toBeUndefined();
  });

  it("the internal ref extension rule (openapi3 and json-schema) needs the pointer to come from the case's own source", () => {
    const reason = "validate: Can't resolve reference: #/$defs/V";
    expect(matchKnownIssue(baseCase({}, '{"x":{"$ref":"#/$defs/V"}}'), "openapi3", failed("openapi3", reason), built())?.id).toBe("openapi-internal-ref-extension");
    expect(matchKnownIssue(baseCase({}, '{"x":{"$ref":"#/$defs/Other"}}'), "openapi3", failed("openapi3", reason), built())).toBeUndefined();
    // the JSON Schema file says the same of the same pointer (each entity is a file of its own now)
    const js = "validate: Can't resolve reference: #/$defs/V (MapRef.json is in the output and has no such node)";
    expect(matchKnownIssue(baseCase({}, '{"x":{"$ref":"#/$defs/V"}}'), "json-schema", failed("json-schema", js), built())?.id).toBe("openapi-internal-ref-extension");
    expect(matchKnownIssue(baseCase({}, '{"x":{"$ref":"#/$defs/Other"}}'), "json-schema", failed("json-schema", js), built())).toBeUndefined();
    // a sibling FILE that does not resolve is not this rule: it is a defect of the output
    expect(matchKnownIssue(baseCase({}, '{"x":{"$ref":"#/$defs/V"}}'), "json-schema", failed("json-schema", 'validate: a $ref to the sibling file "V.json" does not resolve: no file of the output has that name or $id'), built())).toBeUndefined();
  });

  it("a per-case expectation needs its code AND message; any other failure of that target is real", () => {
    const c = baseCase({ expectedFailures: [{ target: "avro", code: "crash-code", message: /stack overflow/, reason: "r", issue: "i" }] });
    expect(matchKnownIssue(c, "avro", failed("avro", "crash-code: a stack overflow in the emitter"), built())?.id).toBe("case-expectation");
    expect(matchKnownIssue(c, "avro", failed("avro", "crash-code: something else"), built())).toBeUndefined();
    expect(matchKnownIssue(c, "avro", failed("avro", "other-code: stack overflow"), built())).toBeUndefined();
    expect(matchKnownIssue(c, "protobuf", failed("protobuf", "crash-code: stack overflow"), built())).toBeUndefined();
  });

  it("a reason that joins several diagnostics is masked only when EVERY one is explained", () => {
    const joined = "invalid-ref: Unknown identifier Addr | decorator-wrong-target: Cannot apply @minItems";
    expect(matchKnownIssue(baseCase(), "json-schema", failed("json-schema", joined), built(["Addr"]))).toBeUndefined();
    const both = "invalid-ref: Unknown identifier Addr | invalid-ref: Unknown identifier Line";
    expect(matchKnownIssue(baseCase(), "json-schema", failed("json-schema", both), built(["Addr", "Line"]))?.id).toBe("reference-to-missing-entity");
    expect(matchKnownIssue(baseCase(), "json-schema", failed("json-schema", both), built(["Addr"]))).toBeUndefined();
  });

  it("unansweredNames spells the names the way the generator does, and leaves out every entity of the tenant", () => {
    expect([...unansweredNames(built(["my-entity"]))].sort()).toEqual(["my-entity", "my_entity"]);
    expect([...unansweredNames(built(["my-entity", "Kept"], ["Kept"]))].sort()).toEqual(["my-entity", "my_entity"]);
  });
});

describe("registryProblems: a fixed issue cannot linger", () => {
  const rule = (id: string): KnownIssue => ({ id, targets: ["avro"], disposition: "sibling", owner: "x", issue: "i", diagnostic: { code: "c", message: /m/ } });

  it("flags a rule that matched no case", () => {
    const problems = registryProblems([baseCase()], [{ caseId: "c1", target: "avro", kind: "PASS" }], [rule("fixed-one")]);
    expect(problems).toEqual(["known issue fixed-one no longer reproduces for any case: remove it from known-issues.ts"]);
  });

  it("a skipped validator tier excludes only the rules and entries that need it", () => {
    const registry: KnownIssue[] = [
      { ...rule("bq-only"), targets: ["bigquery"] }, { ...rule("java-only"), targets: ["java-pojo"] },
      { ...rule("mixed"), targets: ["java-pojo", "avro"] }, rule("stale-avro"),
    ];
    const outcomes = [
      { caseId: "c1", target: "bigquery" as const, kind: "PASS", tierSkipped: "bigquery" },
      { caseId: "c1", target: "avro" as const, kind: "FAIL", knownId: "mixed" },
    ];
    // bigquery tier skipped: its rule is not judged; java was not skipped, so java-only IS stale; mixed still reproduces; stale-avro is flagged
    expect(registryProblems([baseCase()], outcomes, registry).sort()).toEqual([
      "known issue java-only no longer reproduces for any case: remove it from known-issues.ts",
      "known issue stale-avro no longer reproduces for any case: remove it from known-issues.ts",
    ]);
    // the same outcomes without any skipped tier: the bigquery rule is flagged too (a full run is unchanged)
    const full = outcomes.map((o) => ({ ...o, tierSkipped: undefined }));
    expect(registryProblems([baseCase()], full, registry)).toHaveLength(3);
  });

  it("a skipped tier also excludes a per-case entry on that tier's target", () => {
    const c = baseCase({ expectedFailures: [{ target: "java-pojo", code: "k", message: /m/, reason: "r", issue: "i" }] });
    const skipped = [{ caseId: "c1", target: "java-pojo" as const, kind: "PASS", tierSkipped: "java" }];
    expect(registryProblems([c], skipped, [])).toEqual([]);
    expect(registryProblems([c], [{ caseId: "c1", target: "java-pojo" as const, kind: "PASS" }], [])).toHaveLength(1);
  });

  it("is quiet while a rule still explains a failure", () => {
    expect(registryProblems([baseCase()], [{ caseId: "c1", target: "avro", kind: "FAIL", knownId: "live" }], [rule("live")])).toEqual([]);
  });

  it("flags a per-case entry whose case now passes, naming case and target", () => {
    const c = baseCase({ expectedFailures: [{ target: "avro", code: "k", message: /m/, reason: "r", issue: "i" }] });
    const problems = registryProblems([c], [{ caseId: "c1", target: "avro", kind: "PASS" }], []);
    expect(problems).toEqual(["known issue k no longer reproduces for c1/avro: remove it from the case's expectedFailures"]);
    expect(registryProblems([c], [{ caseId: "c1", target: "avro", kind: "FAIL", knownId: "case-expectation" }], [])).toEqual([]);
  });

  it("a per-case entry that now fails with something else is flagged too (the other failure is its own problem)", () => {
    const c = baseCase({ expectedFailures: [{ target: "avro", code: "k", message: /m/, reason: "r", issue: "i" }] });
    expect(registryProblems([c], [{ caseId: "c1", target: "avro", kind: "FAIL" }], [])).toHaveLength(1);
  });

  it("the real registry has no rule without a diagnostic code and message", () => {
    for (const k of KNOWN_ISSUES) {
      expect(k.diagnostic.code.length, k.id).toBeGreaterThan(0);
      expect(k.diagnostic.message, k.id).toBeInstanceOf(RegExp);
    }
  });
});

describe("skipped work is a problem unless it is allowed", () => {
  const result = (targets: CaseResult["targets"]): CaseResult => ({ id: "c1", kind: "jsonschema", title: "t", build: { ok: true, entityCount: 1, fieldCount: 1, importWarnings: [] }, targets, expectationProblems: [], ms: 0 });

  it("a SKIPPED outcome (e.g. the budget) fails", () => {
    const r = result({ avro: { target: "avro", kind: "SKIPPED", reason: "global time budget exhausted", warnings: [] } });
    expect(problemsOf(r)[0]).toMatch(/avro: SKIPPED \(global time budget exhausted\) and the case does not allow it/);
    expect(problemsOf(r, { allowedSkips: [{ target: "avro", reason: "n/a" }] })).toEqual([]);
  });

  it("a validator tier that did not run fails, naming the tier and the opt-out", () => {
    const r = result({ spanner: { target: "spanner", kind: "PASS", warnings: [], tierSkipped: { tier: "spanner", reason: "spanner emulator not used (unreachable)" } } });
    expect(problemsOf(r)[0]).toMatch(/validator tier "spanner" did not run.*CORPUS_ALLOW_SKIP_TIERS=spanner/);
    expect(problemsOf(r, { allowSkipTiers: ["spanner"] })).toEqual([]);
    expect(problemsOf(r, { allowSkipTiers: ["bigquery"] })).toHaveLength(1);
  });

  it("reads the opt-out from the environment", () => {
    expect(allowedSkipTiersFromEnv({ CORPUS_ALLOW_SKIP_TIERS: "spanner, java" })).toEqual(["spanner", "java"]);
    expect(allowedSkipTiersFromEnv({})).toEqual([]);
  });
});

describe("the BigQuery emulator tier sends plain CREATE TABLE DDL only", () => {
  it.each([
    "CREATE TABLE d.t (a INT64)", "create table if not exists d.t (a INT64)", "CREATE OR REPLACE TABLE d.t (a INT64)",
    "-- c\nCREATE TABLE d.t (a INT64)", "/* c */ CREATE TABLE d.t (a INT64)",
    "CREATE TABLE d.t (a STRING OPTIONS(description='x AS SELECT; DROP TABLE y')) OPTIONS(description=\"copy of the view\")",
    "CREATE TABLE d.model (view STRING, copy STRING, `function` INT64)",
    "CREATE TABLE d.t (a INT64) /* AS SELECT */",
  ])("allows %s", (sql) => { expect(isAllowedBigQueryStatement(sql)).toBe(true); });
  it.each([
    "DROP TABLE d.t", "DROP SCHEMA d CASCADE", "DELETE FROM d.t WHERE TRUE", "INSERT INTO d.t VALUES (1)", "UPDATE d.t SET a = 1 WHERE TRUE",
    "MERGE d.t USING d.u ON TRUE WHEN MATCHED THEN DELETE", "TRUNCATE TABLE d.t", "SELECT 1", "ALTER TABLE d.t ADD COLUMN b STRING", "/* CREATE TABLE */ DROP TABLE d.t",
    "CREATE FUNCTION d.f() AS (1)", "CREATE OR REPLACE MODEL d.m OPTIONS()", "CREATE VIEW d.v AS SELECT 1", "CREATE PROCEDURE d.p() BEGIN SELECT 1; END",
    "CREATE EXTERNAL TABLE d.t OPTIONS(format='CSV')", "CREATE TABLE d.t AS SELECT 1 AS a", "CREATE TABLE d.t (a INT64) AS SELECT 1",
    "CREATE TABLE d.t CLONE d.u", "CREATE TABLE d.t COPY d.u", "CREATE TABLE d.t LIKE d.u", "CREATE SNAPSHOT TABLE d.t CLONE d.u",
  ])("refuses %s", (sql) => { expect(isAllowedBigQueryStatement(sql)).toBe(false); });
});

describe("splitStatements", () => {
  it("drops -- and block comments, keeps ; inside quotes", () => {
    expect(splitStatements("-- head\nCREATE TABLE a (x STRING); /* a; b */ CREATE TABLE b (y STRING OPTIONS(description='p;q'));")).toEqual([
      "CREATE TABLE a (x STRING)", "CREATE TABLE b (y STRING OPTIONS(description='p;q'))",
    ]);
  });
  it("an unterminated block comment swallows the rest instead of leaking it", () => {
    expect(splitStatements("CREATE TABLE a (x STRING); /* DROP TABLE a;")).toEqual(["CREATE TABLE a (x STRING)"]);
  });
});
