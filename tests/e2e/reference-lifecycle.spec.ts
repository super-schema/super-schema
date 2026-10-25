/**
 * Entities that reference other entities, through the real UI (multi-entity emission): the reference is picked qualified
 * (`domain / product / entity`), generating the entity writes ITS file and the file of every entity it references (a file set), a draft
 * previews the drafts it references and cannot be published as it is, a pin freezes the version a reference uses, and an ambiguous
 * bare name is asked about and the answer saved.
 *
 * What the app does (each line is a test; `@smoke` is the first, the rest `@regression`):
 *   - an entity whose reference is picked in the type picker (stored qualified) is generated with the entity it references: both files
 *     in the file list, the JSON Schema `$ref` pointing at the sibling file (`@smoke`: one target, a published Address);
 *   - all five closure targets write one file per entity, linked the way the format links files (JSON Schema `$ref` to the sibling,
 *     OpenAPI the entities inlined in one self-contained document each, Avro the record inline, Protobuf `import`, Java `import`);
 *     the database targets stay one file; "Download all" saves the files;
 *   - a DRAFT of the referenced entity is in a draft preview (the badge lists it, its file has the draft field); marking that preview
 *     deployed is refused naming the draft entity, and "Regenerate from published and publish" generates from the published versions
 *     (no draft field in them) and publishes that;
 *   - publishing is blocked while the referenced entity was never published (the entity's publish dialog and the refused preview name it);
 *   - a reference pinned to a published version keeps generating that version after the referenced entity publishes a newer one, in a
 *     preview and in what is published; unpinning gives the live entity back;
 *   - a name-only reference that two entities answer to is not guessed: generating asks (both candidates, `domain / product / entity`),
 *     saves the pick as the qualified reference and generates; so does the publish dialog;
 *   - the TypeSpec tab saves a source that names another entity (it used to refuse), and asks the same question for an ambiguous name;
 *   - an imported document's `$defs` become entities that are generated with their parent, and the reference the import could not load
 *     stays dangling (the review's banner) without failing the generation.
 *
 * Role: the seeded admin (ADMIN). Every entity name is `unique()`: the reference prompt and the name-only resolution look at the whole
 * tenant, and these tests run in parallel with the rest of the suite.
 *
 * Needs PostgreSQL for the fixtures (helpers/db.ts); the release runner provides it.
 */
import { readFileSync } from "node:fs";
import type { Download, Locator, Page } from "@playwright/test";
import { parse as parseYaml } from "yaml";
import { test, expect, unique, type Workspace } from "./helpers/fixtures";
import { centerPanel } from "./helpers/event-builder";
import { createEntityInProduct, createFieldRow, createProductInDomain } from "./helpers/db";
import {
  addFieldQuick,
  addReferenceField,
  openEntityPage,
  openPublishDialog,
  publishViaDialog,
} from "./helpers/entity-page";
import {
  ENABLED_TARGETS,
  createEntityFromReview,
  generateTarget,
  openEditor,
  openSchemasTab,
  pasteAndReview,
  readPreview,
  readTypeSpecSource,
  saveTypeSpecSource,
} from "./helpers/lifecycle";
import { splitBundle } from "./helpers/preview-text";

// Each test is a user journey of several server round trips (a publish, a reference picked, a target or five generated): about 25 s alone and
// up to a minute with eight workers on one server, against the suite's 60 s. The assertions inside have their own waits; this is only the room.
test.describe.configure({ timeout: 180_000 });

const REGENERATE_AND_PUBLISH = "Regenerate from published and publish";
const DRAFT = "https://json-schema.org/draft/2020-12/schema";

const displayName = (key: string): string => {
  const target = ENABLED_TARGETS.find((t) => t.key === key);
  if (!target) throw new Error(`no target ${key}`);
  return target.displayName;
};

