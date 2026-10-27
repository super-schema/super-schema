/**
 * External event references E2E (WP-X2; spec 2026-10-15-events-self-contained-design §5 "external references" and the Events completion
 * plan): product A publishes the event "orders" (message `OrderCreated`); product B builds the event "billing", adds that message from
 * "orders" through the "Add from another event" picker, allows it on a channel and receives it in an operation, Save -> no problems,
 * the Code panel's server render holds the reference; A publishes 2.0 -> B shows "v1.0 -> v2.0 available" (a major) and can Update;
 * A's delete is refused while B references it ("referenced by billing") and B's delete of its own event is allowed.
 *
 * DEPENDENCY ON WP-P2: the source event is published through the Publish button of the event page, test id `event-publish`
 * (`PublishVersionButton`), which WP-P2 adds in parallel. This spec is written to type-check and has NOT been run by its author:
 * it can only pass once P2 is merged. Nothing in the unit tests depends on P2.
 *
 * The payload entity of "orders" must be published before the event can be (publish is blocked until every pin is published), so the
 * fixture entity is published once through the entity page. A publish writes immutable rows; deleting the fixture domain in `afterAll`
 * is the sanctioned way to remove them (see helpers/db.ts), and it takes both products' events and their edges with it.
 *
 * PREREQS: see helpers/auth.ts and helpers/db.ts (PostgreSQL provider, seeded admin, app on :3000). Both products live in the one
 * fixture domain (an external reference only needs the same tenant), so a single domain delete cleans everything up.
 *
 * SELECTORS: `ID` below. The builder / event page ones are the ones of events-builder.spec.ts; the external-reference ones are the
 * test ids of `ExternalRefsCard` (`external-ref-*`) and `ExternalRefPicker` (`external-ref-picker`, `external-ref-search`, ...).
 */
import type { Locator, Page } from "@playwright/test";
import { test, expect } from "./helpers/fixtures";
import { createNavFixtures, createProductInDomain, deleteNavFixtures, disconnectDb, type NavFixtures } from "./helpers/db";
import { centerPanel, createEventFromMenu, expectNoRawDbText } from "./helpers/event-builder";

/**
 * What a publish may take, from the click that opens its dialog to the dialog closing. The dialog first renders a preview of the publish
 * with the real TypeSpec CLI, so `confirm-publish` is not there for as long as that takes: well over the 30 s of an action when other
 * specs load the machine (it failed a whole-suite run that way, and the tests that depend on it did not run). `playwright.config.ts`
 * runs this file after the other specs, alone, but a publish is still the slowest thing here and is waited for, not failed.
 */
const PUBLISH_TIMEOUT = 90_000;

const ID = {
  outline: (section: "metadata" | "servers" | "channels" | "messages" | "operations") => `outline-${section}`,
  outlineCount: (section: "channels" | "messages") => `outline-count-${section}`,
  outlineProblems: (section: "servers" | "channels" | "messages" | "operations") => `outline-problems-${section}`,
  save: "builder-save",
  status: "builder-status",
  builderError: "builder-error",
  serverHost: "server-host",
  serverKeyValue: "server-key-value",
  channelAddress: "channel-address",
  channelKeyValue: "channel-key-value",
  channelServerOption: (serverKey: string) => `channel-servers-option-${serverKey}`,
  channelMessageOption: (key: string) => `channel-messages-option-${key}`,
  messageTitle: "message-title",
  messageKeyValue: "message-key-value",
  messageChannelOption: (channelKey: string) => `message-channels-option-${channelKey}`,
  payloadPicker: "payload-picker",
  operationActionReceive: "operation-action-receive",
  operationMessageOption: (key: string) => `operation-messages-option-${key}`,
  // The event page.
  versionBadge: "event-version-badge",
  publish: "event-publish", // WP-P2
  codeToggle: "event-code-toggle",
  codePanel: "event-code-panel",
  codeStatus: "code-status",
  codeText: "event-code-text",
  eventActions: "event-actions",
  deleteEvent: "event-delete",
  deleteError: "event-delete-error",
  // The publish dialogs (entity and event share one).
  confirmPublish: "confirm-publish",
  bumpMajor: "bump-major",
  entityPublish: "publish-entity-button",
  // External references (ExternalRefsCard / ExternalRefPicker).
  refAdd: "external-ref-add",
  refPicker: "external-ref-picker",
  refSearch: "external-ref-search",
  refEvent: (eventId: string) => `external-ref-event-${eventId}`,
  refItem: (itemKey: string) => `external-ref-item-${itemKey}`,
  refKeyValue: "external-ref-key-value",
  refRow: (key: string) => `external-ref-row-${key}`,
  refBadge: (key: string) => `external-ref-badge-${key}`,
  refStatus: (key: string) => `external-ref-status-${key}`,
  refUpdate: (key: string) => `external-ref-update-${key}`,
};

