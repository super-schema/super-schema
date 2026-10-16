/**
 * Event builder E2E (self-contained events, slice 1; spec 2026-10-15-events-self-contained-design §3 IA + redirects, §7 builder):
 * a product's header New menu → New Event → name → the Event page; in Design a server, a channel whose address has a `{tenantId}`
 * parameter, a message with a payload entity, and an operation; Save; Docs shows the sandboxed AsyncAPI iframe; a reload keeps
 * the saved draft; the product's Events list shows the event; the old `/specs/<id>`, `/messages/*`, `/channels/*` and product
 * `/traits/*` URLs redirect; another id is the 404 page.
 *
 * Everything events-related goes through the real UI. The domain, the product and the payload entity are fixtures (helpers/db.ts);
 * `deleteNavFixtures` removes them in `afterAll` and the domain cascade takes the events with them, edge rows included.
 *
 * The payload entity is never published (a publish writes immutable audit rows that cannot be deleted): the message pins the entity
 * unpinned, which saves as a draft and previews from the entity's current draft.
 *
 * PREREQS: see helpers/auth.ts and helpers/db.ts (PostgreSQL provider, seeded admin, app on :3000).
 *
 * SELECTORS: every locator of the builder sections and the New Event dialog lives in `ID` / the helpers below. The groups say how
 * much to trust them: MERGED ones read from code on the branch; B3 ones follow the Channels / Messages / Operations sections as
 * written in parallel (the `<section>-<field>` test id and `${group}-option-<key>` checkbox conventions); B5a ones are guesses
 * about NewEventDialog / EventsList. If a step fails on a locator, adjust it here, not in the flow.
 */
import type { Locator, Page } from "@playwright/test";
import { test, expect } from "./helpers/auth";
import { createNavFixtures, deleteNavFixtures, disconnectDb, type NavFixtures } from "./helpers/db";

// First visits compile routes in dev, and the preview renders the payload with the real TypeSpec CLI.
test.use({ navigationTimeout: 60_000, actionTimeout: 30_000, screenshot: "only-on-failure", trace: "retain-on-failure" });

const NOT_FOUND_COPY = "This page could not be found";
/** Text a user must never see: driver / Prisma / SQL internals. */
const RAW_DB_TEXT = /prisma|violates|duplicate key|\bP20\d\d\b|ECONNREFUSED|invalid input syntax|relation ".*" does not exist|unique constraint/i;

/** Test ids and labels. */
const ID = {
  // MERGED (B2 builder shell, B4 event page): read from the code on feat/events-self-contained.
  outline: (section: "metadata" | "servers" | "channels" | "messages" | "operations") => `outline-${section}`,
  outlineCount: (section: "servers" | "channels" | "messages" | "operations") => `outline-count-${section}`,
  save: "builder-save",
  status: "builder-status",
  builderError: "builder-error",
  serverKey: "server-key",
  serverKeyValue: "server-key-value",
  serverHost: "server-host",
  tabDocs: "event-tab-docs",
  tabDesign: "event-tab-design",
  previewError: "preview-error",
  previewBlocked: "preview-blocked",
  previewUnsavedNote: "preview-unsaved-note",
  previewIframe: "asyncapi-preview-iframe",
  // Channels / messages / operations sections (identifier = a collapsed <details> holding the rename input; the generated key is
  // committed when focus leaves the item's form, then readable from `<section>-key-value`).
  channelKey: "channel-key",
  channelKeyValue: "channel-key-value",
  channelAddress: "channel-address",
  channelParameters: "channel-parameters",
  channelServerOption: (serverKey: string) => `channel-servers-option-${serverKey}`,
  messageKey: "message-key",
  messageKeyValue: "message-key-value",
  messageTitle: "message-title",
  messageChannelOption: (channelKey: string) => `message-channels-option-${channelKey}`,
  payloadPicker: "payload-picker", // EntityPinPicker's own `${id}-picker` fieldset (id="payload")
  operationKey: "operation-key",
  operationKeyValue: "operation-key-value",
  operationKeyToggle: "operation-key-toggle",
  operationActionSend: "operation-action-send",
  operationChannel: "operation-channel",
  operationMessageOption: (messageKey: string) => `operation-messages-option-${messageKey}`,
  // B5a (CreateDropdown, NewEventDialog, EventsList): GUESSES.
  moreOptions: "More options", // the header menu trigger's title (unchanged from the old flow)
  eventsTab: "events-tab", // kept by the plan
};

