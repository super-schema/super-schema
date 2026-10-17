/**
 * Event publish E2E (self-contained events; spec 2026-10-15-events-self-contained-design §5 publish and versions, plan
 * 2026-10-16-events-completion WP-P2): an event is built in the Design tab (server, channel, a message whose payload is a PUBLISHED
 * entity version, operation), saved and published as v1.0; a description edit publishes as v1.1 (the suggested MINOR); the Versions
 * tab lists 1.1 and 1.0 and shows each version's stored code with its `info.version`; the Used by tab says nothing references the
 * event; changing the payload to another entity suggests MAJOR and refuses the lower option; an unpinned payload lists a blocker.
 *
 * Everything goes through the real UI. The domain, the product and the two payload entities (each with a published 1.0) are
 * fixtures (helpers/db.ts, helpers/entity-versions.ts); `deleteNavFixtures` removes them in `afterAll`, and the domain cascade takes
 * the events and their versions with them. Publishing an EVENT writes immutable PUBLISH_VERSION audit rows into the shared database
 * that no cleanup can remove (that is what is being tested): the entities are therefore written as rows, never published through
 * the app.
 *
 * PREREQS: see helpers/auth.ts and helpers/db.ts (PostgreSQL provider, seeded admin, app on :3000).
 *
 * SELECTORS: the builder flows are in helpers/event-builder.ts. The publish controls are `event-publish` (header button),
 * `confirm-publish` / `bump-minor` / `bump-major` (the shared publish dialog), `event-version-badge` / `event-draft-badge` (header),
 * `event-tab-versions` / `event-tab-used-by`, `event-version-list` with a "View vX.Y" button per row, `event-version-code-text`
 * (the read-only editor) and `used-by-panel`. If a step fails on a locator, adjust it there, not in the flow.
 */
import type { Locator, Page } from "@playwright/test";
import { test, expect } from "./helpers/auth";
import { createNavFixtures, deleteNavFixtures, disconnectDb, type NavFixtures } from "./helpers/db";
import { createPublishedEntity, type PublishedEntity } from "./helpers/entity-versions";
import {
  addChannel, addMessage, addOperation, addServer, BUILDER_ID, centerPanel, createEventFromMenu, expectNoRawDbText, productUrlOf,
} from "./helpers/event-builder";

// First visits compile routes in dev, and publishing renders the payload with the real TypeSpec CLI and validates the result.
test.use({ navigationTimeout: 60_000, actionTimeout: 30_000, screenshot: "only-on-failure", trace: "retain-on-failure" });

const PUBLISH_TIMEOUT = 120_000;

let fixtures: NavFixtures | undefined;
let orderA: PublishedEntity | undefined;
let orderB: PublishedEntity | undefined;

/** What the first test creates and the later tests read. */
const flow = { s: "", eventName: "", eventId: "", messageKey: "", description: "" };

test.beforeAll(async () => {
  fixtures = await createNavFixtures();
  const s = Date.now().toString(36);
  orderA = await createPublishedEntity(fixtures, `PubOrderA${s}`, ["1.0"]);
  orderB = await createPublishedEntity(fixtures, `PubOrderB${s}`, ["1.0"]);
});

test.afterAll(async () => {
  try {
    // Deletes the edge rows first, then the domain: the product with its entities, events and event versions.
    await deleteNavFixtures(fixtures);
  } finally {
    await disconnectDb();
  }
});

const need = <T>(value: T | undefined, what: string): T => {
  if (value === undefined) throw new Error(`${what} fixture was not created`);
  return value;
};

const publishButton = (page: Page): Locator => centerPanel(page).getByTestId("event-publish");
const dialogOf = (page: Page): Locator => page.getByRole("dialog");

/** Save in the builder and wait for the confirmation: the first save compiles the action module and validates every pin. */
async function save(page: Page): Promise<void> {
  const main = centerPanel(page);
  await main.getByTestId(BUILDER_ID.save).click();
  await expect(page.getByText("Draft saved").first()).toBeVisible({ timeout: 60_000 });
  await expect(main.getByTestId(BUILDER_ID.status)).toHaveText("No unsaved changes");
}

/** Opens the Publish dialog and waits until its preview has loaded (the confirm button is there, enabled or not). */
async function openPublishDialog(page: Page): Promise<Locator> {
  await publishButton(page).click();
  const dialog = dialogOf(page);
  await expect(dialog).toBeVisible();
  await expect(dialog.getByTestId("confirm-publish")).toBeVisible({ timeout: 90_000 });
  return dialog;
}

async function cancelDialog(page: Page): Promise<void> {
  const dialog = dialogOf(page);
  await dialog.getByRole("button", { name: "Cancel" }).click();
  await expect(dialog).toBeHidden();
}

