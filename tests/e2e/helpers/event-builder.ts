/**
 * Event builder flows shared by the specs that need a built event (a minimal server, channel, message and operation). They drive the
 * real UI exactly like `events-builder.spec.ts` (the template they were taken from); a locator that no longer matches is fixed HERE.
 *
 * Page content is queried inside the center panel. A hard load (`page.goto` / `reload`) streams the page behind its loading.tsx and
 * Next leaves the streamed segment's hidden copy in <body>, so a bare `page.getByTestId(...)` can resolve to two elements and trip
 * strict mode. Toasts and dialogs render in portals outside the center panel and are queried on `page`.
 */
import { expect, type Locator, type Page } from "@playwright/test";
import type { NavFixtures } from "./db";

/** Text a user must never see: driver / Prisma / SQL internals. */
export const RAW_DB_TEXT = /prisma|violates|duplicate key|\bP20\d\d\b|ECONNREFUSED|invalid input syntax|relation ".*" does not exist|unique constraint/i;

/** Test ids of the builder sections the flows touch. */
export const BUILDER_ID = {
  outline: (section: "metadata" | "servers" | "channels" | "messages" | "operations") => `outline-${section}`,
  save: "builder-save",
  status: "builder-status",
  serverKeyValue: "server-key-value",
  serverHost: "server-host",
  channelKeyValue: "channel-key-value",
  channelAddress: "channel-address",
  channelParameters: "channel-parameters",
  channelServerOption: (serverKey: string) => `channel-servers-option-${serverKey}`,
  messageKeyValue: "message-key-value",
  messageTitle: "message-title",
  messageChannelOption: (channelKey: string) => `message-channels-option-${channelKey}`,
  payloadPicker: "payload-picker", // EntityPinPicker's own `${id}-picker` fieldset (id="payload")
  operationKey: "operation-key",
  operationKeyToggle: "operation-key-toggle",
  operationActionSend: "operation-action-send",
  operationChannel: "operation-channel",
  operationMessageOption: (messageKey: string) => `operation-messages-option-${messageKey}`,
  moreOptions: "More options", // the product header's menu trigger (a title)
} as const;

export const centerPanel = (page: Page): Locator => page.getByTestId("center-panel");

/**
 * The explorer. It sits behind a Suspense boundary, and for about 60 ms after a hard load the page holds two of it: the one in place and
 * the streamed segment's hidden copy (`div#S:0[hidden]` in <body>), so a bare `page.getByTestId("left-sidebar")` can resolve to two
 * elements and trip strict mode (a third of the rapid `layout.spec` runs on a production build). Whatever sits under a `[hidden]`
 * ancestor is left out. The loading skeleton has a test id of its own, `left-sidebar-fallback`. A collapsed sidebar has no width and
 * is not "visible" to Playwright, which is why this is a selector and not `.filter({ visible: true })`.
 */
export const leftSidebar = (page: Page): Locator => page.locator('[data-testid="left-sidebar"]:not([hidden] *)');

export const productUrlOf = (f: NavFixtures) => `/schemas/${f.domain.slug}/${f.product.slug}`;

/** Raw driver / Prisma text must never reach a rendered page. */
export async function expectNoRawDbText(page: Page) {
  const text = await page.locator("body").innerText();
  expect(text, `a rendered page leaked internal error text (${page.url()})`).not.toMatch(RAW_DB_TEXT);
}

/** Header New menu → New Event: the New Event dialog, open. */
export async function openNewEventDialog(page: Page, productUrl: string): Promise<Locator> {
  const main = centerPanel(page);
  await page.goto(productUrl);
  await main.getByTitle(BUILDER_ID.moreOptions).click();
  await main.getByRole("menuitem", { name: /New Event/ }).click();

  const dialog = page.getByRole("dialog");
  await expect(dialog).toBeVisible();
  return dialog;
}

/** Header New menu → New Event → name → Create; lands on the Event page and returns the new event's id. */
export async function createEventFromMenu(page: Page, productUrl: string, name: string): Promise<string> {
  const main = centerPanel(page);
  const dialog = await openNewEventDialog(page, productUrl);
  await dialog.getByRole("textbox", { name: /name/i }).fill(name);
  await dialog.getByRole("button", { name: /^create/i }).click();

  await expect(page).toHaveURL(/\/events\/[^/?]+/, { timeout: 60_000 });
  const id = new URL(page.url()).pathname.split("/events/")[1];
  await expect(main.getByRole("heading", { name })).toBeVisible();
  return id;
}

/** Move focus out of the item's form (to nothing), which is what commits the generated identifier. */
export async function leaveForm(page: Page): Promise<void> {
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
export async function addServer(page: Page, host: string): Promise<string> {
  const main = centerPanel(page);
  await main.getByTestId(BUILDER_ID.outline("servers")).click();
  await main.getByRole("button", { name: "Add server" }).click();
  await main.getByTestId(BUILDER_ID.serverHost).fill(host);
  await leaveForm(page);
  return readKey(main, BUILDER_ID.serverKeyValue, "server");
}

/** Channels section: add one with an address, on the server. Returns its key. */
export async function addChannel(page: Page, address: string, serverKey: string): Promise<string> {
  const main = centerPanel(page);
  await main.getByTestId(BUILDER_ID.outline("channels")).click();
  await main.getByRole("button", { name: "Add channel" }).click();
  await main.getByTestId(BUILDER_ID.channelAddress).fill(address);
  await main.getByTestId(BUILDER_ID.channelServerOption(serverKey)).check();
  await leaveForm(page);
  return readKey(main, BUILDER_ID.channelKeyValue, "channel");
}

/** Messages section: add one with a title and the entity as payload (choosing an entity pins its latest published version), sent on the channel. Returns its key. */
export async function addMessage(page: Page, title: string, payloadEntityName: string, channelKey: string): Promise<string> {
  const main = centerPanel(page);
  await main.getByTestId(BUILDER_ID.outline("messages")).click();
  await main.getByRole("button", { name: "Add message" }).click();
  await main.getByTestId(BUILDER_ID.messageTitle).fill(title);
  await main.getByTestId(BUILDER_ID.payloadPicker).getByLabel("Payload entity").selectOption({ label: payloadEntityName });
  await main.getByTestId(BUILDER_ID.messageChannelOption(channelKey)).check();
  await leaveForm(page);
  return readKey(main, BUILDER_ID.messageKeyValue, "message");
}

/** Operations section: add a `send` operation on the channel carrying the message; the identifier is renamed on purpose. */
export async function addOperation(page: Page, key: string, channelKey: string, messageKey: string): Promise<void> {
  const main = centerPanel(page);
  await main.getByTestId(BUILDER_ID.outline("operations")).click();
  await main.getByRole("button", { name: "Add operation" }).click();
  await main.getByTestId(BUILDER_ID.operationKeyToggle).click(); // the identifier lives in a collapsed disclosure
  const keyInput = main.getByTestId(BUILDER_ID.operationKey);
  await keyInput.fill(key);
  await keyInput.press("Enter"); // a key commits on Enter / blur
  await main.getByTestId(BUILDER_ID.operationActionSend).check();
  await main.getByTestId(BUILDER_ID.operationChannel).selectOption(channelKey);
  await main.getByTestId(BUILDER_ID.operationMessageOption(messageKey)).check();
}