let fixtures: NavFixtures | undefined;

/** What the first test creates and the later tests read. */
const flow = {
  s: "",
  eventName: "",
  eventId: "",
  address: "",
  host: "",
  serverKey: "",
  channelKey: "",
  messageKey: "",
  messageTitle: "",
  operationKey: "publishOrderCreated",
};

test.beforeAll(async () => {
  fixtures = await createNavFixtures();
});

test.afterAll(async () => {
  try {
    // Deletes the edge rows first, then the domain: the product with its events (and their edges to the payload entity).
    await deleteNavFixtures(fixtures);
  } finally {
    await disconnectDb();
  }
});

const need = <T>(value: T | undefined, what: string): T => {
  if (value === undefined) throw new Error(`${what} fixture was not created`);
  return value;
};

/*
 * Page content is queried inside the center panel. A hard load (`page.goto` / `reload`) streams the page behind its loading.tsx and
 * Next leaves the streamed segment's hidden copy in <body>, so a bare `page.getByTestId(...)` can resolve to two elements and trip
 * strict mode. Toasts and dialogs render in portals outside the center panel and are queried on `page`.
 */
const centerPanel = (page: Page): Locator => page.getByTestId("center-panel");

const productUrlOf = (f: NavFixtures) => `/schemas/${f.domain.slug}/${f.product.slug}`;

/** Raw driver / Prisma text must never reach a rendered page. */
async function expectNoRawDbText(page: Page) {
  const text = await page.locator("body").innerText();
  expect(text, `a rendered page leaked internal error text (${page.url()})`).not.toMatch(RAW_DB_TEXT);
}

/** The rendered 404 page (a streamed `notFound()` still answers 200, so the DOM is the truth). */
async function expectNotFoundPage(page: Page) {
  await expect(centerPanel(page).getByText(NOT_FOUND_COPY), `${page.url()} should render the 404 page`).toBeVisible({ timeout: 30_000 });
  await expectNoRawDbText(page);
}

/** Header New menu → New Event → name → Create; lands on the Event page and returns the new event's id. */
async function createEventFromMenu(page: Page, productUrl: string, name: string): Promise<string> {
  const main = centerPanel(page);
  await page.goto(productUrl);
  await main.getByTitle(ID.moreOptions).click();
  await main.getByRole("menuitem", { name: /New Event/ }).click();

  const dialog = page.getByRole("dialog");
  await expect(dialog).toBeVisible();
  await dialog.getByRole("textbox", { name: /name/i }).fill(name);
  await dialog.getByRole("button", { name: /^create/i }).click();

  await expect(page).toHaveURL(/\/events\/[^/?]+/, { timeout: 60_000 });
  const id = new URL(page.url()).pathname.split("/events/")[1];
  await expect(main.getByRole("heading", { name })).toBeVisible();
  return id;
}

/** Move focus out of the item's form (to nothing), which is what commits the generated identifier. */
async function leaveForm(page: Page): Promise<void> {
  await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());
}

/** The generated identifier shown by an item's collapsed "Identifier" disclosure (read after focus has left the item's form). */
async function readKey(main: Locator, testId: string, placeholder: string): Promise<string> {
  const value = main.getByTestId(testId);
  // The placeholder key (`server`, `channel`, …) is replaced once the item has something to name it by.
  await expect(value).not.toHaveText(new RegExp(`^\\s*${placeholder}(-\\d+)?\\s*$`), { timeout: 15_000 });
  return ((await value.textContent()) ?? "").trim();
}

