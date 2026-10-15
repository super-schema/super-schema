/**
 * Events E2E (spec §11, Story 18.8): entity → publish 1.0 → channel → message (pinned payload) → publish → event spec
 * (server + operation) → publish → Document tab download (parsed AsyncAPI 3) → Preview renders → REST serves the stored
 * version → sidebar shows the Events leaves with counts; then a consumer spec in a SECOND product of the same domain
 * references the first product's published message and channel, and the owner's pages are read through the R76 policy
 * (another product's message / event spec = published version only, read-only; its draft is never shown).
 *
 * Everything events-related goes through the real UI; the domain, both products and the payload entity are fixtures
 * (see helpers/db.ts) and are removed in `afterAll`, edge rows included.
 *
 * Publishes write immutable PUBLISH_VERSION audit rows that cannot be deleted, so the spec publishes the minimum:
 * entity 1.0, message 1.0 and event spec 1.0 (three). The consumer spec is saved but never published.
 *
 * PREREQS: see helpers/auth.ts and helpers/db.ts (PostgreSQL provider, seeded admin, running dev server on :3000).
 * The server must have been (re)started with the current next.config.ts: entity publish compiles TypeSpec in-process,
 * which needs `serverExternalPackages: ["@typespec/compiler"]` (a server started earlier reports "Cannot find module as
 * expression is too dynamic" in the publish dialog).
 */
import { readFileSync } from "node:fs";
import type { Locator, Page } from "@playwright/test";
import { parse as parseYaml } from "yaml";
import { test, expect } from "./helpers/auth";
import {
  createForeignTenantSpec,
  createNavFixtures,
  createProductInDomain,
  deleteForeignTenantSpec,
  deleteNavFixtures,
  disconnectDb,
  type ForeignTenantSpec,
  type NavFixtures,
} from "./helpers/db";

// First visits compile routes in dev, and publishing renders payloads with the real TypeSpec CLI.
test.use({ navigationTimeout: 60_000, actionTimeout: 30_000, screenshot: "only-on-failure", trace: "retain-on-failure" });

const NOT_FOUND_COPY = "This page could not be found";
/** Text a user must never see: driver / Prisma / SQL internals. */
const RAW_DB_TEXT = /prisma|violates|duplicate key|\bP20\d\d\b|ECONNREFUSED|invalid input syntax|relation ".*" does not exist|unique constraint/i;

let fixtures: NavFixtures | undefined;
let consumerProduct: { id: string; name: string; slug: string } | undefined;
let foreignSpec: ForeignTenantSpec | undefined;

/** What the first test creates and the later tests read. */
const flow = {
  s: "",
  channelName: "",
  address: "",
  messageName: "",
  specName: "",
  channelId: "",
  messageId: "",
  specId: "",
};

test.beforeAll(async () => {
  fixtures = await createNavFixtures();
  try {
    consumerProduct = await createProductInDomain(fixtures.domain.id);
    foreignSpec = await createForeignTenantSpec();
  } catch (error) {
    await deleteForeignTenantSpec(foreignSpec);
    await deleteNavFixtures(fixtures);
    await disconnectDb();
    throw error;
  }
});

test.afterAll(async () => {
  try {
    await deleteForeignTenantSpec(foreignSpec);
  } finally {
    try {
      // Deletes the edge rows first, then the domain: both products with their channels, messages, specs and versions.
      await deleteNavFixtures(fixtures);
    } finally {
      await disconnectDb();
    }
  }
});

/*
 * Page content is always queried inside the center panel (`main` below). A hard load (`page.goto`) streams the page behind
 * its loading.tsx and Next leaves the streamed segment's hidden copy (`div#S:n[hidden]`) in <body>, so a bare
 * `page.getByTestId(...)` can resolve to two elements (one hidden) and trip strict mode. Toasts and dialogs render in
 * portals outside the center panel and are queried on `page`.
 */
const need = <T>(value: T | undefined, what: string): T => {
  if (value === undefined) throw new Error(`${what} fixture was not created`);
  return value;
};