let fixtures: NavFixtures | undefined;

/** What the first tests create and the later tests read. */
const flow = {
  s: "",
  productB: { id: "", name: "", slug: "" },
  sourceName: "",
  sourceId: "",
  sourceChannelKey: "",
  sourceMessageTitle: "",
  sourceMessageKey: "",
  consumerName: "",
  consumerId: "",
  /** The keys B's references got (generated by the picker). */
  messageRefKey: "",
  channelRefKey: "",
};

test.beforeAll(async () => {
  fixtures = await createNavFixtures();
  flow.productB = await createProductInDomain(fixtures.domain.id);
});

test.afterAll(async () => {
  try {
    // The domain delete takes both products, their events and the published versions with it (edge rows are removed first).
    await deleteNavFixtures(fixtures);
  } finally {
    await disconnectDb();
  }
});

const need = <T>(value: T | undefined, what: string): T => {
  if (value === undefined) throw new Error(`${what} fixture was not created`);
  return value;
};

/* `centerPanel`, `expectNoRawDbText` and `createEventFromMenu` come from helpers/event-builder.ts (page content is queried inside the center panel; dialogs and toasts are portals, queried on `page`). */
const productUrlA = (f: NavFixtures) => `/schemas/${f.domain.slug}/${f.product.slug}`;
const productUrlB = (f: NavFixtures) => `/schemas/${f.domain.slug}/${flow.productB.slug}`;

/** Move focus out of the item's form (to nothing), which is what commits a generated identifier. */
async function leaveForm(page: Page): Promise<void> {
  await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());
}

/** The generated identifier of an item, read after focus has left its form (the placeholder is replaced once it has something to name it by). */
async function readKey(main: Locator, testId: string, placeholder: string): Promise<string> {
  const value = main.getByTestId(testId);
  await expect(value).not.toHaveText(new RegExp(`^\\s*${placeholder}(-\\d+)?\\s*$`), { timeout: 15_000 });
  return ((await value.textContent()) ?? "").trim();
}

async function addServer(page: Page, host: string): Promise<string> {
  const main = centerPanel(page);
  await main.getByTestId(ID.outline("servers")).click();
  await main.getByRole("button", { name: "Add server" }).click();
  await main.getByTestId(ID.serverHost).fill(host);
  await leaveForm(page);
  return readKey(main, ID.serverKeyValue, "server");
}

async function addChannel(page: Page, address: string, serverKey: string): Promise<string> {
  const main = centerPanel(page);
  await main.getByTestId(ID.outline("channels")).click();
  await main.getByRole("button", { name: "Add channel" }).click();
  await main.getByTestId(ID.channelAddress).fill(address);
  await main.getByTestId(ID.channelServerOption(serverKey)).check();
  await leaveForm(page);
  return readKey(main, ID.channelKeyValue, "channel");
}

async function addMessage(page: Page, title: string, payloadEntityName: string, channelKey: string): Promise<string> {
  const main = centerPanel(page);
  await main.getByTestId(ID.outline("messages")).click();
  await main.getByRole("button", { name: "Add message" }).click();
  await main.getByTestId(ID.messageTitle).fill(title);
  await main.getByTestId(ID.payloadPicker).getByLabel("Payload entity").selectOption({ label: payloadEntityName });
  await main.getByTestId(ID.messageChannelOption(channelKey)).check();
  await leaveForm(page);
  return readKey(main, ID.messageKeyValue, "message");
}

/** A `send` operation on the channel carrying the message (its key is generated from the action and the channel). */
async function addSendOperation(page: Page, channelKey: string, messageKey: string): Promise<void> {
  const main = centerPanel(page);
  await main.getByTestId(ID.outline("operations")).click();
  await main.getByRole("button", { name: "Add operation", exact: true }).click();
  await main.getByTestId("operation-channel").selectOption(channelKey);
  await main.getByTestId(ID.operationMessageOption(messageKey)).check();
}

