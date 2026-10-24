/**
 * AsyncAPI import end to end (plan 2026-10-16-events-import-and-json-validation, WP-I3): New Event → "Import existing…" → upload an
 * AsyncAPI 3.0 file → review (counts, entities, the drafts note) → Import → the event page. Everything goes through the real UI, in
 * Chromium, with the real AsyncAPI parser and the real database.
 *
 *   1. streetlights-kafka.yaml (tests/fixtures/asyncapi-import) is uploaded with `setInputFiles`: the text fills the box, the review
 *      shows 2 servers / 4 channels / 3 messages / 4 operations and its three entities with no "Renamed" badge, and says that the
 *      entities are drafts. Import lands on the event page: the builder holds the imported server, channel, message and operation
 *      counts, the Code panel shows the document, the explorer lists the three entities, and the database says they are unpublished
 *      DRAFTS (no version, status DRAFT).
 *   2. The same file again: the review renames the event and all three entities (a name is never reused and never an error), and the
 *      import still works; the product then lists two events.
 *   3. An invalid file (the same document with an action the AsyncAPI parser rejects) shows the diagnostics list (message and pointer),
 *      has no Import button, and creates nothing; an AsyncAPI 2.x file is refused with "AsyncAPI 3.0 only" next to the text.
 *
 * The domain and product are fixtures (helpers/db.ts); `deleteNavFixtures` removes them in `afterAll`, and the domain cascade takes the
 * events and the entities with them. Nothing is published, so no immutable audit row is written.
 *
 * PREREQS: see helpers/auth.ts and helpers/db.ts (PostgreSQL provider, seeded admin, app on :3000). NOT RUN by the agent that wrote it
 * (agents may not run Playwright); the controller runs it after merging. If a step fails on a locator, adjust it in `ID` or in the
 * helper it uses (helpers/event-builder.ts), not in the flow.
 */
import { readFileSync } from "node:fs";
import path from "node:path";
import type { Locator, Page } from "@playwright/test";
import { test, expect } from "./helpers/fixtures";
import { createNavFixtures, deleteNavFixtures, disconnectDb, pg, type NavFixtures } from "./helpers/db";
import { centerPanel, expectNoRawDbText, openNewEventDialog, productUrlOf } from "./helpers/event-builder";

// The first preview starts the AsyncAPI parser, and first visits compile routes in dev.
const FIXTURES = path.join(__dirname, "../fixtures/asyncapi-import");
const STREETLIGHTS = path.join(FIXTURES, "streetlights-kafka.yaml");
const ASYNCAPI_2X = path.join(FIXTURES, "negative-asyncapi-2x.yaml");

/** What importing streetlights-kafka.yaml makes (the service's integration test pins the same numbers). */
const EVENT_NAME = "Streetlights-Kafka-API";
const COUNTS = { servers: 2, channels: 4, messages: 3, operations: 4 } as const;
const ENTITIES = ["DimLight", "LightMeasured", "TurnOnOff"] as const;

const ID = {
  newEventDialog: "new-event-dialog",
  importExisting: "new-event-import-existing",
  dialog: "import-asyncapi-dialog",
  file: "import-file",
  content: "import-content",
  preview: "import-preview",
  back: "import-back",
  submit: "import-submit",
  review: "import-review",
  eventName: "import-event-name",
  count: (key: keyof typeof COUNTS) => `import-count-${key}`,
  entity: (name: string) => `import-entity-${name}`,
  draftsNote: "import-drafts-note",
  renamedGroup: "import-warning-group-ENTITY_RENAMED",
  problemsPanel: "import-problems-panel",
  problem: (i: number) => `import-problem-${i}`,
  errorHeadline: "import-error-headline",
  outlineCount: (section: keyof typeof COUNTS) => `outline-count-${section}`,
  codeToggle: "event-code-toggle",
  codePanel: "event-code-panel",
  eventsTab: "events-tab",
};

let fixtures: NavFixtures | undefined;

/** What the tests share: the first import's event. */
const flow = { eventId: "" };

test.beforeAll(async () => {
  fixtures = await createNavFixtures();
});

test.afterAll(async () => {
  try {
    await deleteNavFixtures(fixtures);
  } finally {
    await disconnectDb();
  }
});

const need = <T>(value: T | undefined, what: string): T => {
  if (value === undefined) throw new Error(`${what} fixture was not created`);
  return value;
};

/** How many entities and events the product holds (pg returns counts as text). */
async function inventory(productId: string): Promise<{ entities: number; events: number }> {
  const { rows } = await pg().query(
    `SELECT (SELECT count(*) FROM entities WHERE "productId" = $1) AS entities, (SELECT count(*) FROM event_specs WHERE "productId" = $1) AS events`,
    [productId]
  );
  return { entities: Number(rows[0].entities), events: Number(rows[0].events) };
}

