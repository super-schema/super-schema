/**
 * Full lifecycle of a table of JSON Schema variations through the real UI (table: fixtures/jsonschema-variations.ts):
 *
 *   paste -> Load -> review screen content -> create entity -> open entity -> generate EVERY target of the catalog (answering the
 *   primary-key dialog) -> content checks (JSON Schema / OpenAPI: extensions, required, enum values, formats) -> rename a field in
 *   the editor -> regenerate -> edit the TypeSpec source and Save (sync) -> regenerate -> extensions / classification survived.
 *
 * Each variation is one independent test (own domain + product). A step failing is recorded and the next steps still run
 * where they can, so the matrix (written to /tmp/e2e-evidence/lifecycle/<id>.json) shows every broken step at once.
 * Known, accepted open defects are declared per target in the table and REQUIRED to fail (a stale expectation fails the test).
 *
 * Corpus-level validity of the generated text (JSON Schema meta-schema, Avro parse, DDL on emulators) is
 * tests/integration/corpus; this spec is about the UI path and about what the artifacts say.
 *
 * PREREQS: see helpers/auth.ts. Against a running server: `E2E_BASE_URL=http://localhost:3107 npx playwright test tests/e2e/jsonschema-lifecycle.spec.ts`.
 * Cleanup of the created domains needs DATABASE_URL (see helpers/db.ts); on PGlite they stay (use a throw-away data dir).
 */

import { mkdirSync, writeFileSync } from "node:fs";
import { test, expect } from "./helpers/fixtures";
import { canon, requiredOf } from "./helpers/artifact-text";
import { deleteDomainsByName, disconnectDb } from "./helpers/db";
import {
  ENABLED_TARGETS,
  createEntityFromReview,
  createWorkspace,
  errorToast,
  generateTarget,
  openEditor,
  openSchemasTab,
  pasteAndReview,
  readTypeSpecSource,
  renameField,
  saveTypeSpecSource,
  fieldName,
  type Generated,
} from "./helpers/lifecycle";
import { VARIATIONS, type Variation } from "./fixtures/jsonschema-variations";

const EVIDENCE = "/tmp/e2e-evidence/lifecycle";
const norm = (s: string) => s.toLowerCase().replace(/[^a-z0-9]/g, "");

// `canon` (compact JSON of the artifact) and `requiredOf` (the entity's `required` list) read a multi-file artifact file by file:
// helpers/artifact-text.ts, unit tested in tests/unit/e2e-helpers.

interface StepResult {
  step: string;
  pass: boolean;
  detail?: string;
}