/** Raw driver / Prisma text must never reach a rendered page. */
async function expectNoRawDbText(page: Page) {
  const text = await page.locator("body").innerText();
  expect(text, `a rendered page leaked internal error text (${page.url()})`).not.toMatch(RAW_DB_TEXT);
}

/** The rendered 404 page (a streamed `notFound()` still answers 200, so the DOM is the truth). */
async function expectNotFoundPage(page: Page, url: string) {
  const main = page.getByTestId("center-panel");
  await page.goto(url);
  await expect(main.getByText(NOT_FOUND_COPY), `${url} should render the 404 page`).toBeVisible({ timeout: 30_000 });
  await expectNoRawDbText(page);
}

/** Open a product's workspace and pick an item of the header New menu. */
async function openNewMenuItem(page: Page, productUrl: string, item: RegExp) {
  const main = page.getByTestId("center-panel");
  await page.goto(productUrl);
  await page.getByTitle("More options").click();
  await main.getByRole("menuitem", { name: item }).click();
}

/** The publish dialog shared by entities, messages and event specs: confirm the suggested first version. */
async function confirmPublish(page: Page) {
  const confirm = page.getByTestId("confirm-publish");
  await expect(confirm).toBeEnabled({ timeout: 30_000 });
  await confirm.click();
}

const channelOptionLabel = (name: string, address: string, owner?: string) =>
  `${name} — ${address} (kafka/avro)${owner ? ` · ${owner}` : ""}`;

/** Fill the editor's server + operation rows and save the draft (shared by the first spec and the consumer spec). */
async function fillSpecAndSave(
  page: Page,
  input: { serverKey: string; host: string; operationKey: string; action: "send" | "receive"; channelLabel: string; messageLabel: string }
) {
  const main = page.getByTestId("center-panel");
  await main.getByTestId("spec-add-server").click();
  const server = main.getByTestId("spec-server-0");
  await server.getByLabel("Key").fill(input.serverKey);
  await server.getByLabel("Protocol").fill("kafka");
  await server.getByLabel("Host").fill(input.host);

  await main.getByTestId("spec-add-operation").click();
  const op = main.getByTestId("spec-operation-0");
  await op.getByLabel("Key").fill(input.operationKey);
  await op.getByLabel("Action").selectOption(input.action);
  await op.getByLabel("Channel").selectOption({ label: input.channelLabel });
  await op.getByLabel(input.messageLabel).check();
  await main.getByTestId("spec-save").click();
  // The first save compiles the action module in dev and validates every pin, so allow it well beyond the 5s default.
  await expect(page.getByText("Draft saved").first()).toBeVisible({ timeout: 60_000 });
}

/**
 * Diagnostics tab: the draft renders and the real @asyncapi/parser reports no error and no warning. An info-level lint
 * (`asyncapi-latest-version`: the document says 3.0.0, the parser knows 3.1.0) is allowed, so "clean" is either the
 * "No problems found" copy or an "0 errors · 0 warnings" summary.
 */
async function expectDiagnosticsClean(page: Page) {
  const main = page.getByTestId("center-panel");
  await main.getByRole("tab", { name: "Diagnostics" }).click();
  const list = main.getByTestId("diagnostics-list");
  await expect(list).toContainText(/validates with @asyncapi\/parser|0 errors · 0 warnings/, { timeout: 90_000 });
  await expect(list.getByText("error", { exact: true })).toHaveCount(0);
  await expect(list.getByText("warning", { exact: true })).toHaveCount(0);
}

/**
 * The "Used by" panel of the page's content. A hard load streams the page behind its loading.tsx, so the panel can exist
 * twice for a moment (the streamed copy outside the center panel); the center panel holds exactly the rendered one.
 */
const usedByPanel = (page: Page): Locator => page.getByTestId("center-panel").getByTestId("used-by-panel");

const frameOf = (page: Page): Locator => page.getByTestId("center-panel").locator("[data-testid=asyncapi-preview-iframe]");

