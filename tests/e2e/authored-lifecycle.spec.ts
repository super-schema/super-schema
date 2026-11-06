/**
 * Entities AUTHORED in the app (not imported from a JSON Schema document) through the real UI, each taken through
 * create -> generate EVERY target -> edit in SuperSchema -> inspect read-only Source -> regenerate:
 *
 *   1. Start Blank: fields added one by one in the wizard preview.
 *   2. Build form (JSON Schema visual editor): title, properties, types, required.
 *   3. TypeSpec pasted (decorators, an enum, an entity extension): the multi-model review.
 *   4. A blank entity whose fields are reflected in read-only Source.
 *
 * Artifacts and a step table are written to <E2E_EVIDENCE_DIR>/authored (one directory per run: helpers/evidence.ts). Steps are independent where they can be (a failed step is
 * recorded, the next still runs); the test fails with every failed step listed.
 */

import { mkdirSync, writeFileSync } from "node:fs";
import { test, expect } from "./helpers/fixtures";
import { canon } from "./helpers/artifact-text";
import {
  ENABLED_TARGETS,
  createEntityFromReview,
  createUiWorkspace,
  generateAllTargets,
  generateTarget,
  openEditor,
  openEntityFromProduct,
  openSchemasTab,
  openWorkbench,
  pasteAndReview,
  readTypeSpecSource,
  renameField,
  type Generated,
} from "./helpers/lifecycle";
import { evidenceDir } from "./helpers/evidence";

const EVIDENCE = evidenceDir("authored");

interface StepResult {
  step: string;
  pass: boolean;
  detail?: string;
}

function recorder(id: string) {
  const results: StepResult[] = [];
  mkdirSync(`${EVIDENCE}/${id}`, { recursive: true });
  const step = async (name: string, fn: () => Promise<void>, fatal = false) => {
    try {
      await test.step(name, fn);
      results.push({ step: name, pass: true });
    } catch (e) {
      results.push({ step: name, pass: false, detail: String(e instanceof Error ? e.message : e).split("\n").slice(0, 6).join(" | ") });
      if (fatal) throw e;
    }
  };
  const finish = async (page: import("@playwright/test").Page, fatal: unknown) => {
    writeFileSync(`${EVIDENCE}/${id}.json`, JSON.stringify({ id, results }, null, 2));
    await page.screenshot({ path: `${EVIDENCE}/${id}.png`, fullPage: true }).catch(() => undefined);
    const failed = results.filter((r) => !r.pass);
    expect(failed.map((r) => `${r.step}: ${r.detail ?? ""}`), fatal ? String(fatal) : "").toEqual([]);
  };
  const save = (name: string, g: Generated | undefined) => writeFileSync(`${EVIDENCE}/${id}/${name}.txt`, g ? g.code || `ERROR: ${g.error}` : "(none)");
  return { step, finish, save };
}

/** The common tail: every target, content checks, rename, read-only Source inspection, regenerate. */
async function lifecycleFromOpenEntity(
  page: import("@playwright/test").Page,
  r: ReturnType<typeof recorder>,
  v: {
    entity: string;
    primaryKey: string[];
    jsonSchema: string[];
    rename: [string, string];
  },
) {
  const outputs = new Map<string, Generated>();
  await r.step("generate every target", async () => {
    await openSchemasTab(page);
    const all = await generateAllTargets(page, v.entity, { primaryKey: v.primaryKey });
    for (const [k, g] of all.outputs) {
      outputs.set(k, g);
      r.save(k, g);
    }
    expect(all.problems, all.problems.join("\n")).toEqual([]);
  });
  await r.step("json-schema / openapi content", async () => {
    const js = outputs.get("json-schema");
    const oa = outputs.get("openapi3");
    expect(js && !js.error, "json-schema generated").toBeTruthy();
    for (const s of v.jsonSchema) expect(canon(js!.code), `JSON Schema has ${s}`).toContain(s);
    expect(oa && !oa.error, "openapi3 generated").toBeTruthy();
    for (const s of v.jsonSchema) expect(canon(oa!.code), `OpenAPI has ${s}`).toContain(s);
  });
  const [from, to] = v.rename;
  await r.step("edit field (rename) + regenerate", async () => {
    await openEditor(page);
    await renameField(page, from, to);
    await openSchemasTab(page);
    const g = await generateTarget(page, ENABLED_TARGETS.find((t) => t.key === "json-schema")!.displayName, { primaryKey: v.primaryKey });
    r.save("json-schema-after-rename", g);
    expect(g.error, g.error).toBeUndefined();
    expect(canon(g.code)).toContain(`"${to}"`);
    expect(canon(g.code)).not.toContain(`"${from}"`);
  });
  await r.step("read-only Source reflects SuperSchema edits + regenerate", async () => {
    const source = await readTypeSpecSource(page);
    writeFileSync(`${EVIDENCE}/source-${v.entity}.tsp`, source);
    expect(source).toContain(`model ${v.entity}`);
    expect(source).toContain(to);
    await openSchemasTab(page);
    for (const key of ["json-schema", "openapi3"]) {
      const g = await generateTarget(page, ENABLED_TARGETS.find((t) => t.key === key)!.displayName, { primaryKey: v.primaryKey });
      r.save(`${key}-after-source-view`, g);
      expect(g.error, g.error).toBeUndefined();
      expect(canon(g.code)).toContain(`"${to}"`);
      for (const value of v.jsonSchema) expect(canon(g.code)).toContain(value === from ? to : value);
    }
  });
}