/** An entity of the workspace's product with a unique name; `url` is its page. The `workspace` fixture's own entities have names fixed by the option, which a parallel test could share. */
async function makeEntity(workspace: Workspace, prefix: string): Promise<{ id: string; name: string; url: string }> {
  const row = await createEntityInProduct(workspace.domainId, workspace.productId, unique(prefix));
  return { id: row.id, name: row.name, url: `${workspace.productUrl}/${row.slug}` };
}

/** How a person reads a qualified reference: the field row of the editor and the lists of the Schemas tab say it this way. */
const qualified = (workspace: Workspace, entity: { name: string }, product: string = workspace.productName): string => `${workspace.domainName} / ${product} / ${entity.name}`;

const schemasTab = (page: Page): Locator => page.getByTestId("schemas-tab");

/** The paths of the file list, in list order (empty when the version is one plain preview). */
async function filePaths(page: Page): Promise<string[]> {
  return schemasTab(page).getByTestId("schema-file-item").evaluateAll((items) => items.map((item) => item.getAttribute("data-path") ?? ""));
}

/** The files of what is on show: path to content. */
async function fileSet(page: Page): Promise<Map<string, string>> {
  return new Map(splitBundle(await readPreview(page)).map((file) => [file.path, file.content]));
}

/** The one file whose path has `name` in it (the entity's own: `Customerabc.json`, `Sales/Orders/Customerabc.proto`). */
function fileOf(files: Map<string, string>, name: string): { path: string; content: string } {
  const matches = [...files].filter(([path]) => path.split("/").pop()?.includes(name));
  if (matches.length !== 1) throw new Error(`expected one file for ${name}, got ${matches.length} of: ${[...files.keys()].join(", ")}`);
  return { path: matches[0][0], content: matches[0][1] };
}

const errorToast = (page: Page): Locator => page.locator('[data-sonner-toast][data-type="error"]');
const successToast = (page: Page, text: RegExp | string): Locator => page.locator('[data-sonner-toast][data-type="success"]').filter({ hasText: text });