/** Confirms the open dialog and waits for the publish toast and the closed dialog. */
async function confirmPublish(page: Page, label: string): Promise<void> {
  const dialog = dialogOf(page);
  await dialog.getByTestId("confirm-publish").click();
  await expect(page.getByText(new RegExp(`Published .* v${label.replace(".", "\\.")}`)).first()).toBeVisible({ timeout: PUBLISH_TIMEOUT });
  await expect(dialog).toBeHidden();
}

test.describe("event publish end to end", () => {
  // The tests share the state `flow` carries: a failure in the first one makes the rest meaningless.
  test.describe.configure({ mode: "serial" });

  test("build an event → Publish waits for Save → publish v1.0", async ({ authedPage: page }) => {
    test.setTimeout(420_000);
    const main = centerPanel(page);
    const f = need(fixtures, "navigation");
    const entity = need(orderA, "payload entity");
    const pageErrors: string[] = [];
    page.on("pageerror", (error) => pageErrors.push(error.message));

    flow.s = Date.now().toString(36);
    flow.eventName = `publish-events-${flow.s}`;

    await test.step("create the event and build a server, channel, message with a published payload entity, and an operation", async () => {
      flow.eventId = await createEventFromMenu(page, productUrlOf(f), flow.eventName);
      // A new event is unpublished, and a draft.
      await expect(main.getByTestId("event-version-badge")).toHaveText("Unpublished");
      const serverKey = await addServer(page, `kafka-${flow.s}.internal:9092`);
      const channelKey = await addChannel(page, "orders.v1", serverKey);
      flow.messageKey = await addMessage(page, `Order created ${flow.s}`, entity.name, channelKey);
      await addOperation(page, "publishOrderCreated", channelKey, flow.messageKey);
    });

    await test.step("Publish is disabled, and says why, while the changes are unsaved", async () => {
      await expect(main.getByTestId(BUILDER_ID.status)).toHaveText("Unsaved changes");
      await expect(publishButton(page)).toBeDisabled();
      await expect(publishButton(page)).toHaveAttribute("title", "Save your changes first");
    });

    await test.step("Save, then Publish is enabled", async () => {
      await save(page);
      await expect(publishButton(page)).toBeEnabled();
      await expectNoRawDbText(page);
    });

    await test.step("Publish offers v1.0 for a first publish, and publishes it with the change summary", async () => {
      const dialog = await openPublishDialog(page);
      await expect(dialog.getByText(/First publish of/)).toContainText("v1.0");
      await expect(dialog.getByTestId("confirm-publish")).toBeEnabled();
      await expect(dialog.getByTestId("confirm-publish")).toContainText("Publish v1.0");
      await dialog.getByRole("textbox").fill("First cut");
      await confirmPublish(page, "1.0");
      await expect(main.getByTestId("event-version-badge")).toHaveText("v1.0", { timeout: 60_000 });
      await expect(main.getByTestId("event-draft-badge")).toHaveCount(0);
      await expect(publishButton(page)).toBeEnabled();
      await expectNoRawDbText(page);
    });

    await test.step("a second Publish with nothing changed is refused in the dialog", async () => {
      const dialog = await openPublishDialog(page);
      await expect(dialog.getByText("No unpublished changes since v1.0.")).toBeVisible();
      await expect(dialog.getByTestId("confirm-publish")).toBeDisabled();
      await cancelDialog(page);
    });

    expect(pageErrors, "uncaught browser exceptions").toEqual([]);
  });

  test("edit the description → Save → Publish suggests MINOR and publishes v1.1", async ({ authedPage: page }) => {
    test.setTimeout(300_000);
    const main = centerPanel(page);
    const f = need(fixtures, "navigation");
    flow.description = `Edited ${flow.s}`;

    await page.goto(`${productUrlOf(f)}/events/${flow.eventId}`);
    await expect(main.getByTestId("event-version-badge")).toHaveText("v1.0", { timeout: 60_000 });

    await test.step("edit the description and Save: the draft badge is back", async () => {
      await main.getByTestId(BUILDER_ID.outline("metadata")).click();
      await main.getByRole("textbox", { name: "Description" }).fill(flow.description);
      await save(page);
      await expect(main.getByTestId("event-draft-badge")).toBeVisible({ timeout: 60_000 });
    });

    await test.step("the dialog suggests MINOR and v1.1", async () => {
      const dialog = await openPublishDialog(page);
      await expect(dialog.getByText(/Latest published:/)).toContainText("v1.0");
      await expect(dialog.getByText(/Latest published:/)).toContainText("MINOR");
      await expect(dialog.getByTestId("bump-minor")).toHaveAttribute("aria-checked", "true");
      await expect(dialog.getByTestId("bump-minor")).toBeEnabled();
      await expect(dialog.getByTestId("confirm-publish")).toContainText("Publish v1.1");
      await confirmPublish(page, "1.1");
      await expect(main.getByTestId("event-version-badge")).toHaveText("v1.1", { timeout: 60_000 });
      await expect(main.getByTestId("event-draft-badge")).toHaveCount(0);
      await expectNoRawDbText(page);
    });
  });

  test("the Versions tab lists 1.1 and 1.0, and View shows each stored version's info.version", async ({ authedPage: page }) => {
    test.setTimeout(240_000);
    const main = centerPanel(page);
    const f = need(fixtures, "navigation");

    await page.goto(`${productUrlOf(f)}/events/${flow.eventId}`);
    await main.getByTestId("event-tab-versions").click();
    await expect(page).toHaveURL(/[?&]tab=versions\b/);

    const rows = main.getByTestId("event-version-list").getByRole("listitem");
    await expect(rows).toHaveCount(2, { timeout: 60_000 });
    await expect(rows.nth(0)).toContainText("v1.1");
    await expect(rows.nth(1)).toContainText("v1.0");
    await expect(rows.nth(1)).toContainText("INITIAL");
    await expect(rows.nth(1)).toContainText("First cut");

    const code = main.getByTestId("event-version-code-text");
    await main.getByRole("button", { name: "View v1.0" }).click();
    await expect(page).toHaveURL(/[?&]version=1\.0\b/);
    await expect(code).toContainText(/version:\s*"?1\.0"?/, { timeout: 60_000 });
    await main.getByTestId("version-code-format-json").click();
    await expect(code).toContainText(/"version":\s*"1\.0"/);

    await main.getByRole("button", { name: "View v1.1" }).click();
    await expect(page).toHaveURL(/[?&]version=1\.1\b/);
    await expect(code).toContainText(/"version":\s*"1\.1"/, { timeout: 60_000 });

    // The link is a deep link: a reload opens the same version.
    await page.reload();
    await expect(main.getByTestId("event-version-code-text")).toContainText(/version/, { timeout: 60_000 });
    await expect(main.getByTestId("event-version-code-text")).toContainText(/1\.1/);
    await expect(main.getByRole("button", { name: "View v1.1" })).toHaveAttribute("aria-pressed", "true");
    await expectNoRawDbText(page);
  });

  test("the Used by tab says no other event references this one", async ({ authedPage: page }) => {
    test.setTimeout(180_000);
    const main = centerPanel(page);
    const f = need(fixtures, "navigation");

    await page.goto(`${productUrlOf(f)}/events/${flow.eventId}`);
    await main.getByTestId("event-tab-used-by").click();
    await expect(page).toHaveURL(/[?&]tab=used-by\b/);
    await expect(main.getByTestId("used-by-panel")).toContainText("No other event references this one.", { timeout: 60_000 });
    await expectNoRawDbText(page);
  });

  test("another payload entity suggests MAJOR and refuses the lower option; an unpinned payload lists a blocker", async ({ authedPage: page }) => {
    test.setTimeout(420_000);
    const main = centerPanel(page);
    const f = need(fixtures, "navigation");
    const other = need(orderB, "second payload entity");
    const picker = main.getByTestId(BUILDER_ID.payloadPicker);

    await page.goto(`${productUrlOf(f)}/events/${flow.eventId}`);
    await expect(main.getByTestId("event-version-badge")).toHaveText("v1.1", { timeout: 60_000 });

    await test.step("move the payload to another entity and Save", async () => {
      await main.getByTestId(BUILDER_ID.outline("messages")).click();
      await picker.getByLabel("Payload entity").selectOption({ label: other.name });
      await save(page);
    });

    await test.step("the dialog suggests MAJOR (v2.0), the lower option is disabled", async () => {
      const dialog = await openPublishDialog(page);
      await expect(dialog.getByText(/Latest published:/)).toContainText("v1.1");
      await expect(dialog.getByText(/Latest published:/)).toContainText("MAJOR");
      await expect(dialog.getByTestId("bump-minor")).toBeDisabled();
      await expect(dialog.getByTestId("bump-major")).toHaveAttribute("aria-checked", "true");
      await expect(dialog.getByTestId("confirm-publish")).toContainText("Publish v2.0");
      await expect(dialog.getByText("These changes are breaking, so they can only be published as a major version.")).toBeVisible();
      await cancelDialog(page);
    });

    await test.step("unpin the payload and Save: the dialog lists the unpinned pin as a blocker, once, and cannot publish", async () => {
      await picker.getByLabel("Payload version").selectOption("");
      await save(page);
      const dialog = await openPublishDialog(page);
      await expect(dialog.getByText("Cannot publish yet")).toBeVisible();
      const blockers = dialog.getByRole("alert").getByRole("listitem");
      await expect(blockers.filter({ hasText: `${other.name} has no published version pinned` })).toHaveCount(1);
      await expect(dialog.getByTestId("confirm-publish")).toBeDisabled();
      await expectNoRawDbText(page);
      await cancelDialog(page);
    });
  });
});
