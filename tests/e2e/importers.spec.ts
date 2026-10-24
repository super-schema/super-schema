/**
 * The importers, one test each, through the real UI of the new-entity page ("Create New Entity" of a product), end to end:
 *
 *   import (paste, or the file input of the Drop zone) -> the review screen shows what was parsed (entities, fields, types, the
 *   confidence of each mapping, what was ignored or preserved) -> create -> open the entity -> generate ONE target (a different one
 *   for each importer) and read the artifact back for a marker of its format.
 *
 *   Avro        record with logical types, a union with null, an array, a map and an enum        -> Protobuf
 *   Protobuf    a message with a nested message, an enum, repeated, map and oneof                -> Avro
 *   OpenAPI     components.schemas with $ref and allOf                                          -> Java POJO
 *   BigQuery    CREATE TABLE with STRUCT / ARRAY / NUMERIC / TIMESTAMP and column descriptions   -> PostgreSQL DDL
 *   TypeSpec    two models in one file: the multi-entity review                                  -> OpenAPI 3
 *   JSON file   dropped on the Drop zone (JSON Schema with keywords the app ignores)             -> JSON Schema
 *   Standards   a template of the Standards Library                                              -> Spanner DDL
 *   Natural Language   AI is not configured on a release run: the page says so and nothing can be sent
 *
 * The sample documents are tests/e2e/fixtures/importer-samples (tests/unit/e2e-helpers/importer-samples.test.ts keeps them
 * importable). Each test has a workspace of its own (a domain and a product, made in the database and removed afterwards).
 * The content of the artifacts is checked for what the import must have carried over, not for the whole text: the emitters have
 * their own tests (tests/integration/corpus), this is about the path through the UI.
 */
import { readFileSync } from "node:fs";
import path from "node:path";
import { test, expect } from "./helpers/fixtures";
import { centerPanel } from "./helpers/event-builder";
import { canon, requiredOf } from "./helpers/artifact-text";
import {
  createEntityFromReview,
  createSingleEntity,
  dropFileAndReview,
  generateTarget,
  openEntityFromProduct,
  openSchemasTab,
  openWorkbench,
  pasteAndReview,
} from "./helpers/lifecycle";
import { fillWorkbenchPaste } from "./helpers/workbench";

const SAMPLES = path.join(__dirname, "fixtures/importer-samples");
const samplePath = (name: string) => path.join(SAMPLES, name);
const sample = (name: string) => readFileSync(samplePath(name), "utf8");

/** Test ids of the review screens (src/components/custom/ImportDialog, EntityCreationWizard) and of the creation methods. */
const ID = {
  multiReview: "typespec-import-review",
  multiTitle: "import-review-title",
  multiCounts: "import-review-counts",
  multiConfirm: "import-review-confirm",
  model: (name: string) => `import-model-${name}`,
  modelToggle: (name: string) => `import-model-toggle-${name}`,
  field: (model: string, field: string) => `import-field-${model}-${field}`,
  enum: (name: string) => `import-enum-${name}`,
  entityDetails: "import-entity-details",
  entityName: "wizard-entity-name",
  fieldRow: "wizard-field-row",
  fieldName: "wizard-field-name",
  warnings: "import-warnings",
  createEntity: "wizard-create-entity",
  fieldDetails: (name: string) => `parsed-field-details-${name}`,
  fieldIgnored: "parsed-field-ignored",
  fieldUsed: "parsed-field-used",
  fieldConfidence: "parsed-field-confidence",
  entityIgnored: "parsed-entity-ignored",
  sourceFormat: "parsed-entity-source-format",
  importSummary: "workbench-import-summary",
  creationMethod: (name: "standards" | "natural-language" | "schema" | "blank") => `creation-method-${name}`,
  standardsSearch: "standards-search",
  standardsTemplate: "standards-template",
  nlNotConfigured: "nl-ai-not-configured",
  nlDescription: "nl-description",
  nlGenerate: "nl-generate",
  modePaste: "workbench-mode-paste",
  loadButton: "workbench-load-button",
  reviewButton: "workbench-review-button",
  wizardError: "wizard-error",
} as const;

/** Open the entity page of what the import created and the Schemas tab. */
async function openSchemasOf(page: import("@playwright/test").Page, entityUrl: string): Promise<void> {
  await page.goto(entityUrl);
  await openSchemasTab(page);
}