async function lifecycle(page: import("@playwright/test").Page, v: Variation, results: StepResult[], domains: string[]) {
  const step = async (name: string, fn: () => Promise<void>, fatal = false) => {
    try {
      await test.step(name, fn);
      results.push({ step: name, pass: true });
    } catch (e) {
      results.push({ step: name, pass: false, detail: String(e instanceof Error ? e.message : e).split("\n").slice(0, 6).join(" | ") });
      if (fatal) throw e;
    }
  };

  let productUrl = "";
  await step(
    "workspace",
    async () => {
      const ws = await createWorkspace(page, `lc-${v.id.slice(0, 8)}`);
      domains.push(ws.domain);
      productUrl = ws.productUrl;
    },
    true,
  );

  await step(
    "import+review",
    async () => {
      await pasteAndReview(page, productUrl, v.text);
      if (v.kind === "multi") {
        await expect(page.getByRole("button", { name: /import \d+ asset/i })).toBeVisible({ timeout: 45_000 });
        for (const name of v.review) await expect(page.locator("main")).toContainText(name);
        return;
      }
      await expect(page.getByTestId("import-entity-details")).toBeVisible({ timeout: 45_000 });
      // Expand every field's import details so preserved extensions and classifications are in the DOM.
      const toggles = page.getByRole("button", { name: /^Show import details of / });
      const n = await toggles.count();
      for (let i = 0; i < n; i += 1) await toggles.nth(0).click().catch(() => undefined);
      const text = await page.locator("main").innerText();
      for (const s of v.review) expect(text, `review shows ${s}`).toContain(s);
      if (v.dangling !== undefined) await expect(page.getByTestId("parsed-field-dangling")).toHaveCount(v.dangling);
    },
    true,
  );

  await step(
    "create+open entity",
    async () => {
      await createEntityFromReview(page, productUrl, v.entityName);
    },
    true,
  );

  const outputs = new Map<string, Generated>();
  await step(
    "generate every target",
    async () => {
      await openSchemasTab(page);
      const problems: string[] = [];
      for (const t of ENABLED_TARGETS) {
        const g = await generateTarget(page, t.displayName, { primaryKey: v.primaryKey });
        outputs.set(t.key, g);
        const known = v.known?.[t.key as keyof NonNullable<Variation["known"]>];
        if (known) {
          if (!g.error) problems.push(`${t.key}: known defect "${known.why}" no longer reproduces: remove it from the table`);
          else if (!known.match.test(g.error)) problems.push(`${t.key}: known defect expected /${known.match.source}/ but got: ${g.error.slice(0, 200)}`);
          continue;
        }
        if (g.error) {
          problems.push(`${t.key}: ${g.error.slice(0, 300)}`);
          continue;
        }
        if (g.code.trim().length < 40) problems.push(`${t.key}: output is empty or trivial (${g.code.length} chars)`);
        else if (!norm(g.code).includes(norm(v.entityName).slice(0, 24))) problems.push(`${t.key}: output never names the entity ${v.entityName}`);
      }
      mkdirSync(`${EVIDENCE}/${v.id}`, { recursive: true });
      for (const [k, g] of outputs) writeFileSync(`${EVIDENCE}/${v.id}/${k}.txt`, g.code || `ERROR: ${g.error}`);
      expect(problems, problems.join("\n")).toEqual([]);
    },
    false,
  );

  const jsonSchema = () => outputs.get("json-schema");
  const openapi = () => outputs.get("openapi3");

  await step("json-schema content", async () => {
    const g = jsonSchema();
    if (v.known?.["json-schema"]) return; // documented defect: nothing generated to read (the generate step requires the failure)
    expect(g && !g.error, "json-schema generated").toBeTruthy();
    for (const s of v.jsonSchema) expect(canon(g!.code), `JSON Schema has ${s}`).toContain(s);
    if (v.required) {
      const req = requiredOf(g!.code, v.entityName);
      expect(req, "JSON Schema has a required list").not.toBeNull();
      for (const r of v.required) expect(req, `required has ${r}`).toContain(r);
    }
  });
  await step("openapi content", async () => {
    const g = openapi();
    if (v.known?.openapi3) return;
    expect(g && !g.error, "openapi3 generated").toBeTruthy();
    for (const s of v.openapi) expect(canon(g!.code), `OpenAPI has ${s}`).toContain(s);
    if (v.required) {
      const req = requiredOf(g!.code, v.entityName);
      expect(req, "OpenAPI has a required list").not.toBeNull();
      for (const r of v.required) expect(req, `required has ${r}`).toContain(r);
    }
  });

  const [from, to] = v.rename;
  await step("edit field (rename) + regenerate", async () => {
    await openEditor(page);
    await renameField(page, from, to);
    await expect(errorToast(page)).toHaveCount(0);
    await openSchemasTab(page);
    const target = ENABLED_TARGETS.find((t) => t.key === "json-schema")!;
    const g = await generateTarget(page, target.displayName, { primaryKey: v.primaryKey });
    if (v.known?.["json-schema"]) {
      expect(g.error, "json-schema still has its known defect").toMatch(v.known["json-schema"]!.match);
      return;
    }
    writeFileSync(`${EVIDENCE}/${v.id}/json-schema-after-rename.txt`, g.code || `ERROR: ${g.error}`);
    expect(g.error, g.error).toBeUndefined();
    expect(canon(g.code)).toContain(`"${to}"`);
    expect(canon(g.code)).not.toContain(`"${from}"`);
    // The sibling DDL target sees the same rename.
    const pg = ENABLED_TARGETS.find((t) => t.key === "postgresql")!;
    const d = await generateTarget(page, pg.displayName, { primaryKey: v.primaryKey?.map((k) => (k === from ? to : k)) });
    if (!v.known?.postgresql) {
      expect(d.error, d.error).toBeUndefined();
      expect(norm(d.code)).toContain(norm(to));
    }
  });

  await step("typespec source edit + sync + regenerate", async () => {
    const source = await readTypeSpecSource(page);
    expect(source).toContain(`model ${v.entityName}`);
    expect(source).toContain(to); // the rename reached the canonical source
    const edited = source.replace(new RegExp(`(model ${v.entityName}[^{]*\\{[^\\n]*\\n)`), "$1  e2e_added?: string;\n");
    expect(edited).not.toBe(source);
    mkdirSync(`${EVIDENCE}/${v.id}`, { recursive: true });
    writeFileSync(`${EVIDENCE}/${v.id}/typespec-before-sync.tsp`, edited);
    const saved = await saveTypeSpecSource(page, edited);
    if (v.knownSync) {
      expect(saved.ok, `known defect "${v.knownSync.why}" no longer reproduces: remove knownSync from the table`).toBe(false);
      await expect(page.locator("main")).toContainText(v.knownSync.match);
      return;
    }
    expect(saved.ok, saved.message).toBe(true);
    await openEditor(page);
    await expect(fieldName(page, "e2e_added")).toBeVisible({ timeout: 30_000 });
    writeFileSync(`${EVIDENCE}/${v.id}/typespec-after-sync.tsp`, await readTypeSpecSource(page));
    await openEditor(page);
    await openSchemasTab(page);
    const target = ENABLED_TARGETS.find((t) => t.key === "json-schema")!;
    const g = await generateTarget(page, target.displayName, { primaryKey: v.primaryKey });
    if (v.known?.["json-schema"]) return;
    writeFileSync(`${EVIDENCE}/${v.id}/json-schema-after-sync.txt`, g.code || `ERROR: ${g.error}`);
    expect(g.error, g.error).toBeUndefined();
    expect(g.code).toContain("e2e_added");
    for (const s of v.survives) expect(canon(g.code), `after the sync the JSON Schema still has ${s}`).toContain(s);
    const o = await generateTarget(page, ENABLED_TARGETS.find((t) => t.key === "openapi3")!.displayName, { primaryKey: v.primaryKey });
    expect(o.error, o.error).toBeUndefined();
    expect(o.code).toContain("e2e_added");
  });
}

