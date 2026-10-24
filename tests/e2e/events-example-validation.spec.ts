/**
 * Message examples against the schema of their payload entity (spec: docs/superpowers/plans/2026-10-16-events-import-and-json-validation.md, WP-V3):
 * a message pins an entity with fields; in the message's Examples an example's payload is checked against that entity's JSON Schema in
 * the editor (a mismatch is a warning squiggle with hover text, never a blocker), and "Generate from payload" fills in an example the
 * schema accepts.
 *
 * Flow: New Event → Messages → add a message pinning the Order entity → Examples → add an example → Generate from payload → the
 * generated JSON has no squiggle → a value of the wrong type gets one, with the schema's message on hover → Generate again (asks first)
 * replaces it with an example that has none → the draft still saves. Absence of a squiggle is asserted only once the editor reports
 * its lint pass finished (`data-lint-state="idle"`).
 *
 * The entity is never published (a publish writes immutable audit rows that cannot be deleted): the message pins it unpinned, so the
 * schema is rendered from the entity's current draft, with the real TypeSpec CLI (the first render can take a while).
 *
 * PREREQS: see helpers/auth.ts and helpers/db.ts (PostgreSQL provider, seeded admin, app on :3000). NOT RUN by the agent that wrote it
 * (agents may not run Playwright); the controller runs it after merging. If a step fails on a locator, adjust it in `ID`, not in the flow.
 */
import { randomBytes } from "node:crypto";
import type { Locator, Page } from "@playwright/test";
import { test, expect, unique } from "./helpers/fixtures";
import { createNavFixtures, deleteNavFixtures, disconnectDb, pg, type NavFixtures } from "./helpers/db";
import { centerPanel, createEventFromMenu, productUrlOf } from "./helpers/event-builder";

const ID = {
  outlineMessages: "outline-messages",
  messageTitle: "message-title",
  payloadPicker: "payload-picker", // EntityPinPicker's own `${id}-picker` fieldset (id="payload")
  examplesToggle: "message-card-examples-toggle",
  addExample: "message-examples-add",
  // An example of message 0: its payload editor, and the button beside it (`${id}-editor`, `${id}-generate`, `${id}-generate-confirm`).
  payloadEditor: "message-examples-0-payload-editor",
  payloadGenerate: "message-examples-0-payload-generate",
  replaceConfirm: "message-examples-0-payload-generate-confirm",
  replace: "message-examples-0-payload-generate-replace",
  save: "builder-save",
  status: "builder-status",
  builderError: "builder-error",
};

/** CodeMirror's own marker classes: a lint range under the text and the tooltip of the one under the pointer. */
const WARNING_RANGE = ".cm-lintRange-warning";
const ERROR_RANGE = ".cm-lintRange-error";
const LINT_TOOLTIP = ".cm-tooltip-lint";

let fixtures: NavFixtures | undefined;
let order: { id: string; name: string } | undefined;

const newId = () => `e2e${randomBytes(10).toString("hex")}`;

/** A product-level Order entity with a string and an int32 field, written like the nav fixtures (no source: the draft is generated from the fields). */
async function createOrderEntity(f: NavFixtures): Promise<{ id: string; name: string }> {
  const db = pg();
  const owner = await db.query(`SELECT id FROM users ORDER BY "createdAt" ASC LIMIT 1`);
  const ownerId = owner.rows[0]?.id as string | undefined;
  if (!ownerId) throw new Error("E2E fixtures need a seeded user (npm run db:seed).");
  const s = Date.now().toString(36);
  const entity = { id: newId(), name: `OrderEx${s}` };
  await db.query(
    `INSERT INTO entities (id, name, slug, "tenantId", "domainId", "productId", "ownerId", "updatedAt") VALUES ($1, $2, $3, $4, $5, $6, $7, now())`,
    [entity.id, entity.name, entity.name.toLowerCase(), f.tenantId, f.domain.id, f.product.id, ownerId]
  );
  const fieldSql = `INSERT INTO fields (id, "entityId", name, slug, type, nullable, "isKey", "sortOrder", "updatedAt") VALUES ($1, $2, $3, $3, $4, false, $5, $6, now())`;
  await db.query(fieldSql, [newId(), entity.id, "orderId", "string", true, 0]);
  await db.query(fieldSql, [newId(), entity.id, "quantity", "int32", false, 1]);
  return entity;
}

test.beforeAll(async () => {
  fixtures = await createNavFixtures();
  order = await createOrderEntity(fixtures);
});

test.afterAll(async () => {
  try {
    // The domain cascade takes the product, the entities and the event with it.
    await deleteNavFixtures(fixtures);
  } finally {
    await disconnectDb();
  }
});

const need = <T>(value: T | undefined, what: string): T => {
  if (value === undefined) throw new Error(`${what} fixture was not created`);
  return value;
};