/** Product header → New → New Event → "Import existing…": the import dialog, open, with the New Event dialog gone. */
async function openImportDialog(page: Page, productUrl: string): Promise<Locator> {
  const newEvent = await openNewEventDialog(page, productUrl);
  await newEvent.getByTestId(ID.importExisting).click();
  const dialog = page.getByTestId(ID.dialog);
  await expect(dialog).toBeVisible();
  await expect(page.getByTestId(ID.newEventDialog)).toHaveCount(0);
  return dialog;
}

/** Uploads `file` into the open import dialog and waits until its text (matching `shows`) is in the box: the box is filled asynchronously. */
async function upload(dialog: Locator, file: Parameters<Locator["setInputFiles"]>[0], shows: RegExp): Promise<void> {
  await dialog.getByTestId(ID.file).setInputFiles(file);
  await expect(dialog.getByTestId(ID.content)).toHaveValue(shows);
}

/** Uploads the streetlights file and presses Preview. */
async function uploadAndPreview(dialog: Locator): Promise<void> {
  await upload(dialog, STREETLIGHTS, /title: Streetlights Kafka API/);
  await dialog.getByTestId(ID.preview).click();
}

/** The event id in the page's URL once the import has opened its event. */
const eventIdOf = (page: Page): string => new URL(page.url()).pathname.split("/events/")[1];