test.describe("references between entities", () => {
  test("an entity whose reference was picked in the editor is generated with the entity it references: both files, the JSON Schema $ref to the sibling", { tag: ["@smoke", "@regression"] }, async ({ authedPage: page, workspace }) => {
    const address = await makeEntity(workspace, "Address");
    const customer = await makeEntity(workspace, "Customer");

    // Address has a field and is published: the reference then means something that is published.
    await openEntityPage(page, address.url, address.name);
    await addFieldQuick(page, "city");
    expect(await publishViaDialog(page)).toBe("1.0");

    // Customer's reference is picked in the type picker: it is written with the target's id and its qualified name.
    await openEntityPage(page, customer.url, customer.name);
    await addReferenceField(page, "home", address);
    await expect(centerPanel(page).locator('[data-testid="field-card"][data-field="home"]')).toContainText(`ref(${qualified(workspace, address)})`);

    await openSchemasTab(page);
    const generated = await generateTarget(page, displayName("json-schema"));
    expect(generated.error).toBeUndefined();
    // one file per entity: the file list names both, Address's beside Customer's (the list is by entity, the one generated first)
    expect(await filePaths(page)).toEqual([`${customer.name}.json`, `${address.name}.json`]);
    const files = await fileSet(page);
    expect(JSON.parse(files.get(`${customer.name}.json`) ?? "null").properties.home.$ref).toBe(`${address.name}.json`);
    const addressSchema = JSON.parse(files.get(`${address.name}.json`) ?? "null") as { properties: Record<string, unknown> };
    expect(Object.keys(addressSchema.properties)).toEqual(["id", "city"]);
  });

  test("the five closure targets write one file per entity, each linked the way its format links files; the database targets stay one file; Download all saves the files", { tag: ["@regression"] }, async ({ authedPage: page, workspace }) => {
    test.setTimeout(240_000);
    const address = await makeEntity(workspace, "Address");
    const customer = await makeEntity(workspace, "Customer");
    await openEntityPage(page, address.url, address.name);
    await addFieldQuick(page, "city");
    await openEntityPage(page, customer.url, customer.name);
    await addReferenceField(page, "home", address);
    await openSchemasTab(page);

    // JSON Schema: a native $ref to the sibling file
    expect((await generateTarget(page, displayName("json-schema"))).error).toBeUndefined();
    expect(await filePaths(page)).toEqual([`${customer.name}.json`, `${address.name}.json`]);
    const json = await fileSet(page);
    expect(JSON.parse(json.get(`${customer.name}.json`) ?? "null").properties.home.$ref).toBe(`${address.name}.json`);

    // OpenAPI: one self-contained document per entity, the referenced one inlined in components.schemas (no reference between files)
    expect((await generateTarget(page, displayName("openapi3"))).error).toBeUndefined();
    const openapiPaths = await filePaths(page);
    expect(openapiPaths).toHaveLength(2);
    const openapi = await fileSet(page);
    const customerDoc = parseYaml(fileOf(openapi, customer.name).content) as { components: { schemas: Record<string, { properties?: Record<string, { $ref?: string }> }> } };
    expect(Object.keys(customerDoc.components.schemas).sort()).toEqual([address.name, customer.name].sort());
    expect(customerDoc.components.schemas[customer.name].properties?.home.$ref).toBe(`#/components/schemas/${address.name}`);
    const addressDoc = parseYaml(fileOf(openapi, address.name).content) as { components: { schemas: Record<string, unknown> } };
    expect(Object.keys(addressDoc.components.schemas)).toEqual([address.name]);
    for (const file of openapi.values()) expect(file, "no $ref leaves its document").not.toMatch(/\$ref:\s*'?[^#'\s]/);

    // Avro: each file self-contained; Customer's file holds Address's record
    expect((await generateTarget(page, displayName("avro"))).error).toBeUndefined();
    expect(await filePaths(page)).toHaveLength(2);
    const avro = await fileSet(page);
    expect(fileOf(avro, customer.name).content).toContain(`"name": "${address.name}"`);
    expect(fileOf(avro, address.name).content).toContain(`"name": "city"`);

    // Protobuf: Customer's file imports Address's
    expect((await generateTarget(page, displayName("protobuf"))).error).toBeUndefined();
    expect(await filePaths(page)).toHaveLength(2);
    const proto = await fileSet(page);
    expect(fileOf(proto, customer.name).content).toMatch(new RegExp(`import "[^"]*${address.name}\\.proto";`));
    expect(fileOf(proto, address.name).content).toMatch(new RegExp(`message ${address.name}\\b`));

    // Java: separate classes, an import of Address in Customer
    expect((await generateTarget(page, displayName("java-pojo"))).error).toBeUndefined();
    expect(await filePaths(page)).toHaveLength(2);
    const java = await fileSet(page);
    expect(fileOf(java, customer.name).content).toMatch(new RegExp(`import [\\w.]+\\.${address.name};`));
    // the field is typed with that class (it used to be a String, KD-009)
    expect(fileOf(java, customer.name).content).toMatch(new RegExp(`private ${address.name} home;`));
    expect(fileOf(java, address.name).content).toMatch(new RegExp(`class ${address.name}\\b`));

    // Download all: every file of the set is saved, under its path (directories flattened with `_`)
    const downloads: Download[] = [];
    page.on("download", (download) => downloads.push(download));
    await schemasTab(page).getByTestId("schema-file-set-download-all").click();
    await expect.poll(() => downloads.length, { message: "both files are downloaded" }).toBe(2);
    const javaPaths = [...java.keys()];
    const saved = new Map<string, string>();
    for (const download of downloads) saved.set(download.suggestedFilename(), readFileSync(await download.path(), "utf8"));
    expect([...saved.keys()].sort()).toEqual(javaPaths.map((p) => p.replace(/[\\/]+/g, "_")).sort());
    // (compared without trailing blanks: the preview text is read line by line)
    const lines = (text: string | undefined): string => (text ?? "").split("\n").map((line) => line.trimEnd()).join("\n").trim();
    for (const [path, content] of java) expect(lines(saved.get(path.replace(/[\\/]+/g, "_"))), path).toBe(lines(content));

    // The database targets are unchanged: a reference is a plain column there, one file, no file list
    expect((await generateTarget(page, displayName("postgresql"))).error).toBeUndefined();
    await expect(schemasTab(page).getByTestId("schema-file-item")).toHaveCount(0);
    expect(splitBundle(await readPreview(page))).toHaveLength(1);
  });

  test("a draft of the referenced entity is in a draft preview and the preview cannot be published as it is; regenerating from the published versions leaves the draft out and publishes", { tag: ["@regression"] }, async ({ authedPage: page, workspace }) => {
    test.setTimeout(180_000);
    const address = await makeEntity(workspace, "Address");
    const customer = await makeEntity(workspace, "Customer");

    // Address v1.0 has `city`; Customer references it and is published too (a published schema reads the entity itself at its published version)
    await openEntityPage(page, address.url, address.name);
    await addFieldQuick(page, "city");
    expect(await publishViaDialog(page)).toBe("1.0");
    await openEntityPage(page, customer.url, customer.name);
    await addReferenceField(page, "home", address);
    expect(await publishViaDialog(page)).toBe("1.0");

    // Address changes as a DRAFT: a field that is saved, not published
    await openEntityPage(page, address.url, address.name);
    await addFieldQuick(page, "zipdraft");

    // Customer's preview (generated from the saved state) includes the draft of Address, and says so
    await openEntityPage(page, customer.url, customer.name);
    await openSchemasTab(page);
    expect((await generateTarget(page, displayName("json-schema"))).error).toBeUndefined();
    const tab = schemasTab(page);
    await expect(tab.getByTestId("schema-preview-badge")).toBeVisible();
    await expect(tab.getByTestId("schema-draft-reference")).toHaveText([qualified(workspace, address)]);
    await expect(tab.getByTestId("schema-reference-version")).toHaveAttribute("data-source", "draft");
    expect(fileOf(await fileSet(page), address.name).content).toContain("zipdraft");

    // It cannot be published as it is: the refusal names the draft entity and offers the way out
    await tab.getByTestId("schema-mark-deployed").click();
    const refusal = errorToast(page).filter({ hasText: "cannot be published" });
    await expect(refusal).toBeVisible();
    await expect(refusal).toContainText(qualified(workspace, address));
    await expect(tab.getByTestId("schema-version-button").first()).toHaveAttribute("data-status", "draft");

    // The way out: generated from the published versions, so the draft field is not in it, and published
    // (a toast this long used to be taller than the window, with this button below the fold: it is clicked as a user would)
    await refusal.getByRole("button", { name: REGENERATE_AND_PUBLISH }).click();
    await expect(successToast(page, /regenerated from the published versions and published/)).toBeVisible({ timeout: 60_000 });
    await expect(tab.getByTestId("schema-deployed-badge")).toBeVisible();
    await expect(tab.getByTestId("schema-preview-badge")).toHaveCount(0);
    await expect(tab.getByTestId("schema-reference-version")).toHaveAttribute("data-source", "published");
    await expect(tab.getByTestId("schema-reference-version")).toContainText("v1.0");
    const published = await fileSet(page);
    expect(fileOf(published, address.name).content).toContain("city");
    expect(fileOf(published, address.name).content).not.toContain("zipdraft");
    // the version that was published is the regenerated one
    await expect(tab.getByTestId("schema-version-button").first()).toHaveAttribute("data-status", "published");
  });

  test("publishing is blocked while the referenced entity was never published, and the refusals name it", { tag: ["@regression"] }, async ({ authedPage: page, workspace }) => {
    const address = await makeEntity(workspace, "Address");
    const customer = await makeEntity(workspace, "Customer");
    await openEntityPage(page, customer.url, customer.name);
    await addReferenceField(page, "home", address);

    // The entity's own publish: a blocker that names Address, and a Publish button that stays off
    const dialog = await openPublishDialog(page);
    const blocker = dialog.getByTestId("publish-blockers").getByTestId("publish-blocker");
    await expect(blocker).toHaveText([`Publish ${address.name} first`]);
    await expect(blocker).toHaveAttribute("data-kind", "UNPUBLISHED_REFERENCE");
    await expect(dialog.getByTestId("confirm-publish")).toBeDisabled();
    await dialog.getByTestId("publish-cancel").click();
    await expect(dialog).toBeHidden();

    // The generated schema's own publish: a preview of the saved draft, refused naming the draft entity
    await openSchemasTab(page);
    expect((await generateTarget(page, displayName("json-schema"))).error).toBeUndefined();
    await schemasTab(page).getByTestId("schema-mark-deployed").click();
    const refusal = errorToast(page).filter({ hasText: "cannot be published" });
    await expect(refusal).toContainText(qualified(workspace, address));
    // and generating from the published versions, which do not exist yet, says which entity was never published
    await refusal.getByRole("button", { name: REGENERATE_AND_PUBLISH }).click();
    await expect(errorToast(page).filter({ hasText: "has never been published" })).toContainText(qualified(workspace, customer));

    // Publish Address, then Customer: the blocker is gone
    await openEntityPage(page, address.url, address.name);
    expect(await publishViaDialog(page)).toBe("1.0");
    await openEntityPage(page, customer.url, customer.name);
    const again = await openPublishDialog(page);
    await expect(again.getByTestId("publish-blockers")).toHaveCount(0);
    await expect(again.getByTestId("confirm-publish")).toBeEnabled();
  });

  test("a reference pinned to a published version keeps using it after the referenced entity publishes a newer one; unpinned it follows the live entity", { tag: ["@regression"] }, async ({ authedPage: page, workspace }) => {
    test.setTimeout(180_000);
    const address = await makeEntity(workspace, "Address");
    const customer = await makeEntity(workspace, "Customer");
    await openEntityPage(page, address.url, address.name);
    await addFieldQuick(page, "city");
    expect(await publishViaDialog(page)).toBe("1.0");
    await openEntityPage(page, customer.url, customer.name);
    await addReferenceField(page, "home", address);

    // The pin control on the reference field: a list of Address's published versions (and "no pin")
    const home = centerPanel(page).locator('[data-testid="field-card"][data-field="home"]');
    await expect(home.getByTestId("reference-pin-badge")).toHaveCount(0);
    await home.getByTestId("reference-pin-open").click();
    const pin = home.getByTestId("reference-pin-control");
    await expect(pin.locator("option")).toHaveText(["Latest published (no pin)", "v1.0"]);
    await pin.selectOption("1.0");
    await expect(home.getByTestId("reference-pin-badge")).toHaveText(/pinned v1\.0/);

    // Address moves on: a new field, published as 1.1
    await openEntityPage(page, address.url, address.name);
    await addFieldQuick(page, "zippin");
    expect(await publishViaDialog(page, { bump: "minor" })).toBe("1.1");

    // The pin wins: Customer's schema uses 1.0 of Address, without the new field, and is not a preview of anything unpublished
    await openEntityPage(page, customer.url, customer.name);
    await openSchemasTab(page);
    expect((await generateTarget(page, displayName("json-schema"))).error).toBeUndefined();
    const tab = schemasTab(page);
    const used = tab.getByTestId("schema-reference-version");
    await expect(used).toHaveAttribute("data-source", "pinned");
    await expect(used).toContainText("v1.0");
    await expect(used).toContainText("(pinned)");
    await expect(tab.getByTestId("schema-preview-badge")).toHaveCount(0);
    const pinned = fileOf(await fileSet(page), address.name).content;
    expect(pinned).toContain("city");
    expect(pinned).not.toContain("zippin");
    // so it can be published as it is
    await tab.getByTestId("schema-mark-deployed").click();
    await expect(successToast(page, /marked as deployed/)).toBeVisible();

    // The pin survives a reload, and removing it gives the live Address back (a draft preview again)
    await openEntityPage(page, customer.url, customer.name);
    const homeAgain = centerPanel(page).locator('[data-testid="field-card"][data-field="home"]');
    await expect(homeAgain.getByTestId("reference-pin-badge")).toHaveText(/pinned v1\.0/);
    await homeAgain.getByTestId("reference-pin-open").click();
    await homeAgain.getByTestId("reference-pin-control").selectOption("");
    await expect(homeAgain.getByTestId("reference-pin-badge")).toHaveCount(0);
    await openSchemasTab(page);
    expect((await generateTarget(page, displayName("json-schema"))).error).toBeUndefined();
    await expect(tab.getByTestId("schema-reference-version")).toHaveAttribute("data-source", "draft");
    await expect(tab.getByTestId("schema-preview-badge")).toBeVisible();
    expect(fileOf(await fileSet(page), address.name).content).toContain("zippin");
  });
});