/**
 * The editor's lint pass for the text it holds has finished: `codemirror-setup.ts` marks `.cm-editor` with `data-lint-state` ("pending"
 * from an edit until the linter, 250 ms after the last edit, has set its diagnostics; "idle" after). "No squiggle" means something only
 * once the state is idle, so every absence below is asserted after this, never after a fixed wait.
 */
const expectLinted = (wrapper: Locator) => expect(wrapper.locator(".cm-editor")).toHaveAttribute("data-lint-state", "idle");

/** The example's payload editor once CodeMirror has taken over from the textarea, and its content as the editor holds it. */
async function payloadEditor(main: Locator): Promise<{ wrapper: Locator; content: Locator }> {
  const wrapper = main.getByTestId(ID.payloadEditor);
  await expect(wrapper).toHaveAttribute("data-editor", "codemirror", { timeout: 30_000 });
  return { wrapper, content: wrapper.locator(".cm-content") };
}

/** Replace everything in the editor with `text` (the editor does not auto-close brackets, so typing is literal). */
async function typeInto(page: Page, content: Locator, text: string): Promise<void> {
  await content.click();
  await page.keyboard.press("ControlOrMeta+A");
  await page.keyboard.type(text);
}

test.describe("message examples against their payload schema", () => {
  test("Generate from payload fills a valid example; a value of the wrong type is a warning with hover text; the draft still saves", { tag: ["@regression"] }, async ({ authedPage: page }) => {
    test.setTimeout(240_000);
    const main = centerPanel(page);
    const f = need(fixtures, "navigation");
    const entity = need(order, "order entity");
    const pageErrors: string[] = [];
    page.on("pageerror", (error) => pageErrors.push(error.message));

    await test.step("a new event with a message that pins the Order entity", async () => {
      await createEventFromMenu(page, productUrlOf(f), unique("example-events-"));
      await main.getByTestId(ID.outlineMessages).click();
      await main.getByRole("button", { name: "Add message" }).click();
      await main.getByTestId(ID.messageTitle).fill("Order created");
      await main.getByTestId(ID.payloadPicker).getByLabel("Payload entity").selectOption({ label: entity.name });
    });

    await test.step("add an example: until the schema is known the button waits, then it is usable", async () => {
      await main.getByTestId(ID.examplesToggle).click();
      await main.getByTestId(ID.addExample).click();
      await payloadEditor(main);
      // The schema is rendered by the TypeSpec CLI the first time: allow it well beyond the 5 s default.
      await expect(main.getByTestId(ID.payloadGenerate)).toBeEnabled({ timeout: 90_000 });
      await expect(main.getByTestId(ID.payloadGenerate)).toHaveText("Generate from payload");
    });

    await test.step("Generate from payload: an example the schema accepts, so no squiggle", async () => {
      const { wrapper, content } = await payloadEditor(main);
      await main.getByTestId(ID.payloadGenerate).click();
      await expect(content).toContainText('"orderId"');
      await expect(content).toContainText('"quantity"');
      await expectLinted(wrapper);
      await expect(wrapper.locator(WARNING_RANGE)).toHaveCount(0);
      await expect(wrapper.locator(ERROR_RANGE)).toHaveCount(0);
    });

    await test.step("edit a value to the wrong type: a squiggle, and the schema's own words on hover", async () => {
      const { wrapper, content } = await payloadEditor(main);
      await typeInto(page, content, '{"orderId": 5, "quantity": 0}');
      const squiggle = wrapper.locator(WARNING_RANGE).first();
      await expect(squiggle).toBeVisible({ timeout: 15_000 });
      await squiggle.hover();
      await expect(page.locator(LINT_TOOLTIP)).toContainText("Expected `string` but received `number`", { timeout: 15_000 });
      // It is a warning only: the text is valid JSON, so the field is not flagged invalid.
      await expect(main.getByTestId("message-examples-0-payload-validation")).toHaveCount(0);
    });

    await test.step("Generate again asks before it replaces what is there; what it writes has no squiggle", async () => {
      await main.getByTestId(ID.payloadGenerate).click();
      await expect(main.getByTestId(ID.replaceConfirm)).toContainText("Replace the current example?");
      await main.getByTestId(ID.replace).click();
      const { wrapper, content } = await payloadEditor(main);
      await expect(content).toContainText('"orderId": "string"');
      await expectLinted(wrapper);
      await expect(wrapper.locator(WARNING_RANGE)).toHaveCount(0);
      await expect(wrapper.locator(ERROR_RANGE)).toHaveCount(0);
    });

    await test.step("a warning never blocks a save", async () => {
      const { content } = await payloadEditor(main);
      await typeInto(page, content, '{"orderId": 5, "quantity": 0}');
      await expect(main.getByTestId(ID.status)).toHaveText("Unsaved changes");
      await main.getByTestId(ID.save).click();
      await expect(page.getByText("Draft saved").first()).toBeVisible({ timeout: 60_000 });
      await expect(main.getByTestId(ID.builderError)).toHaveCount(0);
    });

    expect(pageErrors, "uncaught browser exceptions").toEqual([]);
  });
});