test.describe("JSON Schema variations: full lifecycle through the UI", () => {
  const domains: string[] = [];

  test.afterAll(async () => {
    try {
      await deleteDomainsByName(domains);
    } catch (error) {
      console.warn(`jsonschema-lifecycle cleanup skipped for ${domains.length} domains: ${String(error).slice(0, 120)}`);
    } finally {
      await disconnectDb().catch(() => undefined);
    }
  });

  for (const v of VARIATIONS) {
    test(`${v.id}: ${v.title}`, { tag: ["@regression", "@slow"] }, async ({ authedPage: page }) => {
      test.setTimeout(420_000);
      const results: StepResult[] = [];
      let fatal: unknown;
      try {
        await lifecycle(page, v, results, domains);
      } catch (e) {
        fatal = e;
      }
      mkdirSync(EVIDENCE, { recursive: true });
      writeFileSync(`${EVIDENCE}/${v.id}.json`, JSON.stringify({ id: v.id, title: v.title, results }, null, 2));
      await page.screenshot({ path: `${EVIDENCE}/${v.id}.png`, fullPage: true }).catch(() => undefined);
      const failed = results.filter((r) => !r.pass);
      expect(failed.map((r) => `${r.step}: ${r.detail ?? ""}`), fatal ? String(fatal) : "").toEqual([]);
    });
  }
});