test.describe("a name that two entities answer to", () => {
  /** Customer with a name-only reference field `twin`, and two entities of that name in two products of the workspace's domain. */
  async function twins(workspace: Workspace) {
    const customer = await makeEntity(workspace, "Customer");
    const twinName = unique("Twin");
    const otherProduct = await createProductInDomain(workspace.domainId);
    const first = await createEntityInProduct(workspace.domainId, workspace.productId, twinName);
    const second = await createEntityInProduct(workspace.domainId, otherProduct.id, twinName);
    const reference = await createFieldRow(customer.id, { name: "twin", type: "reference", sortOrder: 1, decorators: { referencedEntityName: twinName } });
    return { customer, twinName, otherProduct, first, second, reference };
  }

  /** The pick dialog with its two candidates, `domain / product / entity` each. */
  async function expectPickDialog(page: Page, workspace: Workspace, twin: { twinName: string; otherProduct: { name: string } }): Promise<Locator> {
    const dialog = page.getByTestId("reference-pick-dialog");
    await expect(dialog).toBeVisible({ timeout: 60_000 });
    await expect(dialog).toContainText(`Field "twin" refers to "${twin.twinName}", which matches 2 entities`);
    const candidates = dialog.getByTestId("reference-pick-candidate");
    expect((await candidates.allInnerTexts()).sort()).toEqual(
      [qualified(workspace, { name: twin.twinName }), qualified(workspace, { name: twin.twinName }, twin.otherProduct.name)].sort(),
    );
    return dialog;
  }

  test("generating asks which one is meant (both candidates), saves the pick as the qualified reference, and generates with it", { tag: ["@regression"] }, async ({ authedPage: page, workspace }) => {
    const t = await twins(workspace);
    await openEntityPage(page, t.customer.url, t.customer.name);
    // as stored: a name, nothing more
    await expect(centerPanel(page).locator('[data-testid="field-card"][data-field="twin"]')).toContainText(`ref(${t.twinName})`);

    await openSchemasTab(page);
    await schemasTab(page).getByTestId("schema-target-json-schema").click();
    await schemasTab(page).getByTestId("schema-generate").click();
    const dialog = await expectPickDialog(page, workspace, t);
    // nothing was picked for the user: no version exists yet
    await expect(schemasTab(page).getByTestId("schema-file-item")).toHaveCount(0);
    await dialog.getByTestId("reference-pick-candidate").filter({ hasText: t.otherProduct.name }).click();

    // generation goes on with the pick: the entity of the OTHER product is in the file set
    await expect(dialog).toBeHidden();
    await expect(successToast(page, /schema generated/)).toBeVisible({ timeout: 60_000 });
    // (the toast comes before the versions are reloaded: the list is waited for, not read at once)
    await expect.poll(() => filePaths(page), { message: "the file list of the new version" }).toEqual([`${t.customer.name}.json`, `${t.twinName}.json`]);
    const files = await fileSet(page);
    // (customer first: the file list puts the entity that was generated before the ones it references)
    expect(JSON.parse(files.get(`${t.customer.name}.json`) ?? "null").properties.twin.$ref).toBe(`${t.twinName}.json`);
    await expect(schemasTab(page).getByTestId("schema-reference-version")).toContainText(qualified(workspace, { name: t.twinName }, t.otherProduct.name));

    // the pick is stored on the field, fully qualified: a reload shows it
    await openEntityPage(page, t.customer.url, t.customer.name);
    await expect(centerPanel(page).locator('[data-testid="field-card"][data-field="twin"]')).toContainText(`ref(${qualified(workspace, { name: t.twinName }, t.otherProduct.name)})`);
    // and generating again asks nothing
    await openSchemasTab(page);
    expect((await generateTarget(page, displayName("json-schema"))).error).toBeUndefined();
    await expect(page.getByTestId("reference-pick-dialog")).toHaveCount(0);
  });

  test("the publish dialog asks the same question and the pick lifts the ambiguity (what is left is that the chosen entity was never published)", { tag: ["@regression"] }, async ({ authedPage: page, workspace }) => {
    const t = await twins(workspace);
    await openEntityPage(page, t.customer.url, t.customer.name);
    const dialog = await openPublishDialog(page);
    // the question is asked as soon as the publish dialog has found the ambiguity; declining it leaves the blocker and a button to ask again
    const declined = await expectPickDialog(page, workspace, t);
    await declined.getByRole("button", { name: "Cancel" }).click();
    await expect(declined).toBeHidden();
    await expect(dialog.getByTestId("confirm-publish")).toBeDisabled();
    await expect(dialog.getByTestId("publish-blocker").first()).toBeVisible();
    await dialog.getByTestId("publish-pick-reference").click();
    const pick = await expectPickDialog(page, workspace, t);
    await pick.getByTestId("reference-pick-candidate").filter({ hasText: t.otherProduct.name }).click();
    await expect(pick).toBeHidden();
    // The reference is qualified now, and what blocks the publish is the plain one: the chosen entity is not published
    await expect(dialog.getByTestId("publish-blocker").first()).toContainText(`Publish ${t.twinName} first`, { timeout: 30_000 });
    await expect(dialog.getByTestId("publish-pick-reference")).toHaveCount(0);
  });

  test("the TypeSpec tab saves a source that names another entity, and asks about a name two entities answer to", { tag: ["@regression"] }, async ({ authedPage: page, workspace }) => {
    test.setTimeout(180_000);
    const address = await makeEntity(workspace, "Address");
    const customer = await makeEntity(workspace, "Customer");
    await openEntityPage(page, customer.url, customer.name);

    // The old defect: a source whose field is typed with another entity's name did not compile, so it could not be saved
    const source = await readTypeSpecSource(page);
    const modelHead = new RegExp(`(model ${customer.name}[^{]*\\{[^\\n]*\\n)`);
    const withAddress = source.replace(modelHead, `$1  home: ${address.name};\n`);
    expect(withAddress).not.toBe(source);
    const saved = await saveTypeSpecSource(page, withAddress);
    expect(saved.ok, saved.message).toBe(true);
    await openEditor(page);
    // saved as a reference to that entity, fully qualified
    await expect(centerPanel(page).locator('[data-testid="field-card"][data-field="home"]')).toContainText(`ref(${qualified(workspace, address)})`);
    // and it is generated with it
    await openSchemasTab(page);
    expect((await generateTarget(page, displayName("json-schema"))).error).toBeUndefined();
    expect(await filePaths(page)).toEqual([`${customer.name}.json`, `${address.name}.json`]);

    // A name that two entities answer to is asked about, the pick goes with the save
    const twinName = unique("Twin");
    const otherProduct = await createProductInDomain(workspace.domainId);
    await createEntityInProduct(workspace.domainId, workspace.productId, twinName);
    await createEntityInProduct(workspace.domainId, otherProduct.id, twinName);
    await openEntityPage(page, customer.url, customer.name);
    const current = await readTypeSpecSource(page);
    const withTwin = current.replace(modelHead, `$1  twin: ${twinName};\n`);
    expect(withTwin).not.toBe(current);
    const area = page.getByTestId("typespec-source-textarea");
    // typed and saved as one unit, repeated until it goes through (the tab can reload its source right after it was opened)
    await expect(async () => {
      await area.fill(withTwin);
      await page.getByTestId("typespec-save").click({ timeout: 2_000 });
    }).toPass({ timeout: 30_000 });
    const dialog = page.getByTestId("reference-pick-dialog");
    await expect(dialog).toBeVisible({ timeout: 60_000 });
    await expect(dialog).toContainText(`Field "twin" refers to "${twinName}", which matches 2 entities`);
    await expect(dialog.getByTestId("reference-pick-candidate")).toHaveCount(2);
    await dialog.getByTestId("reference-pick-candidate").filter({ hasText: otherProduct.name }).click();
    await expect(successToast(page, /TypeSpec compiled and applied/)).toBeVisible({ timeout: 60_000 });
    await openEditor(page);
    await expect(centerPanel(page).locator('[data-testid="field-card"][data-field="twin"]')).toContainText(`ref(${qualified(workspace, { name: twinName }, otherProduct.name)})`);
  });
});