/** Servers section: add one and give it a host (its key is generated from the host). Returns the server's key. */
async function addServer(page: Page, host: string): Promise<string> {
  const main = centerPanel(page);
  await main.getByTestId(ID.outline("servers")).click();
  await main.getByRole("button", { name: "Add server" }).click();
  const hostInput = main.getByTestId(ID.serverHost);
  await hostInput.fill(host);
  await leaveForm(page); // the generated key is committed when focus leaves the form
  return readKey(main, ID.serverKeyValue, "server");
}

/** Channels section: add one, give it an address with a `{tenantId}` expression (a parameter row must appear) and put it on the server. Returns its key. */
async function addChannel(page: Page, address: string, serverKey: string): Promise<string> {
  const main = centerPanel(page);
  await main.getByTestId(ID.outline("channels")).click();
  await main.getByRole("button", { name: "Add channel" }).click();
  const addressInput = main.getByTestId(ID.channelAddress);
  await addressInput.fill(address);
  // The parameter named in the address gets its row, so the document is valid without the user adding it.
  await expect(main.getByTestId(ID.channelParameters)).toContainText("tenantId");
  await main.getByTestId(ID.channelServerOption(serverKey)).check();
  await leaveForm(page);
  return readKey(main, ID.channelKeyValue, "channel");
}

/** Messages section: add one with a title and the fixture entity as payload, sent on the channel. Returns its key. */
async function addMessage(page: Page, title: string, payloadEntityName: string, channelKey: string): Promise<string> {
  const main = centerPanel(page);
  await main.getByTestId(ID.outline("messages")).click();
  await main.getByRole("button", { name: "Add message" }).click();
  const titleInput = main.getByTestId(ID.messageTitle);
  await titleInput.fill(title);
  await main.getByTestId(ID.payloadPicker).getByLabel("Payload entity").selectOption({ label: payloadEntityName });
  await main.getByTestId(ID.messageChannelOption(channelKey)).check();
  await leaveForm(page);
  return readKey(main, ID.messageKeyValue, "message");
}

/** Operations section: add a `send` operation on the channel carrying the message; the user renames its identifier on purpose. */
async function addOperation(page: Page, key: string, channelKey: string, messageKey: string): Promise<void> {
  const main = centerPanel(page);
  await main.getByTestId(ID.outline("operations")).click();
  await main.getByRole("button", { name: "Add operation" }).click();
  await main.getByTestId(ID.operationKeyToggle).click(); // the identifier lives in a collapsed disclosure
  const keyInput = main.getByTestId(ID.operationKey);
  await keyInput.fill(key);
  await keyInput.press("Enter"); // a key commits on Enter / blur
  await main.getByTestId(ID.operationActionSend).check();
  await main.getByTestId(ID.operationChannel).selectOption(channelKey);
  await main.getByTestId(ID.operationMessageOption(messageKey)).check();
}

