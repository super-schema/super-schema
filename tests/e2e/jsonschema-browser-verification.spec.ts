/**
 * Browser verification of the JSON Schema import paths that had only unit / integration coverage, through the real UI:
 *
 *   1. "From URL": a SUCCESSFUL import over the real network path (public https host, DNS + SSRF checks, size limits), and the
 *      git-host refusal message of the default restricted mode. With `E2E_GIT_ANY_BASE_URL` (a second server started with
 *      SCHEMA_IMPORT_GIT_MODE=any) the refusal is gone and the server tries the fetch (it then fails on `gh`, which has no
 *      credentials for the fixture host, with a DIFFERENT message).
 *   2. A schema with unresolved external `$ref`s: dangling marker + low confidence on the review, entity DRAFT with an alert, JSON
 *      Schema AND OpenAPI keep the raw `$ref`, the publish dialog.
 *   3. The primary-key prompt on BigQuery, PostgreSQL and Spanner: dialog, choose, generation succeeds, key persisted (TypeSpec
 *      `@key`, the editor's KEY badge, no second prompt on another target).
 *   4. x-securityClassification: the level on every field in the editor.
 *   5. The syntax-highlighted paste box (CodeMirror tokens for JSON, coloured layer for TypeSpec).
 *
 * Screenshots go to /tmp/e2e-evidence/A. The successful URL import needs outbound https (skipped with a note when it is offline).
 * PREREQS: see helpers/auth.ts.
 */

import { mkdirSync } from "node:fs";
import { login } from "./helpers/auth-state";
import { test, expect } from "./helpers/fixtures";
import {
  createEntityFromReview,
  createUiWorkspace,
  generateTarget,
  openEditor,
  openSchemasTab,
  openWorkbench,
  pasteAndReview,
  readTypeSpecSource,
  ENABLED_TARGETS,
} from "./helpers/lifecycle";
import { fillWorkbenchPaste } from "./helpers/workbench";

const SHOTS = "/tmp/e2e-evidence/A";
mkdirSync(SHOTS, { recursive: true });
const shot = (page: import("@playwright/test").Page, name: string) => page.screenshot({ path: `${SHOTS}/${name}.png`, fullPage: true });
const label = (key: string) => ENABLED_TARGETS.find((t) => t.key === key)!.displayName;

const PUBLIC_SCHEMA_URL = "https://www.schemastore.org/bower.json";
const GIT_URL = "https://github.paypal.com/some-org/some-repo/blob/main/schema.json";

async function openUrlMode(page: import("@playwright/test").Page, productUrl: string) {
  await openWorkbench(page, productUrl);
  await page.getByRole("button", { name: "From URL", exact: true }).click();
  await expect(page.getByTestId("workbench-url-input")).toBeVisible();
}