test.describe("importing an AsyncAPI document end to end", () => {
  // The tests share the product (and the event the first one imports).
  test.describe.configure({ mode: "serial" });

  test("upload → review → import: the event opens with the imported document, and its entities are unpublished drafts", { tag: ["@regression"] }, async ({ authedPage: page }) => {
    test.setTimeout(300_000);
    const f = need(fixtures, "navigation");
    const main = centerPanel(page);
    const pageErrors: string[] = [];
    page.on("pageerror", (error) => pageErrors.push(error.message));
    const before = await inventory(f.product.id);

    const dialog = await openImportDialog(page, productUrlOf(f));

    await test.step("the uploaded file fills the box, and the review shows what the import will create", async () => {
      await upload(dialog, STREETLIGHTS, /title: Streetlights Kafka API/);
      await dialog.getByTestId(ID.preview).click();
      const review = dialog.getByTestId(ID.review);
      await expect(review).toBeVisible({ timeout: 120_000 });
      await expect(dialog.getByTestId(ID.eventName)).toHaveValue(EVENT_NAME);
      for (const [key, count] of Object.entries(COUNTS)) {
        await expect(dialog.getByTestId(ID.count(key as keyof typeof COUNTS)), `${key} count`).toHaveText(String(count));
      }
      for (const name of ENTITIES) await expect(dialog.getByTestId(ID.entity(name)), `entity ${name}`).toBeVisible();
      await expect(review.locator('[data-testid^="import-entity-renamed-"]')).toHaveCount(0);
      // the product point of the review: the entities are drafts and must be published and pinned before the event can be
      await expect(dialog.getByTestId(ID.draftsNote)).toContainText("The imported entities are drafts. Publish them, then pin their published versions");
    });

    await test.step("Import opens the new event", async () => {
      await dialog.getByTestId(ID.submit).click();
      await expect(page).toHaveURL(/\/events\/[^/?]+/, { timeout: 90_000 });
      flow.eventId = eventIdOf(page);
      await expect(main.getByRole("heading", { name: EVENT_NAME })).toBeVisible({ timeout: 60_000 });
    });

    await test.step("the builder holds the imported servers, channels, messages and operations", async () => {
      for (const [section, count] of Object.entries(COUNTS)) {
        await expect(main.getByTestId(ID.outlineCount(section as keyof typeof COUNTS)), `${section} in the builder`).toHaveText(String(count));
      }
    });

    await test.step("the Code panel shows the imported document", async () => {
      const toggle = main.getByTestId(ID.codeToggle);
      if ((await toggle.getAttribute("aria-pressed")) !== "true") await toggle.click();
      const code = page.getByTestId(ID.codePanel).locator(".cm-content");
      await expect(code).toContainText("Streetlights Kafka API", { timeout: 60_000 });
      await expect(code).toContainText("test.mykafkacluster.org:18092");
    });

    await test.step("the explorer lists the entities, and they are unpublished drafts", async () => {
      const { rows } = await pg().query(
        `SELECT id, name, status, "latestVersionId" FROM entities WHERE "productId" = $1 AND name = ANY($2) ORDER BY name`,
        [f.product.id, [...ENTITIES]]
      );
      expect(rows.map((r) => ({ name: r.name, status: r.status, latestVersionId: r.latestVersionId }))).toEqual(
        ENTITIES.map((name) => ({ name, status: "DRAFT", latestVersionId: null }))
      );
      // A hard load shows the sidebar's fallback and then the real one, for a moment both: read rows from it only once there is one. The row
      // is found by the entity's id (its testid), not by its text, which the event's own page and the dialog could repeat.
      await expect(page.getByTestId("left-sidebar")).toHaveCount(1, { timeout: 30_000 });
      const explorer = page.getByTestId("left-sidebar");
      for (const row of rows) await expect(explorer.getByTestId(`entity-${row.id}`), `explorer row ${row.name}`).toBeVisible({ timeout: 30_000 });
      const versions = await pg().query(`SELECT count(*) AS n FROM entity_versions ev JOIN entities e ON e.id = ev."entityId" WHERE e."productId" = $1`, [f.product.id]);
      expect(Number(versions.rows[0].n), "nothing was published").toBe(0);
      const after = await inventory(f.product.id);
      expect(after).toEqual({ entities: before.entities + ENTITIES.length, events: before.events + 1 });
    });

    await expectNoRawDbText(page);
    expect(pageErrors, "uncaught browser exceptions").toEqual([]);
  });

  test("importing the same file again renames the event and its entities instead of failing", { tag: ["@regression"] }, async ({ authedPage: page }) => {
    test.setTimeout(300_000);
    const f = need(fixtures, "navigation");
    const main = centerPanel(page);
    const before = await inventory(f.product.id);

    const dialog = await openImportDialog(page, productUrlOf(f));
    await uploadAndPreview(dialog);
    await expect(dialog.getByTestId(ID.review)).toBeVisible({ timeout: 120_000 });

    await test.step("the review resolves every taken name", async () => {
      const name = dialog.getByTestId(ID.eventName);
      await expect(name).not.toHaveValue(EVENT_NAME);
      await expect(name).toHaveValue(new RegExp(`^${EVENT_NAME}\\d+$`));
      await expect(dialog.locator('[data-testid^="import-entity-renamed-"]')).toHaveCount(ENTITIES.length);
      await expect(dialog.getByTestId(ID.renamedGroup)).toBeVisible();
    });

    await test.step("Import opens a second event", async () => {
      await dialog.getByTestId(ID.submit).click();
      await expect(page).toHaveURL(/\/events\/[^/?]+/, { timeout: 90_000 });
      await expect.poll(() => eventIdOf(page), { timeout: 60_000 }).not.toBe(flow.eventId);
      await expect(main.getByTestId(ID.outlineCount("messages"))).toHaveText(String(COUNTS.messages), { timeout: 60_000 });
      expect(await inventory(f.product.id)).toEqual({ entities: before.entities + ENTITIES.length, events: before.events + 1 });
    });

    await test.step("the product lists both events", async () => {
      await page.goto(`${productUrlOf(f)}?tab=events`);
      const list = main.getByTestId(ID.eventsTab);
      await expect(list).toBeVisible({ timeout: 60_000 });
      await expect(list.getByRole("link", { name: new RegExp(EVENT_NAME) })).toHaveCount(2);
    });
    await expectNoRawDbText(page);
  });

  test("an invalid file shows its diagnostics and creates nothing; an AsyncAPI 2.x file is refused next to the text", { tag: ["@regression"] }, async ({ authedPage: page }) => {
    test.setTimeout(300_000);
    const f = need(fixtures, "navigation");
    const before = await inventory(f.product.id);
    // the AsyncAPI parser rejects `publish` (an AsyncAPI 2 action) in a 3.0 document
    const invalid = readFileSync(STREETLIGHTS, "utf8").replace("action: send", "action: publish");
    expect(invalid).not.toBe(readFileSync(STREETLIGHTS, "utf8"));

    const dialog = await openImportDialog(page, productUrlOf(f));

    await test.step("the diagnostics list has a message and a pointer for each problem, and there is no Import button", async () => {
      await upload(dialog, { name: "streetlights-invalid.yaml", mimeType: "application/yaml", buffer: Buffer.from(invalid) }, /action: publish/);
      await dialog.getByTestId(ID.preview).click();
      await expect(dialog.getByTestId(ID.problemsPanel)).toBeVisible({ timeout: 120_000 });
      await expect(dialog.getByTestId(ID.problem(0))).toContainText("/");
      await expect(dialog.getByTestId(ID.submit)).toHaveCount(0);
      await expect(dialog.getByTestId(ID.back)).toBeVisible();
      expect(await inventory(f.product.id), "a refused document creates nothing").toEqual(before);
    });

    await test.step("Back returns to the text, which is kept; an AsyncAPI 2.x file is refused with 'AsyncAPI 3.0 only'", async () => {
      await dialog.getByTestId(ID.back).click();
      await expect(dialog.getByTestId(ID.content)).toHaveValue(invalid);
      await upload(dialog, ASYNCAPI_2X, /asyncapi: 2\.6\.0/);
      await dialog.getByTestId(ID.preview).click();
      await expect(dialog.getByTestId(ID.errorHeadline)).toHaveText("AsyncAPI 3.0 only", { timeout: 60_000 });
      await expect(dialog.getByTestId(ID.problemsPanel)).toHaveCount(0);
      expect(await inventory(f.product.id)).toEqual(before);
    });

    await test.step("Escape closes the dialog", async () => {
      await page.keyboard.press("Escape");
      await expect(page.getByTestId(ID.dialog)).toHaveCount(0);
    });
    await expectNoRawDbText(page);
  });
});