test.describe("event builder end to end", () => {
  // The tests share the state `flow` carries: a failure in the first one makes the rest meaningless.
  test.describe.configure({ mode: "serial" });

  test("New Event → build a server, channel, message and operation → Save → the draft survives a reload", async ({ authedPage: page }) => {
    test.setTimeout(240_000);
    const main = centerPanel(page);
    const f = need(fixtures, "navigation");
    // Uncaught exceptions fail the test.
    const pageErrors: string[] = [];
    page.on("pageerror", (error) => pageErrors.push(error.message));

    flow.s = Date.now().toString(36);
    flow.eventName = `checkout-events-${flow.s}`;
    flow.address = "orders.{tenantId}";
    flow.host = `kafka-${flow.s}.internal:9092`;
    flow.messageTitle = `Order created ${flow.s}`;

    await test.step("create the event from the New menu", async () => {
      flow.eventId = await createEventFromMenu(page, productUrlOf(f), flow.eventName);
      // A new event is a draft with nothing in it yet.
      await expect(main.getByTestId("event-spec-badge")).toContainText("AsyncAPI 3.0");
      await expect(main.getByTestId(ID.outlineCount("servers"))).toHaveText("0");
      await expectNoRawDbText(page);
    });

    await test.step("Design: a server, a channel with an address parameter, a message with a payload entity, an operation", async () => {
      flow.serverKey = await addServer(page, flow.host);
      flow.channelKey = await addChannel(page, flow.address, flow.serverKey);
      flow.messageKey = await addMessage(page, flow.messageTitle, f.productEntity.name, flow.channelKey);
      await addOperation(page, flow.operationKey, flow.channelKey, flow.messageKey);

      // Nothing is saved yet: the bar says so and every section counts one item, with no problem badge.
      await expect(main.getByTestId(ID.status)).toHaveText("Unsaved changes");
      for (const section of ["servers", "channels", "messages", "operations"] as const) {
        await expect(main.getByTestId(ID.outlineCount(section)), `${section} count`).toHaveText("1");
        await expect(main.getByTestId(`outline-problems-${section}`), `${section} problems`).toHaveCount(0);
      }
    });

    await test.step("Save", async () => {
      await main.getByTestId(ID.save).click();
      // The first save compiles the action module and validates every pin, so allow it well beyond the 5s default.
      await expect(page.getByText("Draft saved").first()).toBeVisible({ timeout: 60_000 });
      await expect(main.getByTestId(ID.status)).toHaveText("No unsaved changes");
      await expect(main.getByTestId(ID.builderError)).toHaveCount(0);
      await expectNoRawDbText(page);
    });

    await test.step("reload: the saved draft is still there", async () => {
      await page.reload();
      await expect(main.getByTestId(ID.status)).toHaveText("No unsaved changes", { timeout: 60_000 });
      for (const section of ["servers", "channels", "messages", "operations"] as const) {
        await expect(main.getByTestId(ID.outlineCount(section)), `${section} count after reload`).toHaveText("1");
      }

      await main.getByTestId(ID.outline("servers")).click();
      await expect(main.getByTestId(ID.serverHost)).toHaveValue(flow.host);
      await main.getByTestId(ID.outline("channels")).click();
      await expect(main.getByTestId(ID.channelAddress)).toHaveValue(flow.address);
      await expect(main.getByTestId(ID.channelParameters)).toContainText("tenantId");
      await main.getByTestId(ID.outline("messages")).click();
      await expect(main.getByTestId(ID.messageTitle)).toHaveValue(flow.messageTitle);
      await expect(main.getByTestId(ID.payloadPicker).getByLabel("Payload entity")).toHaveValue(f.productEntity.id);
      await main.getByTestId(ID.outline("operations")).click();
      await expect(main.getByTestId(ID.operationKeyValue)).toHaveText(flow.operationKey);
      await expect(main.getByTestId(ID.operationChannel)).toHaveValue(flow.channelKey);
      await expectNoRawDbText(page);
    });

    expect(pageErrors, "uncaught browser exceptions").toEqual([]);
  });

  test("Docs renders the saved draft in the sandboxed AsyncAPI iframe", async ({ authedPage: page }) => {
    test.setTimeout(240_000);
    const main = centerPanel(page);
    const f = need(fixtures, "navigation");
    const eventUrl = `${productUrlOf(f)}/events/${flow.eventId}`;

    await page.goto(eventUrl);
    await main.getByTestId(ID.tabDocs).click();
    await expect(page).toHaveURL(/[?&]tab=docs\b/);

    // The Docs of a draft with no problems: no "fix the problems" block, no unsaved-changes note, no error, and the iframe.
    const iframe = main.locator(`[data-testid=${ID.previewIframe}]`);
    await expect(iframe).toBeVisible({ timeout: 90_000 });
    // Opaque origin: scripts run, but without allow-same-origin the document cannot reach the app.
    await expect(iframe).toHaveAttribute("sandbox", "allow-scripts");
    await expect(main.getByTestId(ID.previewBlocked)).toHaveCount(0);
    await expect(main.getByTestId(ID.previewUnsavedNote)).toHaveCount(0);
    await expect(main.getByTestId(ID.previewError)).toHaveCount(0);

    // The renderer keeps a second copy of its labels in a collapsed mobile sidebar, so ask for a visible one.
    const rendered = page.frameLocator(`[data-testid=${ID.previewIframe}]`);
    await expect(rendered.getByText("Servers").filter({ visible: true }).first()).toBeVisible({ timeout: 90_000 });
    await expect(rendered.getByText(flow.host).filter({ visible: true }).first()).toBeVisible();
    await expectNoRawDbText(page);

    // A reload keeps the tab (?tab=docs) and Design is one click away, with the draft in it.
    await page.reload();
    await expect(main.locator(`[data-testid=${ID.previewIframe}]`)).toBeVisible({ timeout: 90_000 });
    await main.getByTestId(ID.tabDesign).click();
    await expect(main.getByTestId(ID.outlineCount("operations"))).toHaveText("1");
  });

  test("the product's Events list shows the event and opens it", async ({ authedPage: page }) => {
    test.setTimeout(180_000);
    const main = centerPanel(page);
    const f = need(fixtures, "navigation");
    const productUrl = productUrlOf(f);

    await page.goto(`${productUrl}?tab=events`);
    const list = main.getByTestId(ID.eventsTab);
    await expect(list).toBeVisible({ timeout: 60_000 });
    await expect(list).toContainText(flow.eventName);
    await expectNoRawDbText(page);

    await list.getByRole("link", { name: new RegExp(flow.eventName) }).click();
    await expect(page).toHaveURL(new RegExp(`${productUrl}/events/${flow.eventId}`));
    await expect(main.getByRole("heading", { name: flow.eventName })).toBeVisible({ timeout: 60_000 });
  });

  test("old URLs redirect: /specs/<id> keeps the id, /messages, /channels and product /traits land on the Events list", async ({ authedPage: page }) => {
    test.setTimeout(240_000);
    const main = centerPanel(page);
    const f = need(fixtures, "navigation");
    const productUrl = productUrlOf(f);

    // The old Event Spec URL of the same id: the event page, not a 404 (this id is a v2 event).
    await page.goto(`${productUrl}/specs/${flow.eventId}`);
    await expect(page).toHaveURL(new RegExp(`${productUrl}/events/${flow.eventId}$`), { timeout: 60_000 });
    await expect(main.getByRole("heading", { name: flow.eventName })).toBeVisible({ timeout: 60_000 });

    // The old list URL (any section) still opens the product page's Events list.
    await page.goto(`${productUrl}?tab=events&section=specs`);
    await expect(main.getByTestId(ID.eventsTab)).toContainText(flow.eventName, { timeout: 60_000 });

    // Messages, channels and product traits have no id mapping: any id answers with the Events list, never a 404 or an old page.
    for (const old of ["messages", "channels", "traits"]) {
      await page.goto(`${productUrl}/${old}/e2e-old-${old}-${flow.s}`);
      await expect(page, `/${old}/<id> should redirect to the Events list`).toHaveURL(new RegExp(`${productUrl}\\?(.*&)?tab=events`), { timeout: 60_000 });
      await expect(page).not.toHaveURL(new RegExp(`/${old}/`));
      await expect(main.getByTestId(ID.eventsTab)).toContainText(flow.eventName, { timeout: 60_000 });
      await expectNoRawDbText(page);
    }
  });

  test("an unknown event id is the 404 page, also through the old /specs URL", async ({ authedPage: page }) => {
    test.setTimeout(180_000);
    const f = need(fixtures, "navigation");
    const productUrl = productUrlOf(f);
    const unknownId = `e2e-no-such-event-${flow.s}`;

    await page.goto(`${productUrl}/events/${unknownId}`);
    await expectNotFoundPage(page);

    // The old URL redirects to the same id, which the event page does not know either (a legacy v1 spec lands here too).
    await page.goto(`${productUrl}/specs/${unknownId}`);
    await expect(page).toHaveURL(new RegExp(`${productUrl}/events/${unknownId}$`), { timeout: 60_000 });
    await expectNotFoundPage(page);
  });
});