test.describe("A1: From URL", () => {
  test("a successful import over the real https path ends in a created entity", { tag: ["@regression", "@external"] }, async ({ authedPage: page }) => {
    test.setTimeout(240_000);
    const online = await fetch(PUBLIC_SCHEMA_URL, { signal: AbortSignal.timeout(10_000) }).then((r) => r.ok, () => false);
    test.skip(!online, `${PUBLIC_SCHEMA_URL} is not reachable from this machine`);
    const { productUrl } = await createUiWorkspace(page, "a1");
    await openUrlMode(page, productUrl);
    await page.getByTestId("workbench-url-input").fill(PUBLIC_SCHEMA_URL);
    await page.getByTestId("workbench-url-fetch-button").click();
    await expect(page.getByTestId("workbench-url-error")).toHaveCount(0, { timeout: 60_000 });
    // A successful fetch goes straight to the review screen (single entity or the multi-model one).
    const reviewScreen = page.getByTestId("import-entity-details").or(page.getByRole("button", { name: /import \d+ asset/i }));
    await expect(reviewScreen).toBeVisible({ timeout: 90_000 });
    await shot(page, "A1-url-review");
    const reviewText = await page.locator("main").innerText();
    console.log(`URL import review: ${reviewText.replace(/\s+/g, " ").slice(0, 500)}`);
    // bower.json's own properties are `name`, `version`, `dependencies` ...
    const entityName = /Models \(\d+\)\n([^\n]+)\n/.exec(reviewText)?.[1]?.trim() ?? "Bower";
    const entityUrl = await createEntityFromReview(page, productUrl, entityName);
    expect(entityUrl).toMatch(/\/schemas\//);
    await expect(page.getByRole("heading", { name: new RegExp(entityName) }).first()).toBeVisible();
    await shot(page, "A1-url-entity");
  });

  test("restricted mode (default) refuses a git-host URL with the clear message", { tag: ["@regression"] }, async ({ authedPage: page }) => {
    test.setTimeout(120_000);
    const { productUrl } = await createUiWorkspace(page, "a1r");
    await openUrlMode(page, productUrl);
    await page.getByTestId("workbench-url-input").fill(GIT_URL);
    await page.getByTestId("workbench-url-fetch-button").click();
    const error = page.getByTestId("workbench-url-error");
    await expect(error).toBeVisible({ timeout: 60_000 });
    await expect(error).toContainText(/is not enabled on this server/i);
    await expect(error).toContainText("SCHEMA_IMPORT_GIT_SCOPES");
    await expect(error).toContainText("some-org/some-repo");
    await shot(page, "A1-git-refused-restricted");
    await expect(page.getByTestId("workbench-url-fetch-button")).toBeEnabled();
  });
});

test.describe("A1: git mode any (second server)", () => {
  const anyBase = process.env.E2E_GIT_ANY_BASE_URL;
  test.skip(!anyBase, "set E2E_GIT_ANY_BASE_URL to a server started with SCHEMA_IMPORT_GIT_MODE=any");
  // Another server is another session: the saved login belongs to the first one (a session cookie is not scoped to a port, and its
  // signature is that server's), so this test starts logged out and logs in on the second server itself.
  test.use({ baseURL: anyBase, storageState: { cookies: [], origins: [] } });

  test("the refusal is gone: the server tries the fetch and fails on the host, not on the policy", { tag: ["@regression", "@external"] }, async ({ page }) => {
    test.setTimeout(180_000);
    await login(page);
    const { productUrl } = await createUiWorkspace(page, "a1a");
    await openUrlMode(page, productUrl);
    await page.getByTestId("workbench-url-input").fill(GIT_URL);
    await page.getByTestId("workbench-url-fetch-button").click();
    const error = page.getByTestId("workbench-url-error");
    await expect(error).toBeVisible({ timeout: 90_000 });
    await expect(error).not.toContainText(/is not enabled on this server/i);
    await expect(error).not.toContainText("SCHEMA_IMPORT_GIT_SCOPES");
    await shot(page, "A1-git-any-attempted");
    console.log(`git mode any message: ${(await error.innerText()).trim()}`);
  });
});

test.describe("A2: unresolved external $ref", () => {
  const SCHEMA = JSON.stringify({
    $schema: "https://json-schema.org/draft/2020-12/schema",
    title: "Remitter",
    type: "object",
    properties: {
      remitter_id: { type: "string" },
      amount: { $ref: "common/v4/money.json" },
      address: { $ref: "https://schemas.example.invalid/common/address.json" },
    },
    required: ["remitter_id"],
  });

  test("dangling marker and low confidence on review, DRAFT + alert, $ref kept by JSON Schema and OpenAPI", { tag: ["@regression"] }, async ({ authedPage: page }) => {
    test.setTimeout(240_000);
    const { productUrl } = await createUiWorkspace(page, "a2");
    await pasteAndReview(page, productUrl, SCHEMA);
    await expect(page.getByTestId("import-entity-details")).toBeVisible({ timeout: 45_000 });
    await expect(page.getByTestId("parsed-field-dangling")).toHaveCount(2);
    const review = await page.locator("main").innerText();
    // Low confidence: the two dangling fields carry a rose badge with a percentage under 50.
    const lowBadges = page.locator("tbody .text-rose-400");
    await expect(lowBadges).toHaveCount(2);
    for (const pct of await lowBadges.allInnerTexts()) expect(Number.parseInt(pct, 10)).toBeLessThan(50);
    expect(review).toContain("common/v4/money.json");
    await shot(page, "A2-review-dangling");
    await createEntityFromReview(page, productUrl, "Remitter");

    // DRAFT badge and the alert.
    await expect(page.getByText("DRAFT", { exact: true }).first()).toBeVisible();
    await expect(page.getByTestId("entity-version-state")).toContainText(/never published/i);
    await page.locator("main").getByText(/^Alerts \(\d+\)$/).first().click();
    await expect(page.getByText(/2 unresolved references: .*money\.json.*address\.json/)).toBeVisible();
    await shot(page, "A2-alerts");
    await openEditor(page);

    await openSchemasTab(page);
    for (const key of ["json-schema", "openapi3"]) {
      const g = await generateTarget(page, label(key), { primaryKey: ["remitter_id"] });
      expect(g.error, `${key}: ${g.error}`).toBeUndefined();
      expect(g.code, `${key} keeps the raw $ref`).toContain("common/v4/money.json");
      expect(g.code, `${key} keeps the raw $ref`).toContain("https://schemas.example.invalid/common/address.json");
      await shot(page, `A2-${key}`);
    }

    // The entity is still a DRAFT after generating; the publish dialog is reachable and shows what it says.
    await page.getByTestId("tab-typespec").isVisible();
    await page.locator("main").getByText("Editor", { exact: true }).first().click();
    await expect(page.getByText("DRAFT", { exact: true }).first()).toBeVisible();
    await page.getByTestId("publish-entity-button").click();
    await expect(page.getByRole("dialog")).toBeVisible();
    await shot(page, "A2-publish-dialog");
    console.log(`publish dialog: ${(await page.getByRole("dialog").innerText()).replace(/\s+/g, " ").slice(0, 400)}`);
  });
});

test.describe("A3: primary-key prompt", () => {
  const SCHEMA = (title: string, key: string) =>
    JSON.stringify({
      $schema: "https://json-schema.org/draft/2020-12/schema",
      title,
      type: "object",
      properties: { [key]: { type: "string" }, amount: { type: "number" }, memo: { type: "string" } },
    });

  for (const key of ["bigquery", "postgresql", "spanner"]) {
    test(`${key}: dialog, choose a key, generation succeeds, the key is persisted`, { tag: ["@regression"] }, async ({ authedPage: page }) => {
      test.setTimeout(240_000);
      const { productUrl } = await createUiWorkspace(page, `a3${key.slice(0, 3)}`);
      const idField = "ledger_id";
      await pasteAndReview(page, productUrl, SCHEMA("Ledger", idField));
      await createEntityFromReview(page, productUrl, "Ledger");
      await openSchemasTab(page);

      await page.getByTestId("schemas-tab").locator("button").filter({ hasText: label(key) }).first().click();
      await page.getByTestId("schemas-tab").getByRole("button", { name: /^Generate$/ }).click();
      const dialog = page.getByTestId("primary-key-dialog");
      await expect(dialog).toBeVisible({ timeout: 60_000 });
      await expect(dialog).toContainText("needs a primary key");
      await shot(page, `A3-${key}-dialog`);
      // The `*_id` field is suggested (pre-checked); with nothing checked the button waits for a choice.
      const suggested = dialog.locator("label", { hasText: new RegExp(`^${idField}$`) }).locator("input");
      await expect(suggested).toBeChecked();
      await suggested.uncheck();
      await expect(dialog.getByRole("button", { name: /save key and generate/i })).toBeDisabled();
      await suggested.check();
      await dialog.getByRole("button", { name: /save key and generate/i }).click();
      await expect(dialog).toBeHidden({ timeout: 60_000 });
      await expect(page.locator('[data-sonner-toast][data-type="error"]')).toHaveCount(0);
      await expect(page.getByTestId("schemas-tab").locator("pre code")).toContainText(/PRIMARY KEY/i, { timeout: 60_000 });
      await shot(page, `A3-${key}-generated`);

      // Persisted on the entity: the TypeSpec source carries @key on the field, the editor shows KEY, a reload keeps both.
      const source = await readTypeSpecSource(page);
      expect(source).toMatch(new RegExp(`@key\\s+(?:@\\w+(?:\\([^)]*\\))?\\s+)*${idField}\\b`));
      await page.reload();
      await openEditor(page);
      await expect(page.getByText("KEY", { exact: true }).first()).toBeVisible();
      // ...and another key-hungry target does not ask again.
      await openSchemasTab(page);
      const other = ["bigquery", "postgresql", "spanner"].find((k) => k !== key)!;
      const g = await generateTarget(page, label(other));
      expect(g.error, g.error).toBeUndefined();
      expect(g.askedForKey).toBe(false);
      expect(g.code).toMatch(/PRIMARY KEY/i);
    });
  }
});

test.describe("A4: x-securityClassification", () => {
  const SCHEMA = JSON.stringify({
    $schema: "https://json-schema.org/draft/2020-12/schema",
    title: "Subscriber",
    type: "object",
    properties: {
      subscriber_id: { type: "string", "x-securityClassification": { data_class: "class3", data_category: "Intrinsic" } },
      email: { type: "string", "x-securityClassification": { data_class: "class4", data_category: "PayPalCompany" } },
      nickname: { type: "string" },
    },
    required: ["subscriber_id"],
  });

  test("the level of every field is shown on the review and in the editor", { tag: ["@regression"] }, async ({ authedPage: page }) => {
    test.setTimeout(240_000);
    const { productUrl } = await createUiWorkspace(page, "a4");
    await pasteAndReview(page, productUrl, SCHEMA);
    await expect(page.getByTestId("import-entity-details")).toBeVisible({ timeout: 45_000 });
    for (const f of ["subscriber_id", "email"]) await page.getByRole("button", { name: `Show import details of ${f}` }).click();
    const table = page.locator("tbody");
    await expect(table).toContainText("class3");
    await expect(table).toContainText("class4");
    await expect(table).toContainText("PayPalCompany");
    await expect(table).toContainText("Intrinsic");
    await shot(page, "A4-review");
    await createEntityFromReview(page, productUrl, "Subscriber");
    await expect(page.locator("main span", { hasText: /^class3$/ }).first()).toBeVisible();
    await expect(page.locator("main span", { hasText: /^class4$/ }).first()).toBeVisible();
    await shot(page, "A4-editor");
  });
});

test.describe("A5: syntax-highlighted paste box", () => {
  test("JSON is tokenised by CodeMirror and TypeSpec gets a coloured layer", { tag: ["@regression"] }, async ({ authedPage: page }) => {
    test.setTimeout(180_000);
    const { productUrl } = await createUiWorkspace(page, "a5");
    await openWorkbench(page, productUrl);
    await page.getByRole("button", { name: "Paste", exact: true }).click();
    const json = JSON.stringify({ title: "Hi", type: "object", properties: { n: { type: "integer", minimum: 1 } }, required: ["n"] }, null, 2);
    await fillWorkbenchPaste(page, json);
    const host = page.getByTestId("workbench-paste-textarea-editor");
    await expect(host).toHaveAttribute("data-editor", "codemirror");
    // Token spans of several colours: keys, strings, numbers, punctuation are not all one colour.
    const colours = await host.locator(".cm-content span").evaluateAll((els) => [...new Set(els.map((e) => getComputedStyle(e).color))]);
    expect(colours.length, `distinct token colours: ${colours.join(" ")}`).toBeGreaterThanOrEqual(3);
    await expect(host.locator(".cm-lineNumbers")).toBeVisible();
    await shot(page, "A5-json-highlighted");

    // TypeSpec: a textarea over a coloured layer.
    const tsp = 'import "@typespec/json-schema";\n\n@doc("An order")\nmodel Order {\n  id: string;\n  qty?: int32;\n}\n';
    await fillWorkbenchPaste(page, tsp);
    await expect(page.getByTestId("workbench-paste-textarea-editor")).toHaveCount(0);
    const layerColours = await page
      .locator("[aria-hidden=true] span, pre span")
      .evaluateAll((els) => [...new Set(els.map((e) => getComputedStyle(e).color))]);
    expect(layerColours.length, `TypeSpec layer colours: ${layerColours.join(" ")}`).toBeGreaterThanOrEqual(2);
    await shot(page, "A5-typespec-highlighted");
  });
});