test.describe("authored entities: full lifecycle through the UI", () => {
  test("Start Blank: fields added in the wizard", { tag: ["@regression"] }, async ({ authedPage: page }) => {
    test.setTimeout(420_000);
    const r = recorder("blank");
    let fatal: unknown;
    try {
      let productUrl = "";
      await r.step("workspace", async () => {
        productUrl = (await createUiWorkspace(page, "au-blank")).productUrl;
      }, true);
      await r.step("start blank + add fields + create", async () => {
        await page.goto(`${productUrl.replace(/\/+$/, "")}/new`);
        await page.getByRole("button", { name: /start blank/i }).first().click();
        await page.getByPlaceholder("EntityName").fill("Shipment");
        // The add row stays open after Enter, ready for the next name.
        await page.getByRole("button", { name: "Add Field", exact: true }).click();
        for (const name of ["shipment_id", "carrier", "weight_kg"]) {
          await page.getByPlaceholder("field_name").fill(name);
          await page.getByPlaceholder("field_name").press("Enter");
          await expect(page.locator(`input[value="${name}"]`).first()).toBeVisible();
        }
        await page.getByRole("button", { name: /create entity/i }).click();
        // A blank entity returns to the product page; open its card.
        await expect(page).not.toHaveURL(/\/new$/, { timeout: 30_000 });
        await openEntityFromProduct(page, productUrl, "Shipment");
        await expect(page.getByRole("heading", { name: "Fields (3)" })).toBeVisible();
      }, true);
      await lifecycleFromOpenEntity(page, r, {
        entity: "Shipment",
        primaryKey: ["shipment_id"],
        jsonSchema: ["shipment_id", "carrier", "weight_kg"],
        rename: ["carrier", "carrier_name"],
      });
    } catch (e) {
      fatal = e;
    }
    await r.finish(page, fatal);
  });

  test("Build form: JSON Schema visual editor", { tag: ["@regression"] }, async ({ authedPage: page }) => {
    test.setTimeout(420_000);
    const r = recorder("build-form");
    let fatal: unknown;
    try {
      let productUrl = "";
      await r.step("workspace", async () => {
        productUrl = (await createUiWorkspace(page, "au-form")).productUrl;
      }, true);
      await r.step("build form -> review -> create", async () => {
        await openWorkbench(page, productUrl);
        await page.getByRole("button", { name: "Build form", exact: true }).click();
        const editor = page.getByTestId("jsonschema-visual-editor");
        await expect(editor).toBeVisible();
        await editor.locator("label", { hasText: "Schema title" }).locator("xpath=following-sibling::input").fill("CatalogItem");
        const rows: Array<[string, string, boolean]> = [
          ["sku", "string", true],
          ["quantity", "integer", true],
          ["price", "number", false],
          ["discontinued", "boolean", false],
        ];
        for (let i = 0; i < rows.length; i += 1) {
          if (i > 0) await editor.getByRole("button", { name: /add property/i }).click();
          const [name, type, required] = rows[i];
          const input = editor.getByPlaceholder("propertyName").nth(i);
          await input.fill(name);
          await input.locator("xpath=following-sibling::select[1]").selectOption(type);
          if (required) await input.locator("xpath=following-sibling::label//input").check();
        }
        // The Detail Panel shows the schema the form wrote.
        await expect(page.getByTestId("detail-panel")).toContainText("quantity");
        await page.getByTestId("workbench-review-button").click();
        await createEntityFromReview(page, productUrl, "CatalogItem");
        await expect(page.getByRole("heading", { name: "Fields (4)" })).toBeVisible({ timeout: 30_000 });
      }, true);
      await lifecycleFromOpenEntity(page, r, {
        entity: "CatalogItem",
        primaryKey: ["sku"],
        jsonSchema: ["sku", "quantity", "price", "discontinued"],
        rename: ["price", "unit_price"],
      });
    } catch (e) {
      fatal = e;
    }
    await r.finish(page, fatal);
  });

  test("TypeSpec pasted: decorators, an enum and an entity extension", { tag: ["@regression"] }, async ({ authedPage: page }) => {
    test.setTimeout(420_000);
    const r = recorder("typespec-paste");
    let fatal: unknown;
    const TSP = [
      'import "@typespec/openapi";',
      'import "@typespec/json-schema";',
      "",
      "enum Tier { free, pro, enterprise }",
      "",
      '@TypeSpec.JsonSchema.extension("x-team", "growth")',
      '@TypeSpec.OpenAPI.extension("x-team", "growth")',
      "model Subscription {",
      "  @key id: string;",
      "  @minLength(3) @maxLength(40) plan_name: string;",
      '  @doc("Seats purchased") @minValue(1) @maxValue(500) seats: int32;',
      "  tier: Tier;",
      "  trial_ends?: utcDateTime;",
      "}",
      "",
    ].join("\n");
    try {
      let productUrl = "";
      await r.step("workspace", async () => {
        productUrl = (await createUiWorkspace(page, "au-tsp")).productUrl;
      }, true);
      await r.step("paste TypeSpec -> review -> import", async () => {
        await pasteAndReview(page, productUrl, TSP);
        await expect(page.locator("main")).toContainText("Subscription", { timeout: 45_000 });
        await createEntityFromReview(page, productUrl, "Subscription");
        await expect(page.getByRole("heading", { name: /^Fields \(\d+\)$/ })).toBeVisible({ timeout: 30_000 });
      }, true);
      await lifecycleFromOpenEntity(page, r, {
        entity: "Subscription",
        primaryKey: ["id"],
        // The enum `Tier` is NOT asserted: a TypeSpec-imported enum-typed field becomes a plain string (open issue, see the report).
        jsonSchema: ["plan_name", "seats", "x-team", "growth"],
        rename: ["plan_name", "plan"],
      });
    } catch (e) {
      fatal = e;
    }
    await r.finish(page, fatal);
  });

  test("blank entity fields appear in read-only Source", { tag: ["@regression"] }, async ({ authedPage: page }) => {
    test.setTimeout(420_000);
    const r = recorder("typespec-tab");
    let fatal: unknown;
    try {
      let productUrl = "";
      await r.step("workspace", async () => {
        productUrl = (await createUiWorkspace(page, "au-tab")).productUrl;
      }, true);
      await r.step("start blank with two fields", async () => {
        await page.goto(`${productUrl.replace(/\/+$/, "")}/new`);
        await page.getByRole("button", { name: /start blank/i }).first().click();
        await page.getByPlaceholder("EntityName").fill("Reading");
        await page.getByRole("button", { name: "Add Field", exact: true }).click();
        await page.getByPlaceholder("field_name").fill("reading_id");
        await page.getByPlaceholder("field_name").press("Enter");
        await page.getByRole("button", { name: "Add Field", exact: true }).click();
        await page.getByPlaceholder("field_name").fill("note");
        await page.getByPlaceholder("field_name").press("Enter");
        await page.getByRole("button", { name: /create entity/i }).click();
        await expect(page).not.toHaveURL(/\/new$/, { timeout: 30_000 });
        await openEntityFromProduct(page, productUrl, "Reading");
      }, true);
      await r.step("inspect read-only Source", async () => {
        const source = await readTypeSpecSource(page);
        expect(source).toContain("model Reading");
        expect(source).toContain("reading_id");
        expect(source).toContain("note");
      });
      await lifecycleFromOpenEntity(page, r, {
        entity: "Reading",
        primaryKey: ["reading_id"],
        jsonSchema: ["reading_id", "note"],
        rename: ["note", "comment"],
      });
    } catch (e) {
      fatal = e;
    }
    await r.finish(page, fatal);
  });
});