async function saveDraft(page: Page): Promise<void> {
  const main = centerPanel(page);
  await main.getByTestId(ID.save).click();
  // The first save compiles the action module and validates every pin, so allow it well beyond the 5s default.
  await expect(page.getByText("Draft saved").first()).toBeVisible({ timeout: 60_000 });
  await expect(main.getByTestId(ID.status)).toHaveText("No unsaved changes");
  await expect(main.getByTestId(ID.builderError)).toHaveCount(0);
  await expectNoRawDbText(page);
}

/**
 * A section's card: Add from another event -> the source event -> its newest version (preselected) -> `itemKey`. Returns the key the
 * picker generated for the reference (it stays behind the collapsed Identifier, but its value is always shown).
 */
async function addExternalRef(page: Page, section: "channels" | "messages", itemKey: string): Promise<string> {
  const main = centerPanel(page);
  await main.getByTestId(ID.outline(section)).click();
  // An event with nothing of its own yet still offers the card, with one primary action.
  await main.getByTestId(ID.refAdd).click();
  const dialog = page.getByTestId(ID.refPicker);
  await expect(dialog).toBeVisible();

  // Step 1: search. The event being edited is never offered (it is unpublished here anyway); the source event is.
  await dialog.getByTestId(ID.refSearch).fill(flow.sourceName);
  // Checked while the list is on screen (step 1), and only once it has loaded: the source event is there, the event being edited is not.
  // After the click the list is gone and "not offered" would hold for any reason.
  await expect(dialog.getByTestId(ID.refEvent(flow.sourceId))).toBeVisible();
  await expect(dialog.getByTestId(ID.refEvent(flow.consumerId))).toHaveCount(0);
  await dialog.getByTestId(ID.refEvent(flow.sourceId)).click();

  // Step 2: the newest version is preselected.
  await expect(dialog.getByRole("radio", { checked: true })).toBeVisible();
  await dialog.getByRole("button", { name: "Next", exact: true }).click();

  // Step 3: the item.
  await dialog.getByTestId(ID.refItem(itemKey)).click();
  const key = ((await dialog.getByTestId(ID.refKeyValue).textContent()) ?? "").trim();
  expect(key).not.toBe("");
  await dialog.getByRole("button", { name: "Add", exact: true }).click();
  await expect(dialog).toHaveCount(0);

  await expect(main.getByTestId(ID.refRow(key))).toBeVisible();
  await expect(main.getByTestId(ID.refBadge(key))).toHaveText("External");
  return key;
}

/** Publish the fixture entity once through its page, so an event can pin a published version of it. */
async function publishFixtureEntity(page: Page, f: NavFixtures): Promise<void> {
  await page.goto(`${productUrlA(f)}/${f.productEntity.slug}`);
  await centerPanel(page).getByTestId(ID.entityPublish).click();
  await page.getByTestId(ID.confirmPublish).click({ timeout: PUBLISH_TIMEOUT }); // waits for the preview
  // The dialog closes once the publish went through.
  await expect(page.getByTestId(ID.confirmPublish)).toHaveCount(0, { timeout: PUBLISH_TIMEOUT });
}

/** Publish the event on the current page with the Publish button (WP-P2). `major` raises the suggested bump to a major. */
async function publishEvent(page: Page, opts: { major?: boolean } = {}): Promise<void> {
  await centerPanel(page).getByTestId(ID.publish).click();
  // Both buttons are in the dialog, which shows them once the preview of the publish has rendered.
  if (opts.major) await page.getByTestId(ID.bumpMajor).click({ timeout: PUBLISH_TIMEOUT });
  await page.getByTestId(ID.confirmPublish).click({ timeout: PUBLISH_TIMEOUT });
  await expect(page.getByTestId(ID.confirmPublish)).toHaveCount(0, { timeout: PUBLISH_TIMEOUT });
}