test.describe("importers", () => {
  test("Avro: the record, its enum, the logical types and the union with null are reviewed, created, and generate Protobuf", { tag: ["@regression"] }, async ({
    authedPage: page,
    workspace,
  }) => {
    test.setTimeout(240_000);
    const main = centerPanel(page);
    await pasteAndReview(page, workspace.productUrl, sample("order-placed.avsc"));

    const review = main.getByTestId(ID.multiReview);
    await expect(review).toBeVisible({ timeout: 45_000 });
    await expect(review.getByTestId(ID.multiTitle)).toHaveText("Review Avro Import");
    await expect(review.getByTestId(ID.multiCounts)).toContainText("1 model(s), 1 enum(s), 0 scalar(s)");
    // The record, with its eight fields as the importer typed them (logical types become the matching temporal / decimal types).
    await review.getByTestId(ID.modelToggle("OrderPlaced")).click();
    const model = review.getByTestId(ID.model("OrderPlaced"));
    await expect(model).toContainText("8 fields");
    await expect(model).toContainText("An order was placed by a customer.");
    const types: Record<string, string> = {
      orderId: "string",
      placedAt: "utcDateTime",
      shipDate: "plainDate",
      total: "decimal",
      couponCode: "string",
      lineSkus: "array",
      labels: "map",
      status: "enum",
    };
    for (const [name, type] of Object.entries(types)) {
      await expect(review.getByTestId(ID.field("OrderPlaced", name)), name).toContainText(type);
    }
    // A required field says so; the union with null is nullable (no "required" badge).
    await expect(review.getByTestId(ID.field("OrderPlaced", "orderId"))).toContainText("required");
    await expect(review.getByTestId(ID.field("OrderPlaced", "couponCode"))).not.toContainText("required");
    // Every mapping states its confidence; the enum is reviewed with its symbols.
    await review.getByRole("button", { name: "Show details of OrderPlaced.placedAt" }).click();
    await expect(review.getByTestId(ID.fieldDetails("placedAt")).getByTestId(ID.fieldConfidence)).toContainText("High confidence");
    await expect(review.getByTestId(ID.enum("OrderStatus"))).toContainText("NEW, PAID, SHIPPED");

    const entityUrl = await createEntityFromReview(page, workspace.productUrl, "OrderPlaced");
    await openSchemasOf(page, entityUrl);
    const protobuf = await generateTarget(page, "Protobuf (TypeSpec)");
    expect(protobuf.error).toBeUndefined();
    expect(protobuf.code).toMatch(/message OrderPlaced\s*\{/);
    expect(protobuf.code).toContain('syntax = "proto3"');
    // The array became repeated, the optional union stayed optional, the map a map.
    expect(protobuf.code).toMatch(/repeated\s+string\s+\w*[Ss]ku/);
    expect(protobuf.code).toMatch(/map<string,\s*string>\s+labels/);
  });

  test("Protobuf: the message, its nested message, the enum, repeated, map and oneof are reviewed, created, and generate Avro", { tag: ["@regression"] }, async ({
    authedPage: page,
    workspace,
  }) => {
    test.setTimeout(240_000);
    const main = centerPanel(page);
    await pasteAndReview(page, workspace.productUrl, sample("shipment.proto"));

    const review = main.getByTestId(ID.multiReview);
    await expect(review).toBeVisible({ timeout: 45_000 });
    await expect(review.getByTestId(ID.multiTitle)).toHaveText("Review Protobuf Import");
    await expect(review.getByTestId(ID.multiCounts)).toContainText("2 model(s), 1 enum(s)");
    // The nested message is a model of its own, named after its parent.
    await review.getByTestId(ID.modelToggle("Shipment")).click();
    await review.getByTestId(ID.modelToggle("Shipment_Address")).click();
    await expect(review.getByTestId(ID.model("Shipment"))).toContainText("7 fields");
    await expect(review.getByTestId(ID.model("Shipment"))).toContainText("A parcel on its way to a customer.");
    await expect(review.getByTestId(ID.model("Shipment_Address"))).toContainText("2 fields");
    const types: Record<string, string> = {
      shipment_id: "string",
      carrier: "enum",
      tracking_events: "array",
      attributes: "map",
      destination: "reference",
      email: "string",
      phone: "string",
    };
    for (const [name, type] of Object.entries(types)) {
      await expect(review.getByTestId(ID.field("Shipment", name)), name).toContainText(type);
    }
    await expect(review.getByTestId(ID.enum("Carrier"))).toContainText("CARRIER_UNSPECIFIED, GROUND, AIR");
    // The oneof group and the field numbers are kept (shown in the details of the field).
    await review.getByRole("button", { name: "Show details of Shipment.email" }).click();
    const email = review.getByTestId(ID.fieldDetails("email"));
    await expect(email).toContainText("Oneof group");
    await expect(email).toContainText("contact");
    await expect(email).toContainText("Field number");

    const entityUrl = await createEntityFromReview(page, workspace.productUrl, "Shipment");
    await openSchemasOf(page, entityUrl);
    const avro = await generateTarget(page, "Avro Schema");
    expect(avro.error).toBeUndefined();
    const text = canon(avro.code);
    expect(text).toContain('"type":"record"');
    expect(text).toContain('"name":"Shipment"');
    expect(text).toContain('"name":"shipment_id"');
    expect(text).toContain('"values":"string"');
  });

  test("OpenAPI: components.schemas with $ref and allOf are reviewed, created, and generate a Java POJO", { tag: ["@regression"] }, async ({
    authedPage: page,
    workspace,
  }) => {
    test.setTimeout(240_000);
    const main = centerPanel(page);
    await pasteAndReview(page, workspace.productUrl, sample("store-api.openapi.yaml"));

    const review = main.getByTestId(ID.multiReview);
    await expect(review).toBeVisible({ timeout: 90_000 });
    await expect(review.getByTestId(ID.multiTitle)).toHaveText("Review OpenAPI Import");
    // Money, Base and Product, and the one operation as an API service.
    await expect(review.getByTestId(ID.multiCounts)).toContainText("3 model(s)");
    await expect(review.getByTestId(ID.multiCounts)).toContainText("1 API service(s)");
    for (const name of ["Money", "Base", "Product"]) await expect(review.getByTestId(ID.model(name)), name).toBeVisible();
    // allOf: Product has the fields of Base (the converter spreads them) and its own, and uses Money.
    await expect(review.getByTestId(ID.model("Product"))).toContainText("4 fields");
    await expect(review.getByTestId(ID.model("Product"))).toContainText("uses Money");
    await expect(review.getByTestId(ID.model("Product"))).toContainText("Recommended Entity");
    await review.getByTestId(ID.modelToggle("Product")).click();
    for (const name of ["id", "createdAt", "sku", "price"]) await expect(review.getByTestId(ID.field("Product", name)), name).toBeVisible();
    await expect(review.getByTestId(ID.field("Product", "createdAt"))).toContainText("utcDateTime");
    await expect(review.getByTestId(ID.field("Product", "sku"))).toContainText("required");
    // A field typed by another schema is a reference to it: its type is that schema's name.
    await expect(review.getByTestId(ID.field("Product", "price"))).toContainText("Money");

    const entityUrl = await createEntityFromReview(page, workspace.productUrl, "Product");
    await openSchemasOf(page, entityUrl);
    const java = await generateTarget(page, "Java POJO");
    expect(java.error).toBeUndefined();
    expect(java.code).toMatch(/\bclass Product\b/);
    // The inherited fields (from allOf) and the own ones are all there, typed for Java: date-time is an Instant.
    expect(java.code).toMatch(/private String id;/);
    expect(java.code).toMatch(/private Instant createdAt;/);
    expect(java.code).toMatch(/private String sku;/);
  });

  test("BigQuery DDL: one table, six columns with their descriptions, a low-confidence note for each nested type; created and generates PostgreSQL", { tag: ["@regression"] }, async ({
    authedPage: page,
    workspace,
  }) => {
    test.setTimeout(240_000);
    const main = centerPanel(page);
    await pasteAndReview(page, workspace.productUrl, sample("sales-orders.sql"));

    // One table is one entity: the single-entity review, named after the table.
    await expect(main.getByTestId(ID.entityDetails)).toBeVisible({ timeout: 45_000 });
    await expect(main.getByTestId(ID.sourceFormat)).toContainText("bigquery-ddl");
    await expect(main.getByTestId(ID.entityName)).toHaveValue("orders");
    const rows = main.getByTestId(ID.fieldRow);
    await expect(rows).toHaveCount(6);
    const names = await main.getByTestId(ID.fieldName).evaluateAll((inputs) => inputs.map((input) => (input as HTMLInputElement).value));
    expect(names).toEqual(["order_id", "placed_at", "total", "items", "shipping", "tags"]);
    // The column descriptions came over as field descriptions.
    await expect(rows.nth(0).getByPlaceholder("Description...")).toHaveValue("Primary identifier of the order");
    await expect(rows.nth(1).getByPlaceholder("Description...")).toHaveValue("When the order was placed");
    // The nested types are mapped with low confidence, and the review says so for each of them: in the warnings and per field.
    const warnings = main.getByTestId(ID.warnings);
    await expect(warnings).toContainText("Warnings (3)");
    await expect(warnings).toContainText("low confidence mapping from ARRAY<STRUCT<SKU STRING, QTY INT64>> to array");
    await expect(warnings).toContainText("low confidence mapping from STRUCT<STREET STRING, CITY STRING> to object");
    await expect(warnings).toContainText("low confidence mapping from ARRAY<STRING> to array");
    // The Conf. column: a direct mapping is 95%, the nested types 40%; the details of a field say what it was and what it became.
    await expect(rows.nth(0)).toContainText("95%");
    for (const index of [3, 4, 5]) await expect(rows.nth(index)).toContainText("40%");
    await main.getByRole("button", { name: "Show import details of items" }).click();
    const items = main.getByTestId(ID.fieldDetails("items"));
    await expect(items.getByTestId(ID.fieldConfidence)).toContainText("Low confidence");
    await expect(items).toContainText("Original type");
    await expect(items).toContainText("ARRAY<STRUCT<SKU STRING, QTY INT64>>");

    const entityUrl = await createSingleEntity(page, "orders");
    await openSchemasOf(page, entityUrl);
    const postgres = await generateTarget(page, "PostgreSQL DDL");
    expect(postgres.error).toBeUndefined();
    expect(postgres.code).toMatch(/CREATE TABLE/i);
    expect(postgres.code).toMatch(/\border_id\b/);
    expect(postgres.code).toMatch(/\bplaced_at\b/);
    expect(postgres.code).toMatch(/\btotal\b\s+NUMERIC/i);
    expect(postgres.code).toMatch(/TIMESTAMP/i);
    // The column descriptions are comments of the columns.
    expect(postgres.code).toContain("Primary identifier of the order");
  });

  // OPEN PRODUCT GAP (task-5-report.md, "Bugs open" 3): the importers read NUMERIC(12, 2) (and Avro's decimal precision / scale) as a
  // plain decimal: `ParsedField` has no precision or scale and the wizard creates every field with both null, so the generated DDL says
  // NUMERIC. Expected to fail (`test.fail`); when it passes, remove that line.
  test("BigQuery DDL [open defect: precision and scale of NUMERIC(12, 2) are dropped by the import]: the generated column keeps them", { tag: ["@regression"] }, async ({
    authedPage: page,
    workspace,
  }) => {
    test.fail(true, "importers drop the precision and scale of decimals (task-5-report.md, Bugs open 3)");
    test.setTimeout(240_000);
    await pasteAndReview(page, workspace.productUrl, sample("sales-orders.sql"));
    await expect(centerPanel(page).getByTestId(ID.entityDetails)).toBeVisible({ timeout: 45_000 });
    const entityUrl = await createSingleEntity(page, "orders");
    await openSchemasOf(page, entityUrl);
    const postgres = await generateTarget(page, "PostgreSQL DDL");
    expect(postgres.error).toBeUndefined();
    expect(postgres.code).toMatch(/NUMERIC\s*\(\s*12\s*,\s*2\s*\)/i);
  });

  test("TypeSpec with two models: the multi-entity review lists both, both become entities, and one generates OpenAPI 3", { tag: ["@regression"] }, async ({
    authedPage: page,
    workspace,
  }) => {
    test.setTimeout(240_000);
    const main = centerPanel(page);
    await pasteAndReview(page, workspace.productUrl, sample("catalog-models.tsp"));

    const review = main.getByTestId(ID.multiReview);
    await expect(review).toBeVisible({ timeout: 60_000 });
    await expect(review.getByTestId(ID.multiTitle)).toHaveText("Review TypeSpec Import");
    await expect(review.getByTestId(ID.multiCounts)).toContainText("2 model(s)");
    await expect(review.getByTestId(ID.model("Product"))).toContainText("A product in the catalog");
    await expect(review.getByTestId(ID.model("Product"))).toContainText("3 fields");
    await expect(review.getByTestId(ID.model("Category"))).toContainText("A category the products belong to");
    await expect(review.getByTestId(ID.model("Category"))).toContainText("2 fields");
    // Models without a key are not recommended as entities: both are kept as models until the reviewer registers them.
    for (const name of ["Product", "Category"]) {
      await expect(review.getByRole("checkbox", { name: `${name} model` })).toBeChecked();
      await expect(review.getByRole("checkbox", { name: `${name} entity` })).not.toBeChecked();
      await expect(review.getByTestId(ID.model(name))).not.toContainText("Recommended Entity");
      await review.getByRole("checkbox", { name: `${name} entity` }).check();
    }
    await review.getByTestId(ID.modelToggle("Product")).click();
    // `price?` is optional, `id` is not.
    await expect(review.getByTestId(ID.field("Product", "id"))).toContainText("required");
    await expect(review.getByTestId(ID.field("Product", "price"))).not.toContainText("required");

    const categoryUrl = await createEntityFromReview(page, workspace.productUrl, "Category");
    // The other model is an entity of the product as well.
    const productUrl = await openEntityFromProduct(page, workspace.productUrl, "Product");
    expect(productUrl).not.toBe(categoryUrl);

    await openSchemasOf(page, categoryUrl);
    const openapi = await generateTarget(page, "OpenAPI 3 (TypeSpec)");
    expect(openapi.error).toBeUndefined();
    expect(openapi.code).toMatch(/openapi["']?\s*:\s*["']?3\./);
    expect(openapi.code).toContain("Category");
    expect(openapi.code).toContain("label");
  });

  test("a JSON Schema file dropped on the Drop zone: the file and its format are shown, what the app ignores is listed, and it generates JSON Schema", { tag: ["@regression"] }, async ({
    authedPage: page,
    workspace,
  }) => {
    test.setTimeout(240_000);
    const main = centerPanel(page);
    await dropFileAndReview(page, workspace.productUrl, samplePath("support-ticket.schema.json"));

    await expect(main.getByTestId(ID.entityDetails)).toBeVisible({ timeout: 45_000 });
    await expect(main.getByTestId(ID.sourceFormat)).toContainText("json-schema");
    await expect(main.getByTestId(ID.entityName)).toHaveValue("SupportTicket");
    await expect(main.getByTestId(ID.fieldRow)).toHaveCount(4);
    // `additionalProperties` is a standard keyword the app cannot use: listed as ignored on the entity, and in the warnings.
    await expect(main.getByTestId(ID.entityIgnored)).toContainText("additionalProperties");
    await expect(main.getByTestId(ID.warnings)).toContainText("JSON Schema keyword `additionalProperties` is not supported and was ignored");
    // ... and per field: `readOnly` on id, `default` on priority; the other fields have none.
    await main.getByRole("button", { name: "Show import details of id" }).click();
    await expect(main.getByTestId(ID.fieldDetails("id")).getByTestId(ID.fieldIgnored)).toContainText("readOnly");
    await expect(main.getByTestId(ID.fieldDetails("id")).getByTestId(ID.fieldUsed)).toContainText("The ticket's identifier.");
    await expect(main.getByTestId(ID.fieldDetails("id")).getByTestId(ID.fieldUsed)).toContainText("uuid");
    await main.getByRole("button", { name: "Show import details of priority" }).click();
    await expect(main.getByTestId(ID.fieldDetails("priority")).getByTestId(ID.fieldIgnored)).toContainText("default");
    await expect(main.getByTestId(ID.fieldDetails("priority")).getByTestId(ID.fieldUsed)).toContainText("low, normal, high");
    await main.getByRole("button", { name: "Show import details of subject" }).click();
    await expect(main.getByTestId(ID.fieldDetails("subject")).getByTestId(ID.fieldIgnored)).toHaveCount(0);
    await expect(main.getByTestId(ID.fieldDetails("subject")).getByTestId(ID.fieldUsed)).toContainText("120");
    await expect(main.getByTestId(ID.fieldDetails("subject")).getByTestId(ID.fieldConfidence)).toContainText("High confidence");

    const entityUrl = await createSingleEntity(page, "SupportTicket");
    await openSchemasOf(page, entityUrl);
    const schema = await generateTarget(page, "JSON Schema (TypeSpec)");
    expect(schema.error).toBeUndefined();
    expect(requiredOf(schema.code, "SupportTicket")).toEqual(expect.arrayContaining(["id", "subject"]));
    const text = canon(schema.code);
    expect(text).toContain('"maxLength":120');
    expect(text).toContain('"enum":["low","normal","high"]');
    expect(text).toContain('"format":"uuid"');
  });

  test("Standards Library: a template is picked from the search, reviewed, created, and generates Spanner DDL", { tag: ["@regression"] }, async ({
    authedPage: page,
    workspace,
  }) => {
    test.setTimeout(240_000);
    const main = centerPanel(page);
    await page.goto(`${workspace.productUrl}/new`);
    await expect(page.getByRole("heading", { name: /create new entity/i })).toBeVisible();
    await main.getByTestId(ID.creationMethod("standards")).click();

    // Search narrows the library to the template; its card says what it holds.
    await main.getByTestId(ID.standardsSearch).fill("Payment");
    const card = main.getByTestId(ID.standardsTemplate).filter({ has: page.getByText("Payment", { exact: true }) });
    await expect(main.getByTestId(ID.standardsTemplate).first()).toBeVisible();
    const payment = main.locator('[data-testid="standards-template"][data-name="Payment"]');
    await expect(payment).toHaveCount(1);
    await expect(payment).toContainText("financial");
    await expect(payment).toContainText("A payment between parties");
    expect(card).toBeTruthy();
    await payment.click();

    // The review of a template: its name, its fields with a classification where the standard gives one.
    await expect(main.getByTestId(ID.entityName)).toHaveValue("Payment");
    const names = await main.getByTestId(ID.fieldName).evaluateAll((inputs) => inputs.map((input) => (input as HTMLInputElement).value));
    expect(names).toContain("paymentId");
    expect(names.length).toBeGreaterThan(3);
    await expect(main.getByTestId(ID.fieldRow).first()).toContainText(/internal/i);
    await main.getByTestId(ID.createEntity).click();

    // Not an import: back on the product page, which lists it.
    await expect(page).toHaveURL(new RegExp(`${workspace.productUrl}$`), { timeout: 30_000 });
    const entityUrl = await openEntityFromProduct(page, workspace.productUrl, "Payment");
    await openSchemasOf(page, entityUrl);
    const spanner = await generateTarget(page, "Spanner DDL");
    expect(spanner.error).toBeUndefined();
    expect(spanner.code).toMatch(/CREATE TABLE\s+`?Payment`?/i);
    expect(spanner.code).toMatch(/PRIMARY KEY/i);
    // Columns are snake_case in the DDL; the standard's own descriptions come along as comments.
    expect(spanner.code).toMatch(/\bpayment_id\b\s+STRING/);
    expect(spanner.code).toContain("Unique payment identifier");
  });

  test("Natural Language: AI is not configured on this server, so the page says so and nothing can be sent", { tag: ["@regression"] }, async ({
    authedPage: page,
    workspace,
  }) => {
    const main = centerPanel(page);
    await page.goto(`${workspace.productUrl}/new`);
    await expect(page.getByRole("heading", { name: /create new entity/i })).toBeVisible();
    await main.getByTestId(ID.creationMethod("natural-language")).click();

    const notice = main.getByTestId(ID.nlNotConfigured);
    await expect(notice).toBeVisible();
    await expect(notice).toContainText("AI not configured");
    await expect(notice).toContainText("AI_PROVIDER and AI_BASE_URL");
    await expect(notice).toContainText("You can still use other creation methods.");
    await expect(main.getByTestId(ID.nlDescription)).toBeDisabled();
    await expect(main.getByTestId(ID.nlGenerate)).toBeDisabled();
    await expect(main.getByTestId(ID.nlGenerate)).toHaveText("Generate Schema");

    // The page did not crash: Back returns to the methods, which still work.
    await main.getByRole("button", { name: "Back" }).click();
    await expect(main.getByTestId(ID.creationMethod("schema"))).toBeVisible();
    await expect(main.getByTestId(ID.creationMethod("standards"))).toBeVisible();
  });

  test("text that is no schema at all: the workbench says the format could not be detected, and the review is refused with a message", { tag: ["@regression"] }, async ({
    authedPage: page,
    workspace,
  }) => {
    const main = centerPanel(page);
    await openWorkbench(page, workspace.productUrl);
    await main.getByTestId(ID.modePaste).click();
    await fillWorkbenchPaste(page, "this is not a schema, just a sentence");
    await main.getByTestId(ID.loadButton).click();
    await expect(main.getByText("Could not detect the schema format. You can still edit the text, but import may fail.")).toBeVisible();
    await main.getByTestId(ID.reviewButton).click();
    await expect(main.getByText(/Could not detect schema format\. Ensure the content matches Avro, BigQuery DDL, Protobuf, JSON Schema, or TypeSpec\./)).toBeVisible();
    // Nothing was created: no review screen, still on the new-entity page.
    await expect(main.getByTestId(ID.entityDetails)).toHaveCount(0);
    await expect(main.getByTestId(ID.multiReview)).toHaveCount(0);
    await expect(page).toHaveURL(/\/new$/);
  });
});