test.describe("events end to end", () => {
  // The tests share the state `flow` carries: a failure in the first one makes the rest meaningless.
  test.describe.configure({ mode: "serial" });

  test("design an event: entity → channel → message → event spec, each published once", async ({ authedPage: page }) => {
    test.setTimeout(360_000);
    const main = page.getByTestId("center-panel");
    const f = need(fixtures, "navigation");
    flow.s = Date.now().toString(36);
    flow.channelName = `orders-${flow.s}`;
    flow.address = `payments.orders.${flow.s}`;
    flow.messageName = `OrderCreated${flow.s}`;
    flow.specName = `checkout-service-${flow.s}`;
    const productUrl = `/schemas/${f.domain.slug}/${f.product.slug}`;

    // 1. Publish the payload entity 1.0 (entity Versions tab).
    await page.goto(`${productUrl}/${f.productEntity.slug}`);
    await main.getByTestId("tab-versions").click();
    await main.getByTestId("versions-publish-button").click();
    await confirmPublish(page);
    await expect(main.getByTestId("entity-version-list")).toContainText("v1.0", { timeout: 60_000 });

    // 2. Channel, from the product New menu.
    await openNewMenuItem(page, productUrl, /New Channel/);
    const channelForm = main.getByTestId("new-channel-form");
    await channelForm.getByLabel("Channel name").fill(flow.channelName);
    await channelForm.getByLabel("Address").fill(flow.address);
    await channelForm.getByRole("button", { name: "Create" }).click();
    await expect(page).toHaveURL(/\/channels\/[^/?]+$/);
    flow.channelId = new URL(page.url()).pathname.split("/channels/")[1];
    await expect(main.getByRole("heading", { name: flow.channelName })).toBeVisible();
    await expectNoRawDbText(page);

    // 3. Message pinned to the published entity version, then publish 1.0.
    await openNewMenuItem(page, productUrl, /New Message/);
    const messageForm = main.getByTestId("new-message-form");
    await messageForm.getByLabel("Message name").fill(flow.messageName);
    await messageForm.getByLabel("Payload entity").selectOption({ label: `${f.productEntity.name} (v1.0)` });
    await messageForm.getByRole("button", { name: "Create" }).click();
    await expect(page).toHaveURL(/\/messages\/[^/?]+$/);
    flow.messageId = new URL(page.url()).pathname.split("/messages/")[1];
    await main.getByTestId("message-publish").click();
    await confirmPublish(page);
    await expect(main.getByTestId("event-version-list")).toContainText("v1.0", { timeout: 60_000 });
    await expectNoRawDbText(page);

    // 4. Event spec: a server and a send operation on the channel carrying the message version; save; validate; publish.
    await openNewMenuItem(page, productUrl, /New Event Spec/);
    const specForm = main.getByTestId("new-event-spec-form");
    await specForm.getByLabel("Event spec name").fill(flow.specName);
    await specForm.getByRole("button", { name: "Create" }).click();
    await expect(page).toHaveURL(/\/specs\/[^/?]+/);
    flow.specId = new URL(page.url()).pathname.split("/specs/")[1];

    await fillSpecAndSave(page, {
      serverKey: "kafka-prod",
      host: "kafka-prod.internal:9092",
      operationKey: "publishOrderCreated",
      action: "send",
      channelLabel: channelOptionLabel(flow.channelName, flow.address),
      messageLabel: `${flow.messageName} v1.0`,
    });
    await expectDiagnosticsClean(page);

    await main.getByTestId("spec-publish").click();
    await confirmPublish(page);
    await expect(page.getByText(`Published ${flow.specName} v1.0`).first()).toBeVisible({ timeout: 90_000 });
    await expect(main.getByText("viewing v1.0")).toHaveCount(0);
    await main.getByRole("tab", { name: "Versions" }).click();
    await expect(main.getByTestId("event-version-list")).toContainText("v1.0");
    await expectNoRawDbText(page);
  });

  test("the published spec: Document download, Preview, REST and the sidebar leaves", async ({ authedPage: page }) => {
    test.setTimeout(240_000);
    const main = page.getByTestId("center-panel");
    // Uncaught exceptions and React list-key warnings (the Document tab once raised one per YAML line) fail the test.
    const pageErrors: string[] = [];
    page.on("pageerror", (error) => pageErrors.push(error.message));
    page.on("console", (message) => {
      if (message.type() === "error" && /unique "key" prop/.test(message.text())) pageErrors.push(message.text().slice(0, 200));
    });
    const f = need(fixtures, "navigation");
    const productUrl = `/schemas/${f.domain.slug}/${f.product.slug}`;

    // Document: download the YAML of the STORED version.
    await page.goto(`${productUrl}/specs/${flow.specId}?version=1.0&tab=document`);
    await expect(main.getByText("v1.0 (stored)")).toBeVisible({ timeout: 60_000 });
    const [download] = await Promise.all([page.waitForEvent("download"), main.getByTestId("document-download").click()]);
    expect(download.suggestedFilename()).toBe(`${flow.specName}-1.0.asyncapi.yaml`);
    const downloaded = readFileSync(await download.path(), "utf8");
    const doc = parseYaml(downloaded) as {
      asyncapi: string;
      info: { title: string; version: string };
      servers: Record<string, { host: string; protocol: string }>;
      channels: Record<string, { address?: string; messages?: Record<string, unknown> }>;
      operations: Record<string, { action: string; channel: { $ref: string } }>;
      components?: { messages?: Record<string, { name?: string; payload?: { schemaFormat?: string; schema?: { type?: string; name?: string } } }> };
    };
    expect(doc.asyncapi).toMatch(/^3\.\d+\.\d+$/);
    expect(doc.info).toMatchObject({ title: flow.specName, version: "1.0" });
    expect(doc.servers["kafka-prod"]).toMatchObject({ host: "kafka-prod.internal:9092", protocol: "kafka" });
    const [channelKey, channel] = Object.entries(doc.channels).find(([, c]) => c.address === flow.address) ?? [];
    expect(channelKey, `no channel with address ${flow.address} in the downloaded document`).toBeDefined();
    expect(Object.keys(channel?.messages ?? {}).length).toBeGreaterThan(0);
    expect(doc.operations.publishOrderCreated).toMatchObject({ action: "send", channel: { $ref: `#/channels/${channelKey}` } });
    const messages = Object.values(doc.components?.messages ?? {});
    expect(messages.length).toBeGreaterThan(0);
    const payload = messages[0].payload;
    expect(payload?.schemaFormat).toMatch(/avro/i);
    expect(payload?.schema).toMatchObject({ type: "record", name: f.productEntity.name });

    // The JSON toggle shows the same stored document.
    await main.getByRole("button", { name: "JSON", exact: true }).click();
    await expect(main.getByTestId("document-text")).toContainText(`"asyncapi"`);
    await expect(main.getByTestId("document-text")).toContainText(flow.address);

    // Preview renders inside the sandboxed iframe (opaque origin: no allow-same-origin).
    await main.getByRole("tab", { name: "Preview" }).click();
    const iframe = frameOf(page);
    await expect(iframe).toBeVisible({ timeout: 60_000 });
    await expect(iframe).toHaveAttribute("sandbox", "allow-scripts");
    // The renderer keeps a second copy of the title in its collapsed mobile sidebar, so ask for a visible one.
    const rendered = page.frameLocator("[data-testid=asyncapi-preview-iframe]");
    await expect(rendered.getByText(flow.specName).filter({ visible: true }).first()).toBeVisible({ timeout: 90_000 });
    await expect(rendered.getByText("Servers").filter({ visible: true }).first()).toBeVisible();
    await expect(rendered.getByText("kafka-prod.internal:9092").filter({ visible: true }).first()).toBeVisible();
    await expectNoRawDbText(page);

    // REST serves the stored version: default (latest published, YAML) and ?version=1.0&format=json.
    const latest = await page.request.get(`/api/v1/event-specs/${flow.specId}`);
    expect(latest.status()).toBe(200);
    expect(latest.headers()["content-type"]).toContain("yaml");
    expect(latest.headers()["x-event-spec-version"]).toBe("1.0");
    expect(latest.headers()["content-disposition"]).toContain(`${flow.specName}-1.0.asyncapi.yaml`);
    const latestDoc = parseYaml(await latest.text()) as { asyncapi: string; info: { version: string } };
    expect(latestDoc).toMatchObject({ info: { version: "1.0" } });
    expect(latestDoc.asyncapi).toMatch(/^3\./);

    const asJson = await page.request.get(`/api/v1/event-specs/${flow.specId}?version=1.0&format=json`);
    expect(asJson.status()).toBe(200);
    expect(asJson.headers()["content-type"]).toContain("json");
    expect(await asJson.json()).toEqual(parseYaml(downloaded));

    // Unknown version and a malformed one: JSON error envelopes, no internals.
    const missingVersion = await page.request.get(`/api/v1/event-specs/${flow.specId}?version=9.9`);
    expect(missingVersion.status()).toBe(404);
    expect(await missingVersion.text()).not.toMatch(RAW_DB_TEXT);
    expect((await page.request.get(`/api/v1/event-specs/${flow.specId}?version=banana`)).status()).toBe(400);

    // The sidebar shows the Events leaves of this product with their counts, and a leaf opens its list.
    await page.goto(productUrl);
    const sidebar = page.getByTestId("left-sidebar");
    const specsLeaf = sidebar.getByTestId(`product-${f.product.id}-event-specs`);
    const messagesLeaf = sidebar.getByTestId(`product-${f.product.id}-messages`);
    const channelsLeaf = sidebar.getByTestId(`product-${f.product.id}-channels`);
    await expect(specsLeaf).toBeVisible({ timeout: 30_000 });
    await expect(specsLeaf).toContainText(/Event Specs\s*1\b/);
    await expect(messagesLeaf).toContainText(/Messages\s*1\b/);
    await expect(channelsLeaf).toContainText(/Channels\s*1\b/);

    await messagesLeaf.click();
    await expect(page).toHaveURL(/tab=events/);
    await expect(page).toHaveURL(/section=messages/);
    await expect(main.getByTestId("events-messages")).toContainText(flow.messageName);
    await expect(main.getByTestId("events-messages")).toContainText("v1.0");
    await main.getByTestId("events-messages").getByRole("link", { name: new RegExp(flow.messageName) }).click();
    await expect(page).toHaveURL(new RegExp(`/messages/${flow.messageId}$`));
    await expect(main.getByRole("heading", { name: flow.messageName })).toBeVisible();

    // "Used by event specs" lists the published spec that carries the message.
    await expect(usedByPanel(page)).toContainText(`Event spec ${flow.specName} v1.0`, { timeout: 30_000 });
    await expectNoRawDbText(page);
    expect(pageErrors, "uncaught browser exceptions").toEqual([]);
  });

  test("a consumer spec in another product references the published message and channel (read-only owner pages)", async ({
    authedPage: page,
  }) => {
    test.setTimeout(360_000);
    const main = page.getByTestId("center-panel");
    const f = need(fixtures, "navigation");
    const b = need(consumerProduct, "second product");
    const productUrl = `/schemas/${f.domain.slug}/${f.product.slug}`;
    const consumerUrl = `/schemas/${f.domain.slug}/${b.slug}`;
    const ownerLabel = `${f.domain.name} / ${f.product.name}`;
    const consumerName = `consumer-${flow.s}`;

    // 1. Product B: a new spec whose operation receives product A's message from product A's channel.
    await openNewMenuItem(page, consumerUrl, /New Event Spec/);
    const specForm = main.getByTestId("new-event-spec-form");
    await specForm.getByLabel("Event spec name").fill(consumerName);
    await specForm.getByRole("button", { name: "Create" }).click();
    await expect(page).toHaveURL(new RegExp(`${consumerUrl}/specs/[^/?]+`));
    const consumerId = new URL(page.url()).pathname.split("/specs/")[1];

    // The foreign channel sits in its own read-only group, labelled with its owner; the foreign message version too.
    await expect(main.getByTestId("spec-editor-form")).toBeVisible();
    await main.getByTestId("spec-add-operation").click();
    const op = main.getByTestId("spec-operation-0");
    const foreignGroup = op.getByLabel("Channel").locator("optgroup[label='Other products (read-only)']");
    await expect(foreignGroup.locator("option", { hasText: flow.channelName })).toHaveCount(1);
    await expect(op.getByLabel(`${flow.messageName} v1.0`)).toBeVisible();
    await expect(op.locator("label", { hasText: `${flow.messageName} v1.0` })).toContainText(ownerLabel);
    await main.getByRole("button", { name: "Remove operation" }).click();

    await fillSpecAndSave(page, {
      serverKey: "kafka-consumer",
      host: "kafka-prod.internal:9092",
      operationKey: "onOrderCreated",
      action: "receive",
      channelLabel: channelOptionLabel(flow.channelName, flow.address, ownerLabel),
      messageLabel: `${flow.messageName} v1.0`,
    });
    // The cross-product consumer emits with zero errors (the published message version resolves across products).
    await expectDiagnosticsClean(page);
    await expectNoRawDbText(page);

    // 2. Click the reference from the OWNER side: product A's message lists the consumer under "Used by", and the link
    //    leads into product B's Events tab, where the consumer spec is listed and opens.
    await page.goto(`${productUrl}/messages/${flow.messageId}`);
    const usedBy = usedByPanel(page);
    await expect(usedBy).toContainText(`Event spec ${consumerName}`, { timeout: 30_000 });
    await expect(usedBy).toContainText(`Event spec ${flow.specName} v1.0`);
    await usedBy.getByRole("link", { name: new RegExp(`Event spec ${consumerName}`) }).click();
    await expect(page).toHaveURL(new RegExp(`${consumerUrl}\\?.*tab=events`));
    await expect(main.getByTestId("events-specs")).toContainText(consumerName);
    await main.getByTestId("events-specs").getByRole("link", { name: new RegExp(consumerName) }).click();
    await expect(page).toHaveURL(new RegExp(`${consumerUrl}/specs/${consumerId}$`));
    await expect(main.getByRole("heading", { name: consumerName })).toBeVisible();

    // 3. R76 — product A's message through product B's route: a PUBLISHED version only, read-only, draft never shown.
    await expectNotFoundPage(page, `${consumerUrl}/messages/${flow.messageId}`);
    await page.goto(`${consumerUrl}/messages/${flow.messageId}?version=1.0`);
    const versionView = main.getByTestId("message-version-view");
    await expect(versionView).toBeVisible({ timeout: 30_000 });
    await expect(versionView).toContainText("Viewing v1.0 (published, read-only)");
    await expect(versionView).toContainText(`Owned by ${ownerLabel}`);
    await expect(versionView).toContainText(`Payload: ${f.productEntity.name} v1.0`);
    await expect(main.getByTestId("message-publish")).toHaveCount(0);
    await expect(main.getByTestId("message-editor-form")).toHaveCount(0);
    await expect(main.getByTestId("message-save")).toHaveCount(0);
    await expect(main.getByText("Back to draft")).toHaveCount(0);
    await expectNoRawDbText(page);

    // ...and the owner link leads to the owning product's page for the same version, whose draft is one click away.
    await versionView.getByRole("link", { name: "open in its own product" }).click();
    await expect(page).toHaveURL(new RegExp(`${productUrl}/messages/${flow.messageId}\\?version=1\\.0$`));
    await expect(main.getByTestId("message-version-view")).toContainText("Viewing v1.0 (published, read-only)");
    await expect(main.getByTestId("message-version-view")).not.toContainText("Owned by");
    await main.getByRole("link", { name: "Back to draft" }).click();
    await expect(page).toHaveURL(new RegExp(`${productUrl}/messages/${flow.messageId}$`));
    await expect(main.getByTestId("message-editor-form")).toBeVisible();
    await expect(main.getByTestId("message-publish")).toBeVisible();

    // 4. The same policy for product A's event spec through product B's route.
    await expectNotFoundPage(page, `${consumerUrl}/specs/${flow.specId}`);
    await page.goto(`${consumerUrl}/specs/${flow.specId}?version=1.0`);
    const owner = main.getByTestId("spec-owner");
    await expect(owner).toBeVisible({ timeout: 30_000 });
    await expect(owner).toContainText(`Owned by ${ownerLabel} (read-only here)`);
    await expect(main.getByText("viewing v1.0")).toBeVisible();
    await expect(main.getByTestId("spec-publish")).toHaveCount(0);
    await expect(main.getByTestId("spec-editor-form")).toHaveCount(0);
    await expect(main.getByRole("tab", { name: "Editor" })).toBeDisabled();
    await expect(main.getByTestId("document-text")).toContainText(flow.address, { timeout: 60_000 });
    await expectNoRawDbText(page);
    await owner.getByRole("link", { name: "open in its own product" }).click();
    await expect(page).toHaveURL(new RegExp(`${productUrl}/specs/${flow.specId}\\?version=1\\.0$`));
    await main.getByRole("link", { name: "Back to draft" }).click();
    await expect(page).toHaveURL(new RegExp(`${productUrl}/specs/${flow.specId}$`));
    await expect(main.getByTestId("spec-publish")).toBeVisible();
    await expect(main.getByTestId("spec-editor-form")).toBeVisible();

    // 5. Channels have no cross-product read view: another product's channel id is a plain 404 on this route.
    await expectNotFoundPage(page, `${consumerUrl}/channels/${flow.channelId}`);

    // 6. REST: a never-published spec has no default version; its draft is still readable by its tenant.
    const noVersion = await page.request.get(`/api/v1/event-specs/${consumerId}`);
    expect(noVersion.status()).toBe(404);
    expect(await noVersion.text()).not.toMatch(RAW_DB_TEXT);
    const draft = await page.request.get(`/api/v1/event-specs/${consumerId}?version=draft&format=json`);
    expect(draft.status()).toBe(200);
    expect(draft.headers()["x-event-spec-version"]).toBe("draft");
    const draftDoc = (await draft.json()) as { asyncapi: string; operations: Record<string, { action: string }> };
    expect(draftDoc.asyncapi).toMatch(/^3\./);
    expect(draftDoc.operations.onOrderCreated).toMatchObject({ action: "receive" });
  });

  test("unknown and foreign-tenant ids answer 404 everywhere, without internals", async ({ authedPage: page, request }) => {
    test.setTimeout(240_000);
    const f = need(fixtures, "navigation");
    const foreign = need(foreignSpec, "foreign tenant");
    const productUrl = `/schemas/${f.domain.slug}/${f.product.slug}`;
    const unknownId = `e2e-no-such-spec-${flow.s}`;

    // Pages: unknown id, another tenant's id (even with a published-looking version) and malformed versions are all the 404 page.
    await expectNotFoundPage(page, `${productUrl}/specs/${unknownId}`);
    await expectNotFoundPage(page, `${productUrl}/specs/${foreign.specId}`);
    await expectNotFoundPage(page, `${productUrl}/specs/${foreign.specId}?version=1.0`);
    await expectNotFoundPage(page, `${productUrl}/specs/${flow.specId}?version=99999999999.0`);
    await expectNotFoundPage(page, `${productUrl}/messages/${unknownId}?version=1.0`);
    await expectNotFoundPage(page, `${productUrl}/channels/${unknownId}`);

    // REST: unknown and foreign ids are indistinguishable (same status, same envelope).
    const unknown = await page.request.get(`/api/v1/event-specs/${unknownId}`);
    const other = await page.request.get(`/api/v1/event-specs/${foreign.specId}`);
    expect(unknown.status()).toBe(404);
    expect(other.status()).toBe(404);
    const unknownBody = await unknown.text();
    expect(await other.text()).toBe(unknownBody);
    expect(unknownBody).not.toMatch(RAW_DB_TEXT);
    expect((await page.request.get(`/api/v1/event-specs/${foreign.specId}?version=draft`)).status()).toBe(404);

    // A caller without a session gets 401, never the document.
    const anonymous = await request.get(`/api/v1/event-specs/${flow.specId}?version=1.0`, { maxRedirects: 0 });
    expect(anonymous.status()).toBe(401);
  });
});