test.describe("external event references end to end", () => {
  // The tests share the state `flow` carries: a failure in the first one makes the rest meaningless. Each one publishes, builds and saves
  // an event through the real TypeSpec CLI, so each gets 5 minutes (a publish alone may take PUBLISH_TIMEOUT).
  test.describe.configure({ mode: "serial", timeout: 300_000 });

  test("A publishes the event 'orders' with the message OrderCreated", { tag: ["@regression", "@slow"] }, async ({ authedPage: page }) => {
    const main = centerPanel(page);
    const f = need(fixtures, "navigation");
    const pageErrors: string[] = [];
    page.on("pageerror", (error) => pageErrors.push(error.message));

    flow.s = Date.now().toString(36);
    flow.sourceName = `orders-${flow.s}`;
    flow.sourceMessageTitle = `Order created ${flow.s}`;
    flow.consumerName = `billing-${flow.s}`;

    await test.step("publish the payload entity", async () => {
      await publishFixtureEntity(page, f);
    });

    await test.step("build the event: a server, a channel, a message with the published entity, a send operation", async () => {
      flow.sourceId = await createEventFromMenu(page, productUrlA(f), flow.sourceName);
      const serverKey = await addServer(page, `kafka-orders-${flow.s}.internal:9092`);
      flow.sourceChannelKey = await addChannel(page, "orders.v1", serverKey);
      flow.sourceMessageKey = await addMessage(page, flow.sourceMessageTitle, f.productEntity.name, flow.sourceChannelKey);
      await addSendOperation(page, flow.sourceChannelKey, flow.sourceMessageKey);
      for (const section of ["channels", "messages", "operations"] as const) {
        await expect(main.getByTestId(ID.outlineProblems(section)), `${section} problems`).toHaveCount(0);
      }
      await saveDraft(page);
    });

    await test.step("publish it with the Publish button: v1.0", async () => {
      await publishEvent(page);
      await expect(main.getByTestId(ID.versionBadge)).toHaveText("v1.0", { timeout: PUBLISH_TIMEOUT });
    });

    expect(pageErrors, "uncaught browser exceptions").toEqual([]);
  });

  test("B adds a message and a channel from 'orders', uses both in operations, saves with no problem and sees them in the Code panel", { tag: ["@regression", "@slow"] }, async ({ authedPage: page }) => {
    const main = centerPanel(page);
    const f = need(fixtures, "navigation");
    const pageErrors: string[] = [];
    page.on("pageerror", (error) => pageErrors.push(error.message));

    flow.consumerId = await createEventFromMenu(page, productUrlB(f), flow.consumerName);

    await test.step("Messages: Add from another event -> orders -> newest version -> the message", async () => {
      flow.messageRefKey = await addExternalRef(page, "messages", flow.sourceMessageKey);
      // Nothing newer has been published yet: no status line.
      await expect(main.getByTestId(ID.refStatus(flow.messageRefKey))).toHaveCount(0);
      await expect(main.getByTestId(ID.outlineCount("messages"))).toHaveText("1");
    });

    await test.step("Channels: the channel of 'orders' as well", async () => {
      flow.channelRefKey = await addExternalRef(page, "channels", flow.sourceChannelKey);
      await expect(main.getByTestId(ID.outlineCount("channels"))).toHaveText("1");
    });

    await test.step("a local channel that allows the external message; a receive operation on it, and a send operation on the external channel", async () => {
      const serverKey = await addServer(page, `kafka-billing-${flow.s}.internal:9092`);
      const channelKey = await addChannel(page, "billing.v1", serverKey);
      // The external message is offered next to the local ones, marked.
      await main.getByTestId(ID.channelMessageOption(flow.messageRefKey)).check();

      await main.getByTestId(ID.outline("operations")).click();
      await main.getByRole("button", { name: "Add operation", exact: true }).click();
      await main.getByTestId(ID.operationActionReceive).check();
      await main.getByTestId("operation-channel").selectOption(channelKey);
      await main.getByTestId(ID.operationMessageOption(flow.messageRefKey)).check();

      // The external channel is offered by the channel select; on it every message of the event can be used.
      await main.getByRole("button", { name: "Add operation", exact: true }).click();
      await main.getByTestId("operation-channel").selectOption(flow.channelRefKey);
      await main.getByTestId(ID.operationMessageOption(flow.messageRefKey)).check();

      for (const section of ["channels", "messages", "operations"] as const) {
        await expect(main.getByTestId(ID.outlineProblems(section)), `${section} problems`).toHaveCount(0);
      }
    });

    await test.step("Save: no problems, and the server's render holds both references", async () => {
      await saveDraft(page);

      // The Code panel lives in the shell's right panel: open it when it is collapsed. The instant (browser) code leaves external
      // references out; the status chip says `full` once the server's render of exactly this document has arrived.
      const code = page.getByTestId(ID.codePanel);
      if (!(await code.isVisible())) await main.getByTestId(ID.codeToggle).click();
      await expect(code.getByTestId(ID.codeStatus)).toHaveAttribute("data-state", "full", { timeout: 90_000 });
      // The editor draws only the lines in view, so look for what sits near the top of the document (the channels and their messages).
      await expect(code.getByTestId(ID.codeText)).toContainText(flow.channelRefKey, { timeout: 30_000 });
      await expect(code.getByTestId(ID.codeText)).toContainText(flow.messageRefKey, { timeout: 30_000 });
      await expectNoRawDbText(page);
    });

    expect(pageErrors, "uncaught browser exceptions").toEqual([]);
  });

  test("A edits and publishes 2.0; B shows 'v1.0 → v2.0 available' on both references and can update them", { tag: ["@regression", "@slow"] }, async ({ authedPage: page }) => {
    const main = centerPanel(page);
    const f = need(fixtures, "navigation");

    await test.step("A: edit the message title, Save, publish as a major (the user raises the bump)", async () => {
      await page.goto(`${productUrlA(f)}/events/${flow.sourceId}`);
      await main.getByTestId(ID.outline("messages")).click();
      await main.getByTestId(ID.messageTitle).fill(`${flow.sourceMessageTitle} (revised)`);
      await saveDraft(page);
      await publishEvent(page, { major: true });
      await expect(main.getByTestId(ID.versionBadge)).toHaveText("v2.0", { timeout: PUBLISH_TIMEOUT });
    });

    await test.step("B: both references say a newer, major version is available; B's document did not change by itself", async () => {
      await page.goto(`${productUrlB(f)}/events/${flow.consumerId}`);
      for (const [section, key] of [["messages", flow.messageRefKey], ["channels", flow.channelRefKey]] as const) {
        await main.getByTestId(ID.outline(section)).click();
        const status = main.getByTestId(ID.refStatus(key));
        await expect(status, `${section} status`).toContainText("v1.0 → v2.0 available", { timeout: 60_000 });
        await expect(status).toContainText("Major");
      }
      await expect(main.getByTestId(ID.status)).toHaveText("No unsaved changes");
    });

    await test.step("B: Update re-points each reference; Save accepts them", async () => {
      for (const [section, key] of [["messages", flow.messageRefKey], ["channels", flow.channelRefKey]] as const) {
        await main.getByTestId(ID.outline(section)).click();
        await main.getByTestId(ID.refUpdate(key)).click();
        await expect(main.getByTestId(ID.refStatus(key)), `${section} status after Update`).toHaveCount(0, { timeout: 60_000 });
      }
      await expect(main.getByTestId(ID.status)).toHaveText("Unsaved changes");
      await saveDraft(page);
    });
  });

  test("A's delete is refused while billing references it; B's delete of its own event is allowed", { tag: ["@regression", "@slow"] }, async ({ authedPage: page }) => {
    const main = centerPanel(page);
    const f = need(fixtures, "navigation");

    await test.step("A: the delete is refused with the 'referenced by' message naming billing", async () => {
      page.once("dialog", (dialog) => { void dialog.accept(); });
      await page.goto(`${productUrlA(f)}/events/${flow.sourceId}`);
      await main.getByTestId(ID.eventActions).click();
      await page.getByTestId(ID.deleteEvent).click();
      const error = main.getByTestId(ID.deleteError);
      await expect(error).toBeVisible({ timeout: 30_000 });
      await expect(error).toContainText("referenced by");
      await expect(error).toContainText(flow.consumerName);
      await expect(page).toHaveURL(new RegExp(`/events/${flow.sourceId}`));
      await expectNoRawDbText(page);
    });

    await test.step("B: deleting its own event is allowed", async () => {
      page.once("dialog", (dialog) => { void dialog.accept(); });
      await page.goto(`${productUrlB(f)}/events/${flow.consumerId}`);
      await main.getByTestId(ID.eventActions).click();
      await page.getByTestId(ID.deleteEvent).click();
      await expect(page).not.toHaveURL(new RegExp(`/events/${flow.consumerId}`), { timeout: 60_000 });
      await expectNoRawDbText(page);
    });
  });
});