test.describe("an imported document", () => {
  test("its $defs become entities that are generated with their parent, and a reference the import could not load stays dangling without failing the generation", { tag: ["@regression"] }, async ({ authedPage: page, workspace }) => {
    test.setTimeout(240_000);
    const parent = unique("Account");
    const child = unique("Location");
    const text = JSON.stringify({
      $schema: DRAFT,
      title: parent,
      type: "object",
      properties: {
        id: { type: "string" },
        site: { $ref: `#/$defs/${child}` },
        created: { $ref: "common/v4/date_time.json" },
      },
      required: ["id"],
      $defs: { [child]: { type: "object", title: child, properties: { city: { type: "string" } } } },
    });

    await pasteAndReview(page, workspace.productUrl, text);
    // the review says what it could not load: the low-confidence marker of an unresolved reference
    await expect(page.getByRole("button", { name: /import \d+ asset/i })).toBeVisible({ timeout: 45_000 });
    await expect(page.locator("main")).toContainText(parent);
    await expect(page.locator("main")).toContainText(child);
    await expect(page.getByTestId("import-dangling-banner")).toContainText("1 reference(s) could not be loaded");
    const parentUrl = await createEntityFromReview(page, workspace.productUrl, parent);

    await openEntityPage(page, parentUrl, parent);
    await expect(centerPanel(page).locator('[data-testid="field-card"][data-field="site"]')).toContainText(child);
    await openSchemasTab(page);
    // every closure target writes the two entities, and the dangling reference does not fail any of them
    for (const key of ["json-schema", "openapi3", "avro", "protobuf", "java-pojo"]) {
      const generated = await generateTarget(page, displayName(key));
      expect(generated.error, key).toBeUndefined();
      expect(await filePaths(page), key).toHaveLength(2);
    }
    expect((await generateTarget(page, displayName("json-schema"))).error).toBeUndefined();
    const files = await fileSet(page);
    const properties = JSON.parse(fileOf(files, parent).content).properties as Record<string, { $ref?: string }>;
    expect(properties.site.$ref).toBe(`${child}.json`);
    // still pointing at the file nobody could load: not typed, not resolved, not dropped
    expect(properties.created.$ref).toBe("common/v4/date_time.json");
    // the child is generated from its own definition
    expect(JSON.parse(fileOf(files, child).content).properties.city).toBeDefined();
  });
});
