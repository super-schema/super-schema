/**
 * Governance (`/governance`, `/governance/retention`) and Compliance (`/compliance`).
 *
 * What the pages do (each line is a test):
 *   - Governance Dashboard   lists the schema change requests, each with its entity, summary, severity, status, requester and version,
 *                            and the impact report in the panel beside the list; Approve and Reject ask for an optional comment first
 *                            (Cancel backs out), then move the request from Pending to History with the new status, the decision and
 *                            the comment recorded; the decision is kept after a reload; a request that is not pending offers neither;
 *                            a user without the Steward or Admin role cannot decide (KD-015: and is told nothing).
 *                            No page or action of the product CREATES a request yet (governance.service.createRequest is called by
 *                            nothing), so the specs write the row, as the service does.
 *   - Retention policies     an entity's policy is edited (strategy, period, unit, reference field, condition, action, description),
 *                            summarised in the list and kept; one of a unit reads singular and plural (1 day, 1 month, 1 year, 2 years);
 *                            a period that cannot be saved is said, not swallowed; the entity address `?entity=<id>` opens its editor.
 *   - Compliance Query       the fields of the database with their classification, retention, anonymization and domain: filters
 *                            (text, classification, retention range, anonymization, domain), sorting, a row opens the entity page.
 *   - Compliance Gaps        what is missing on the fields (unclassified, PII without anonymization, sensitive without encryption or
 *                            retention), and a row opens the entity at the field.
 *   - Compliance Audit Trail an action performed in the app (deleting a field) is listed with its user, action, type and id, filtered by
 *                            id and by action, expanded to its before / after state.
 *   - Exports                CSV and JSON of the query and of the gaps, the audit trail's CSV: asserted through the browser's download
 *                            (file name, header row, a row for the data the test made).
 *   - Access                 a visitor with no role is refused by the compliance API (401 without a session, 403 without a role), and the
 *                            page says so (KD-016: the Query tab lists the fields of every tenant).
 *
 * Page content is queried inside the center panel (`centerPanel`): a hard load streams the page behind its loading.tsx and Next leaves
 * a hidden copy of the streamed segment in <body>. Toasts are portals, queried on `page`.
 */
import { readFileSync } from "node:fs";
import type { Locator, Page } from "@playwright/test";
import {
  createEntityInTenant,
  createFieldRow,
  createGovernanceRequest,
  createSecondTenant,
  deleteGovernanceRequestsByEntity,
  deleteTenantWithDomain,
  disconnectDb,
  governanceOutcome,
  pg,
  setFieldGovernance,
} from "./helpers/db";
import { fieldRow, afterServerAction, deleteField as deleteFieldRow, addFieldQuick, openEntityPage } from "./helpers/entity-page";
import { centerPanel } from "./helpers/event-builder";
import { test, expect, unique } from "./helpers/fixtures";
import { waitForHydration } from "./helpers/hydration";
import { withSecondUser } from "./helpers/second-user";

const requestedEntities: string[] = [];

test.afterAll(async () => {
  try {
    await deleteGovernanceRequestsByEntity(requestedEntities);
  } catch (error) {
    console.warn(`governance-compliance.spec cleanup failed: ${String(error)}`);
  } finally {
    await disconnectDb();
  }
});

// ---------------------------------------------------------------------------
// Governance Dashboard
// ---------------------------------------------------------------------------

async function openGovernance(page: Page): Promise<void> {
  await page.goto("/governance");
  await expect(page.getByRole("heading", { name: "Governance Dashboard", level: 1 })).toBeVisible();
  await waitForHydration(centerPanel(page).getByTestId("governance-dashboard"));
}

const requestCard = (page: Page, entityName: string): Locator => centerPanel(page).getByTestId("governance-request-card").filter({ hasText: entityName });
const tab = (page: Page, name: "pending" | "all" | "history"): Locator => centerPanel(page).getByTestId(`governance-tab-${name}`);

async function chooseTab(page: Page, name: "pending" | "all" | "history"): Promise<void> {
  await tab(page, name).click();
  await expect(tab(page, name)).toHaveAttribute("aria-pressed", "true");
}

/**
 * A pending request about the entity `entityId` (a request has no foreign key to its entity: the entity's tenant says whose it is, and
 * the dashboard lists the requests of the tenant being viewed), under a name no other test has.
 */
async function pendingRequest(entityId: string, overrides: Partial<Parameters<typeof createGovernanceRequest>[0]> = {}): Promise<{ id: string; entityName: string }> {
  const entityName = unique("GovEntity");
  requestedEntities.push(entityName);
  const { id } = await createGovernanceRequest({ entityId, entityName, ...overrides });
  return { id, entityName };
}

test.describe("governance dashboard", () => {
  test.use({ workspaceEntities: ["GovEntity"] });

  test("a pending request is listed with its entity, summary, severity, status, requester and version, and its impact report opens beside the list", { tag: ["@regression"] }, async ({
    authedPage: page,
    workspace,
  }) => {
    const { entityName } = await pendingRequest(workspace.entities[0].id, { summary: "Drops the required column ref_id", severity: "critical", versionId: "7" });
    await openGovernance(page);

    const card = requestCard(page, entityName);
    await expect(card).toBeVisible();
    await expect(card).toHaveAttribute("data-status", "PENDING");
    await expect(card).toContainText("Drops the required column ref_id");
    await expect(card).toContainText("critical");
    await expect(card).toContainText("PENDING");
    await expect(card).toContainText("Requested by: e2e-requester");
    await expect(card).toContainText("v7");
    await expect(card.getByTestId("governance-approve")).toBeVisible();
    await expect(card.getByTestId("governance-reject")).toBeVisible();

    await expect(centerPanel(page).getByText("Select a request to view details")).toBeVisible();
    await card.click();
    await expect(centerPanel(page).getByRole("heading", { name: entityName, level: 2 })).toBeVisible();
    await expect(centerPanel(page).getByText("Version 7 - breaking change")).toBeVisible();
    const report = centerPanel(page).getByTestId("impact-report-card");
    await expect(report).toContainText("Per-Target Compatibility");
    await expect(report.getByText("bigquery")).toBeVisible();
    await expect(report.getByText("Breaking", { exact: true })).toBeVisible();
    await expect(report.getByText("Compatible", { exact: true })).toBeVisible();
    await expect(report).toContainText("Affected Consumers (1)");
    await expect(report).toContainText(`${entityName}Consumer`);
    await report.getByRole("button", { name: /Migration Artifacts/ }).click();
    await expect(report).toContainText("BigQuery: ALTER TABLE DROP COLUMN");
  });

  test("Approve asks for a comment first, then moves the request to History as APPROVED with the decision recorded, and a reload keeps it", { tag: ["@regression"] }, async ({
    authedPage: page,
    workspace,
  }) => {
    const { id, entityName } = await pendingRequest(workspace.entities[0].id);
    await openGovernance(page);
    const card = requestCard(page, entityName);

    await card.getByTestId("governance-approve").click();
    await expect(card.getByTestId("governance-comment")).toBeVisible();
    await expect(card.getByTestId("governance-approve")).toHaveText("Confirm Approve");
    // Nothing is decided by the first click.
    expect((await governanceOutcome(id)).status).toBe("PENDING");

    await card.getByTestId("governance-comment").fill("Safe: the column is unused");
    await afterServerAction(page, () => card.getByTestId("governance-approve").click(), { body: id });

    await expect(requestCard(page, entityName)).toHaveCount(0);
    await chooseTab(page, "history");
    const decided = requestCard(page, entityName);
    await expect(decided).toBeVisible();
    await expect(decided).toHaveAttribute("data-status", "APPROVED");
    await expect(decided).toContainText("APPROVED");
    await expect(decided.getByTestId("governance-approve")).toHaveCount(0);
    await expect(decided.getByTestId("governance-reject")).toHaveCount(0);
    expect(await governanceOutcome(id)).toEqual({ status: "APPROVED", decisions: [{ decision: "APPROVE", comment: "Safe: the column is unused" }] });

    await openGovernance(page);
    await expect(requestCard(page, entityName)).toHaveCount(0);
    await chooseTab(page, "history");
    await expect(requestCard(page, entityName)).toHaveAttribute("data-status", "APPROVED");
  });

  test("Reject records the comment and the request is REJECTED in History after a reload", { tag: ["@regression"] }, async ({ authedPage: page, workspace }) => {
    const { id, entityName } = await pendingRequest(workspace.entities[0].id, { severity: "medium" });
    await openGovernance(page);
    const card = requestCard(page, entityName);

    await card.getByTestId("governance-reject").click();
    await expect(card.getByTestId("governance-reject")).toHaveText("Confirm Reject");
    await card.getByTestId("governance-comment").fill("Breaks the downstream feed");
    await afterServerAction(page, () => card.getByTestId("governance-reject").click(), { body: id });

    await expect(requestCard(page, entityName)).toHaveCount(0);
    expect(await governanceOutcome(id)).toEqual({ status: "REJECTED", decisions: [{ decision: "REJECT", comment: "Breaks the downstream feed" }] });

    await openGovernance(page);
    await chooseTab(page, "history");
    await expect(requestCard(page, entityName)).toHaveAttribute("data-status", "REJECTED");
    await expect(requestCard(page, entityName)).toContainText("REJECTED");
  });

  test("a decision without a comment is recorded with none, and Cancel decides nothing", { tag: ["@regression"] }, async ({ authedPage: page, workspace }) => {
    const cancelled = await pendingRequest(workspace.entities[0].id);
    const approved = await pendingRequest(workspace.entities[0].id);
    await openGovernance(page);

    const cancelCard = requestCard(page, cancelled.entityName);
    await cancelCard.getByTestId("governance-reject").click();
    await cancelCard.getByTestId("governance-comment").fill("never sent");
    await cancelCard.getByTestId("governance-cancel").click();
    await expect(cancelCard.getByTestId("governance-comment")).toHaveCount(0);
    await expect(cancelCard.getByTestId("governance-approve")).toHaveText("Approve");
    expect((await governanceOutcome(cancelled.id)).status).toBe("PENDING");

    const card = requestCard(page, approved.entityName);
    await card.getByTestId("governance-approve").click();
    await afterServerAction(page, () => card.getByTestId("governance-approve").click(), { body: approved.id });
    await expect(requestCard(page, approved.entityName)).toHaveCount(0);
    expect(await governanceOutcome(approved.id)).toEqual({ status: "APPROVED", decisions: [{ decision: "APPROVE", comment: null }] });
    // The cancelled one is still waiting, after a reload too.
    await openGovernance(page);
    await expect(requestCard(page, cancelled.entityName)).toHaveAttribute("data-status", "PENDING");
  });

  test("a request that is not pending offers neither button, and only the All tab lists an auto-approved one", { tag: ["@regression"] }, async ({
    authedPage: page,
    workspace,
  }) => {
    const auto = await pendingRequest(workspace.entities[0].id, { status: "AUTO_APPROVED", changeType: "non-breaking", severity: "low" });
    const done = await pendingRequest(workspace.entities[0].id, { status: "APPROVED" });
    await openGovernance(page);

    await expect(requestCard(page, auto.entityName)).toHaveCount(0);
    await expect(requestCard(page, done.entityName)).toHaveCount(0);

    await chooseTab(page, "all");
    for (const [name, status] of [
      [auto.entityName, "AUTO_APPROVED"],
      [done.entityName, "APPROVED"],
    ] as const) {
      const card = requestCard(page, name);
      await expect(card).toHaveAttribute("data-status", status);
      await expect(card.getByTestId("governance-approve")).toHaveCount(0);
      await expect(card.getByTestId("governance-reject")).toHaveCount(0);
    }

    await chooseTab(page, "history");
    await expect(requestCard(page, done.entityName)).toBeVisible();
    await expect(requestCard(page, auto.entityName)).toHaveCount(0);
  });

  test("a user with no Steward or Admin role cannot decide: the request stays pending", { tag: ["@regression"] }, async ({ browser, baseURL, workspace }) => {
    const { id, entityName } = await pendingRequest(workspace.entities[0].id);
    await withSecondUser(browser, baseURL, async (visitor) => {
      const page = visitor.page;
      await openGovernance(page);
      const card = requestCard(page, entityName);
      // Any signed-in user sees the requests of the tenant they are viewing (KD-023: who may see them is a policy not yet decided); only a
      // Steward or an Admin may decide.
      await expect(card).toBeVisible();

      await card.getByTestId("governance-approve").click();
      await afterServerAction(page, () => card.getByTestId("governance-approve").click(), { body: id });

      expect((await governanceOutcome(id)).status).toBe("PENDING");
      expect((await governanceOutcome(id)).decisions).toEqual([]);
      await openGovernance(page);
      await expect(requestCard(page, entityName)).toHaveAttribute("data-status", "PENDING");
    });
  });

  test("a request about an entity of ANOTHER tenant is listed in no tab of this tenant, and the tenant's own request is", { tag: ["@regression"] }, async ({
    authedPage: page,
    workspace,
  }) => {
    const other = await createSecondTenant();
    try {
      const foreignEntity = await createEntityInTenant(other.tenantId, unique("ForeignGovEntity"));
      const home = await pendingRequest(workspace.entities[0].id);
      const away = await pendingRequest(foreignEntity.id, { summary: "Names an owner another tenant must not see", status: "PENDING" });

      await openGovernance(page);
      // The page has answered (its own request is there) before the other tenant's absence means anything.
      await expect(requestCard(page, home.entityName)).toBeVisible();
      for (const name of ["pending", "all", "history"] as const) {
        await chooseTab(page, name);
        await expect(requestCard(page, away.entityName)).toHaveCount(0);
      }
    } finally {
      await deleteTenantWithDomain(other);
    }
  });

  // KD-015: the dashboard drops the action's error (`if ("success" in result)`): a refusal looks like nothing happened.
  test.fail("[KD-015 a refused decision is not explained] a user who may not decide is told so", { tag: ["@regression"] }, async ({ browser, baseURL, workspace }) => {
    const { id, entityName } = await pendingRequest(workspace.entities[0].id);
    await withSecondUser(browser, baseURL, async (visitor) => {
      const page = visitor.page;
      await openGovernance(page);
      const card = requestCard(page, entityName);
      await card.getByTestId("governance-reject").click();
      await afterServerAction(page, () => card.getByTestId("governance-reject").click(), { body: id });
      await expect(centerPanel(page).getByText(/Only Steward or Admin roles can reject/)).toBeVisible({ timeout: 3000 });
    });
  });
});

// ---------------------------------------------------------------------------
// Retention policies
// ---------------------------------------------------------------------------

async function openRetention(page: Page, query = ""): Promise<void> {
  await page.goto(`/governance/retention${query}`);
  await expect(page.getByRole("heading", { name: "Retention Policies", level: 1 })).toBeVisible();
  await expect(centerPanel(page).getByText("Loading entities...")).toHaveCount(0);
}

const entityButton = (page: Page, name: string): Locator => centerPanel(page).getByRole("button", { name: new RegExp(`^${name}\\b`) });
const editor = (page: Page): Locator => centerPanel(page).getByTestId("retention-policy-editor");

async function chooseEntity(page: Page, name: string): Promise<Locator> {
  await entityButton(page, name).click();
  await expect(editor(page).getByRole("heading", { name, level: 3 })).toBeVisible();
  return editor(page);
}

/** Save the open editor and wait for the page's toast. */
async function savePolicy(page: Page): Promise<void> {
  await editor(page).getByTestId("retention-save").click();
  await expect(page.locator('[data-sonner-toast][data-type="success"]').filter({ hasText: "Retention policy saved" })).toBeVisible();
}

const storedPolicy = async (entityId: string): Promise<unknown> => {
  const { rows } = await pg().query(`SELECT metadata->'retentionPolicy' AS policy FROM entities WHERE id = $1`, [entityId]);
  return rows[0]?.policy ?? null;
};

test.describe("retention policies", () => {
  const entityName = unique("RetEntity");
  test.use({ workspaceEntities: [entityName] });

  test("an entity with no policy is listed, an age-based policy is edited and saved, summarised in the list and kept after a reload", { tag: ["@regression"] }, async ({
    authedPage: page,
    workspace,
  }) => {
    const entity = workspace.entities[0];
    await openRetention(page);
    await expect(entityButton(page, entityName)).toBeVisible();
    await expect(entityButton(page, entityName)).not.toContainText("after");

    const form = await chooseEntity(page, entityName);
    // The defaults: age-based, 90 days, delete.
    await expect(form.getByTestId("retention-strategy-age-based")).toHaveAttribute("aria-pressed", "true");
    await expect(form.getByTestId("retention-period")).toHaveValue("90");
    await expect(form.getByTestId("retention-period-unit")).toHaveValue("days");
    await expect(form.getByTestId("retention-action-delete")).toHaveAttribute("aria-pressed", "true");
    await expect(form.getByTestId("retention-preview")).toHaveText("Delete after 90 days");

    await form.getByTestId("retention-period").fill("30");
    await form.getByTestId("retention-action-archive").click();
    await form.getByTestId("retention-description").fill("GDPR: archive customer rows after a month");
    await expect(form.getByTestId("retention-preview")).toHaveText("Archive after 30 days");
    await expect(form.getByTestId("retention-badge")).toHaveText("Archive after 30 days");
    await savePolicy(page);

    await expect(entityButton(page, entityName)).toContainText("Archive after 30 days");
    expect(await storedPolicy(entity.id)).toEqual({ strategy: "age-based", action: "archive", period: 30, periodUnit: "days", description: "GDPR: archive customer rows after a month" });

    await openRetention(page);
    await expect(entityButton(page, entityName)).toContainText("Archive after 30 days");
    const reopened = await chooseEntity(page, entityName);
    await expect(reopened.getByTestId("retention-period")).toHaveValue("30");
    await expect(reopened.getByTestId("retention-action-archive")).toHaveAttribute("aria-pressed", "true");
    await expect(reopened.getByTestId("retention-description")).toHaveValue("GDPR: archive customer rows after a month");
  });

  test("a period of exactly one reads 1 day, 1 month, 1 year (singular) and anything else the plural", { tag: ["@regression"] }, async ({
    authedPage: page,
    workspace,
  }) => {
    await openRetention(page);
    await expect(entityButton(page, entityName)).toContainText(workspace.domainName);
    const form = await chooseEntity(page, entityName);
    const period = form.getByTestId("retention-period");
    const unit = form.getByTestId("retention-period-unit");
    const preview = form.getByTestId("retention-preview");

    await period.fill("1");
    for (const [value, singular, plural] of [
      ["days", "1 day", "2 days"],
      ["months", "1 month", "2 months"],
      ["years", "1 year", "2 years"],
    ] as const) {
      await unit.selectOption(value);
      await period.fill("1");
      await expect(preview).toHaveText(`Delete after ${singular}`);
      await expect(form.getByTestId("retention-badge")).toHaveText(`Delete after ${singular}`);
      await period.fill("2");
      await expect(preview).toHaveText(`Delete after ${plural}`);
    }
    // 11 and 21 are plural too, and the rolling window reads the same way.
    await period.fill("11");
    await expect(preview).toHaveText("Delete after 11 years");
    await form.getByTestId("retention-strategy-rolling-window").click();
    await period.fill("1");
    await unit.selectOption("months");
    await expect(preview).toHaveText("Keep 1 month");
    await period.fill("6");
    await expect(preview).toHaveText("Keep 6 months");
  });

  test("a saved policy of one year reads 1 year in the list, as the list was written by the plural-aware summary", { tag: ["@regression"] }, async ({
    authedPage: page,
    workspace,
  }) => {
    await openRetention(page);
    const form = await chooseEntity(page, entityName);
    await form.getByTestId("retention-period-unit").selectOption("years");
    await form.getByTestId("retention-period").fill("1");
    await form.getByTestId("retention-action-anonymize").click();
    await savePolicy(page);
    await expect(entityButton(page, entityName)).toContainText("Anonymize after 1 year");
    await expect(entityButton(page, entityName)).not.toContainText("1 years");
    expect(await storedPolicy(workspace.entities[0].id)).toMatchObject({ strategy: "age-based", action: "anonymize", period: 1, periodUnit: "years" });
  });

  test("the condition, rolling-window and indefinite strategies show their own fields, summarise and are kept", { tag: ["@regression"] }, async ({
    authedPage: page,
    workspace,
  }) => {
    const entity = workspace.entities[0];
    await openRetention(page);
    const form = await chooseEntity(page, entityName);

    await form.getByTestId("retention-strategy-condition-based").click();
    await expect(form.getByTestId("retention-period")).toHaveCount(0);
    await expect(form.getByTestId("retention-condition")).toBeVisible();
    await expect(form.getByText("Available fields: id")).toBeVisible();
    await expect(form.getByTestId("retention-preview")).toHaveText("Delete when custom condition");
    await form.getByTestId("retention-condition").fill("status = 'DELETED'");
    await expect(form.getByTestId("retention-preview")).toHaveText("Delete when status = 'DELETED'");
    // A long condition is cut at 40 characters, with an ellipsis, in the summary.
    const long = "status = 'DELETED' AND created_at < NOW() - INTERVAL 1 YEAR";
    await form.getByTestId("retention-condition").fill(long);
    await expect(form.getByTestId("retention-preview")).toHaveText(`Delete when ${long.substring(0, 37)}...`);
    await savePolicy(page);
    expect(await storedPolicy(entity.id)).toMatchObject({ strategy: "condition-based", condition: "status = 'DELETED' AND created_at < NOW() - INTERVAL 1 YEAR" });

    await form.getByTestId("retention-strategy-indefinite").click();
    await expect(form.getByTestId("retention-condition")).toHaveCount(0);
    await expect(form.getByText("Data will be retained indefinitely.")).toBeVisible();
    await expect(form.getByTestId("retention-preview")).toHaveText("Retain indefinitely");
    await savePolicy(page);
    await expect(entityButton(page, entityName)).toContainText("Retain indefinitely");
    // A policy of another strategy leaves nothing of the first behind.
    const stored = (await storedPolicy(entity.id)) as Record<string, unknown>;
    expect(stored.strategy).toBe("indefinite");
    expect(stored).not.toHaveProperty("condition");

    await openRetention(page);
    await expect(entityButton(page, entityName)).toContainText("Retain indefinitely");
  });

  test("a period that cannot be saved is said, and nothing is written", { tag: ["@regression"] }, async ({ authedPage: page, workspace }) => {
    await openRetention(page);
    const form = await chooseEntity(page, entityName);

    await form.getByTestId("retention-period").fill("-5");
    await form.getByTestId("retention-save").click();

    // The words of the schema's rule: a whole number of 1 or more.
    await expect(form.getByTestId("retention-error")).toHaveText("The period must be a whole number of 1 or more.");
    expect(await storedPolicy(workspace.entities[0].id)).toBeNull();
    await expect(page.locator('[data-sonner-toast][data-type="success"]')).toHaveCount(0);

    // The refusal described the policy as it was: editing the period takes it away, and the corrected policy is saved.
    await form.getByTestId("retention-period").fill("7");
    await expect(form.getByTestId("retention-error")).toHaveCount(0);
    await savePolicy(page);
    expect(await storedPolicy(workspace.entities[0].id)).toMatchObject({ strategy: "age-based", period: 7 });
  });

  test("an entity with a PII field and no policy is flagged, and the flag goes when a policy is saved", { tag: ["@regression"] }, async ({
    authedPage: page,
    workspace,
  }) => {
    const entity = workspace.entities[0];
    await createFieldRow(entity.id, { name: "email", classification: "PII" });
    await openRetention(page);
    await expect(entityButton(page, entityName)).toContainText("PII/Sensitive data — no retention policy");
    await expect(centerPanel(page).getByText(/without policy/)).toBeVisible();

    const form = await chooseEntity(page, entityName);
    await form.getByTestId("retention-period").fill("7");
    await form.getByTestId("retention-period-unit").selectOption("years");
    await savePolicy(page);
    await expect(entityButton(page, entityName)).not.toContainText("no retention policy");
    await expect(entityButton(page, entityName)).toContainText("Delete after 7 years");
  });

  test("the entity address opens its editor, with the date fields of the entity to refer to", { tag: ["@regression"] }, async ({ authedPage: page, workspace }) => {
    const entity = workspace.entities[0];
    await createFieldRow(entity.id, { name: "created_at", type: "utcDateTime", sortOrder: 2 });
    await openRetention(page, `?entity=${entity.id}`);

    await expect(editor(page).getByRole("heading", { name: entityName, level: 3 })).toBeVisible();
    const reference = editor(page).getByTestId("retention-reference-field");
    await expect(reference.locator("option")).toHaveText(["Select a date field...", "created_at (utcDateTime)", "id (string)"]);
    await reference.selectOption("created_at");
    await expect(editor(page).getByTestId("retention-preview")).toHaveText("Delete after 90 days (created_at)");
    await savePolicy(page);
    expect(await storedPolicy(entity.id)).toMatchObject({ referenceField: "created_at" });
  });
});

// ---------------------------------------------------------------------------
// Compliance: Query
// ---------------------------------------------------------------------------

async function openCompliance(page: Page): Promise<void> {
  await page.goto("/compliance");
  await expect(page.getByRole("heading", { name: "Compliance", level: 1 })).toBeVisible();
  await waitForHydration(centerPanel(page).getByTestId("compliance-filter-search"));
}

async function searchFor(page: Page, text: string): Promise<void> {
  await centerPanel(page).getByTestId("compliance-filter-search").fill(text);
}

const resultRows = (page: Page): Locator => centerPanel(page).getByTestId("compliance-row");
const rowFor = (page: Page, field: string): Locator => centerPanel(page).locator(`[data-testid="compliance-row"][data-field="${field}"]`);
const gapRows = (page: Page, entity: string, extra = ""): Locator => centerPanel(page).locator(`[data-testid="compliance-gap-row"][data-entity="${entity}"]${extra}`);
const complianceTab = (page: Page, name: "Query" | "Gaps" | "Audit Trail"): Locator => centerPanel(page).getByRole("button", { name, exact: true });

/** An entity with fields that cover every case the compliance pages tell apart. */
async function seedComplianceEntity(entity: { id: string }): Promise<void> {
  const key = await pg().query(`SELECT id FROM fields WHERE "entityId" = $1 AND name = 'id'`, [entity.id]);
  await setFieldGovernance(key.rows[0].id as string, { classification: "INTERNAL", policy: { retention: "5 years", encryption: "AES-256" } });
  await createFieldRow(entity.id, { name: "email", classification: "PII", policy: { retention: "2 years", anonymization: "hash" }, sortOrder: 1 });
  await createFieldRow(entity.id, { name: "salary", type: "decimal", classification: "SENSITIVE", sortOrder: 2 });
  await createFieldRow(entity.id, { name: "notes", sortOrder: 3 });
}

test.describe("compliance: query, gaps, audit trail and exports", () => {
  const entityName = unique("CompEntity");
  test.use({ workspaceEntities: [entityName] });

  test("the Query tab lists the fields with their classification, retention, anonymization and domain, and the text filter finds them by entity", { tag: ["@regression"] }, async ({
    authedPage: page,
    workspace,
  }) => {
    await seedComplianceEntity(workspace.entities[0]);
    await openCompliance(page);
    await searchFor(page, entityName);

    await expect(resultRows(page)).toHaveCount(4);
    await expect(centerPanel(page).getByTestId("compliance-result-count")).toHaveText("Showing 1-4 of 4 fields matching filters");
    const email = rowFor(page, "email");
    await expect(email.getByRole("cell").nth(0)).toHaveText(entityName);
    await expect(email.getByRole("cell").nth(2)).toHaveText("string");
    await expect(email.getByRole("cell").nth(3)).toHaveText("PII");
    await expect(email.getByRole("cell").nth(4)).toHaveText("2 years");
    await expect(email.getByRole("cell").nth(5)).toHaveText("hash");
    await expect(email.getByRole("cell").nth(6)).toHaveText(workspace.domainName);
    await expect(rowFor(page, "salary").getByRole("cell").nth(3)).toHaveText("SENSITIVE");
    await expect(rowFor(page, "salary").getByRole("cell").nth(4)).toHaveText("--");
    await expect(rowFor(page, "notes").getByRole("cell").nth(3)).toHaveText("--");
    await expect(rowFor(page, "id").getByRole("cell").nth(3)).toHaveText("INTERNAL");

    // A field name finds the same entity's field; a text nothing has says so.
    await searchFor(page, "salary");
    await expect(resultRows(page).filter({ hasText: entityName })).toHaveCount(1);
    await searchFor(page, "no-field-has-this-text-xyz");
    await expect(centerPanel(page).getByText("No fields match the current filters")).toBeVisible();
    await expect(centerPanel(page).getByTestId("compliance-result-count")).toHaveText("Showing 0 of 0 fields matching filters");
  });

  test("the classification, retention, anonymization and domain filters narrow the rows, and 'Clear all filters' brings them back", { tag: ["@regression"] }, async ({
    authedPage: page,
    workspace,
  }) => {
    await seedComplianceEntity(workspace.entities[0]);
    await openCompliance(page);
    const side = centerPanel(page).getByTestId("compliance-filter-sidebar");
    await searchFor(page, entityName);
    await expect(resultRows(page)).toHaveCount(4);

    await side.getByLabel("PII", { exact: true }).check();
    await expect(resultRows(page)).toHaveCount(1);
    await expect(resultRows(page)).toHaveAttribute("data-field", "email");

    await side.getByLabel("SENSITIVE", { exact: true }).check();
    await expect(resultRows(page)).toHaveCount(2);
    await side.getByLabel("PII", { exact: true }).uncheck();
    await side.getByLabel("SENSITIVE", { exact: true }).uncheck();
    await expect(resultRows(page)).toHaveCount(4);

    // Retention ranges: 2 years is "1-3 years", 5 years is "3-7 years"; a field with none is in no range.
    await side.getByTestId("compliance-filter-retention").selectOption("1_to_3_years");
    await expect(resultRows(page)).toHaveCount(1);
    await expect(resultRows(page)).toHaveAttribute("data-field", "email");
    await side.getByTestId("compliance-filter-retention").selectOption("3_to_7_years");
    await expect(resultRows(page)).toHaveCount(1);
    await expect(resultRows(page)).toHaveAttribute("data-field", "id");
    await side.getByTestId("compliance-filter-retention").selectOption("any");
    await expect(resultRows(page)).toHaveCount(4);

    await side.getByTestId("compliance-filter-anonymization").selectOption("hash");
    await expect(resultRows(page)).toHaveCount(1);
    await expect(resultRows(page)).toHaveAttribute("data-field", "email");
    await side.getByTestId("compliance-filter-anonymization").selectOption("any");

    await side.getByTestId("compliance-filter-encryption").selectOption("AES-256");
    await expect(resultRows(page)).toHaveCount(1);
    await expect(resultRows(page)).toHaveAttribute("data-field", "id");
    await side.getByTestId("compliance-filter-encryption").selectOption("any");

    // The domain list is the tenant's domains: this test's domain filters the fields to the ones in it.
    await side.getByLabel(workspace.domainName, { exact: true }).check();
    await expect(resultRows(page)).toHaveCount(4);
    await side.getByLabel("PII", { exact: true }).check();
    await expect(resultRows(page)).toHaveCount(1);

    await side.getByTestId("compliance-filter-clear").click();
    await expect(side.getByTestId("compliance-filter-search")).toHaveValue("");
    await expect(side.getByLabel("PII", { exact: true })).not.toBeChecked();
    await expect(side.getByTestId("compliance-filter-retention")).toHaveValue("any");
  });

  test("sorting by a column reorders the rows, and a row opens the entity page", { tag: ["@regression"] }, async ({ authedPage: page, workspace }) => {
    await seedComplianceEntity(workspace.entities[0]);
    await openCompliance(page);
    await searchFor(page, entityName);
    await expect(resultRows(page)).toHaveCount(4);

    const header = centerPanel(page).getByRole("columnheader", { name: /^Field Name/ });
    await header.click();
    await expect.poll(async () => resultRows(page).evaluateAll((rows) => rows.map((row) => row.getAttribute("data-field")))).toEqual(["email", "id", "notes", "salary"]);
    await header.click();
    await expect.poll(async () => resultRows(page).evaluateAll((rows) => rows.map((row) => row.getAttribute("data-field")))).toEqual(["salary", "notes", "id", "email"]);

    await rowFor(page, "salary").click();
    await expect(page).toHaveURL(new RegExp(`/schemas/${workspace.domainSlug}/${workspace.productSlug}/${workspace.entities[0].slug}(\\?|$)`));
    await expect(centerPanel(page).getByRole("heading", { level: 1, name: entityName })).toBeVisible();
  });

  test("the Gaps tab lists what is missing on the fields of the entity, with severity, and a row opens the entity at the field", { tag: ["@regression"] }, async ({
    authedPage: page,
    workspace,
  }) => {
    await seedComplianceEntity(workspace.entities[0]);
    await openCompliance(page);
    await complianceTab(page, "Gaps").click();
    await expect(centerPanel(page).getByTestId("compliance-gaps-view")).toBeVisible();

    const gaps = gapRows(page, entityName);
    // notes: unclassified (critical). email: PII with anonymization and retention: none. salary: sensitive with no encryption and no retention
    // (two warnings). id: INTERNAL, nothing is required of it.
    await expect.poll(() => gaps.evaluateAll((rows) => rows.map((row) => `${row.getAttribute("data-field")}:${row.getAttribute("data-gap")}:${row.getAttribute("data-severity")}`).sort())).toEqual([
      "notes:UNCLASSIFIED:CRITICAL",
      "salary:NO_RETENTION:WARNING",
      "salary:SENSITIVE_NO_ENCRYPTION:WARNING",
    ]);
    const unclassified = gapRows(page, entityName, '[data-gap="UNCLASSIFIED"]');
    await expect(unclassified).toContainText("Unclassified");
    await expect(unclassified).toContainText("Add classification to field");
    await expect(gapRows(page, entityName, '[data-gap="SENSITIVE_NO_ENCRYPTION"]')).toContainText("Sensitive No Encryption");

    await unclassified.click();
    await expect(page).toHaveURL(/fieldId=.+&panel=classification/);
    await expect(page).toHaveURL(new RegExp(`/schemas/${workspace.domainSlug}/${workspace.productSlug}/${workspace.entities[0].slug}`));
  });

  test("a gap goes away when the field is fixed: a PII field with anonymization and retention is no gap", { tag: ["@regression"] }, async ({ authedPage: page, workspace }) => {
    const entity = workspace.entities[0];
    const { id: piiId } = await createFieldRow(entity.id, { name: "ssn", classification: "PII" });
    await openCompliance(page);
    await complianceTab(page, "Gaps").click();
    const gaps = gapRows(page, entityName, '[data-field="ssn"]');
    await expect(gaps).toHaveCount(2); // no anonymization, no retention

    await setFieldGovernance(piiId, { classification: "PII", policy: { retention: "1 year", anonymization: "mask" } });
    await openCompliance(page);
    await complianceTab(page, "Gaps").click();
    await expect(centerPanel(page).getByTestId("compliance-gaps-view").or(centerPanel(page).getByTestId("gaps-empty-state"))).toBeVisible();
    await expect(gaps).toHaveCount(0);
  });

  test("the Audit Trail lists an action performed in the app with its user, action, type and id, filters by id and by action, and expands to the record", { tag: ["@regression"] }, async ({
    authedPage: page,
    workspace,
  }) => {
    const entity = workspace.entities[0];
    await openEntityPage(page, entity.url, entityName);
    await addFieldQuick(page, "memo");
    const { rows } = await pg().query(`SELECT id FROM fields WHERE "entityId" = $1 AND name = 'memo'`, [entity.id]);
    const memoId = rows[0].id as string;
    await deleteFieldRow(page, "memo");
    await expect(fieldRow(page, "memo")).toHaveCount(0);

    await openCompliance(page);
    await complianceTab(page, "Audit Trail").click();
    await expect(centerPanel(page).getByTestId("audit-trail-view")).toBeVisible();
    await centerPanel(page).getByTestId("audit-filter-entity").fill(memoId);

    const entries = centerPanel(page).getByTestId("audit-entry");
    await expect(entries).toHaveCount(1);
    await expect(entries).toHaveAttribute("data-action", "DELETE");
    await expect(entries).toHaveAttribute("data-entity-type", "Field");
    await expect(entries).toHaveAttribute("data-entity-id", memoId);
    await expect(entries).toContainText("Admin");
    await expect(entries).toContainText("Deleted record");

    // Expanded: the record as it was (the diff viewer names the field).
    await entries.getByText("Deleted record").click();
    await expect(entries).toContainText("memo");

    // The action filter: DELETE keeps it, CREATE does not (a field is made with entity id "pending", not this id).
    await centerPanel(page).getByTestId("audit-filter-action").selectOption("CREATE");
    await expect(centerPanel(page).getByText("No audit entries match the current filters.")).toBeVisible();
    await centerPanel(page).getByTestId("audit-filter-action").selectOption("DELETE");
    await expect(entries).toHaveCount(1);
    await centerPanel(page).getByTestId("audit-filter-type").selectOption("Domain");
    await expect(entries).toHaveCount(0);
    await centerPanel(page).getByTestId("audit-filter-type").selectOption("Field");
    await expect(entries).toHaveCount(1);
  });

  test("the Query tab's CSV is downloaded under a dated name with the header row and a row for each field of the entity", { tag: ["@regression"] }, async ({
    authedPage: page,
    workspace,
  }) => {
    await seedComplianceEntity(workspace.entities[0]);
    await openCompliance(page);
    await searchFor(page, entityName);
    await expect(resultRows(page)).toHaveCount(4);
    await centerPanel(page).getByTestId("compliance-filter-sidebar").getByLabel("PII", { exact: true }).check();
    await expect(resultRows(page)).toHaveCount(1);

    await centerPanel(page).getByRole("button", { name: "Export", exact: true }).click();
    const [download] = await Promise.all([page.waitForEvent("download"), centerPanel(page).getByRole("button", { name: /^CSV/ }).click()]);

    // The classification filter is part of the name: compliance-report-<date>-pii.csv
    expect(download.suggestedFilename()).toMatch(/^compliance-report-\d{4}-\d{2}-\d{2}-pii\.csv$/);
    const csv = readFileSync((await download.path()) as string, "utf8").split("\n");
    expect(csv[0]).toBe("Entity,Field,Type,Classification,Retention,Anonymization,Encryption,Targets,Domain");
    expect(csv).toHaveLength(2);
    expect(csv[1]).toBe(`"${entityName}","email","string","PII","2 years","hash","","","${workspace.domainName}"`);
  });

  test("the Query tab's JSON, and the Gaps tab's CSV and JSON, are downloaded too", { tag: ["@regression"] }, async ({ authedPage: page, workspace }) => {
    await seedComplianceEntity(workspace.entities[0]);
    await openCompliance(page);
    await searchFor(page, entityName);
    await expect(resultRows(page)).toHaveCount(4);

    await centerPanel(page).getByRole("button", { name: "Export", exact: true }).click();
    const [queryJson] = await Promise.all([page.waitForEvent("download"), centerPanel(page).getByRole("button", { name: /^JSON/ }).click()]);
    expect(queryJson.suggestedFilename()).toMatch(/^compliance-report-\d{4}-\d{2}-\d{2}\.json$/);
    const fields = JSON.parse(readFileSync((await queryJson.path()) as string, "utf8")) as Array<{ entityName: string; fieldName: string; classification: string | null }>;
    expect(fields.map((field) => `${field.fieldName}:${field.classification}`).sort()).toEqual(["email:PII", "id:INTERNAL", "notes:null", "salary:SENSITIVE"]);
    expect(new Set(fields.map((field) => field.entityName))).toEqual(new Set([entityName]));

    await complianceTab(page, "Gaps").click();
    await expect(centerPanel(page).getByTestId("compliance-gaps-view")).toBeVisible();
    await centerPanel(page).getByRole("button", { name: "Export", exact: true }).click();
    const [gapsCsv] = await Promise.all([page.waitForEvent("download"), centerPanel(page).getByRole("button", { name: /^CSV/ }).click()]);
    expect(gapsCsv.suggestedFilename()).toMatch(/^compliance-report-\d{4}-\d{2}-\d{2}\.csv$/);
    const lines = readFileSync((await gapsCsv.path()) as string, "utf8").split("\n");
    expect(lines[0]).toBe("Entity Name,Field Name,Gap Type,Severity,Suggested Fix");
    expect(lines).toContain(`"${entityName}","notes","UNCLASSIFIED","CRITICAL","Add classification to field (PII, SENSITIVE, INTERNAL, or PUBLIC)"`);
    expect(lines.filter((line) => line.startsWith(`"${entityName}"`))).toHaveLength(3);
  });

  test("the Audit Trail's CSV is downloaded with the header row and the row of the action", { tag: ["@regression"] }, async ({ authedPage: page, workspace }) => {
    const entity = workspace.entities[0];
    await openEntityPage(page, entity.url, entityName);
    await addFieldQuick(page, "scratch");
    const { rows } = await pg().query(`SELECT id FROM fields WHERE "entityId" = $1 AND name = 'scratch'`, [entity.id]);
    const scratchId = rows[0].id as string;
    await deleteFieldRow(page, "scratch");

    await openCompliance(page);
    await complianceTab(page, "Audit Trail").click();
    await centerPanel(page).getByTestId("audit-filter-entity").fill(scratchId);
    await expect(centerPanel(page).getByTestId("audit-entry")).toHaveCount(1);

    const [download] = await Promise.all([page.waitForEvent("download"), centerPanel(page).getByTestId("audit-export").click()]);
    expect(download.suggestedFilename()).toMatch(/^audit-trail-\d{4}-\d{2}-\d{2}\.csv$/);
    const lines = readFileSync((await download.path()) as string, "utf8").split("\n");
    expect(lines[0]).toBe("Timestamp,User,Action,Entity Type,Entity ID,Change Summary");
    expect(lines).toHaveLength(2);
    expect(lines[1]).toMatch(new RegExp(`^"\\d{4}-\\d{2}-\\d{2}T[\\d:.]+Z","Admin","DELETE","Field","${scratchId}","Deleted record"$`));
  });
});

// ---------------------------------------------------------------------------
// Access
// ---------------------------------------------------------------------------

test.describe("compliance access", () => {
  test("the compliance API answers 401 without a session and 403 to a user with no role, and the page says so", { tag: ["@regression"] }, async ({
    browser,
    baseURL,
    playwright,
  }) => {
    // `playwright.request.newContext` carries the project's login unless it is told it has none.
    const anonymous = await playwright.request.newContext({ baseURL, storageState: { cookies: [], origins: [] } });
    try {
      for (const path of ["/api/compliance/query", "/api/compliance/gaps", "/api/compliance/audit-trail"]) {
        const response = await anonymous.post(path, { data: { filters: {} }, maxRedirects: 0 });
        expect(response.status(), path).toBe(401);
        expect(await response.text(), path).not.toContain("entityName");
      }
    } finally {
      await anonymous.dispose();
    }

    await withSecondUser(browser, baseURL, async (visitor) => {
      for (const path of ["/api/compliance/query", "/api/compliance/gaps", "/api/compliance/audit-trail"]) {
        const response = await visitor.context.request.post(path, { data: { filters: {} } });
        expect(response.status(), path).toBe(403);
        expect(((await response.json()) as { success: boolean }).success).toBe(false);
      }
      await visitor.page.goto("/compliance");
      await expect(centerPanel(visitor.page).getByTestId("compliance-error")).toContainText("Insufficient permissions");
      await expect(centerPanel(visitor.page).getByTestId("compliance-row")).toHaveCount(0);
    });
  });

});

test.describe("compliance tenants", () => {
  const prefix = unique("CompIso");
  test.use({ workspaceEntities: [`${prefix}Home`] });

  // The Query and Gaps tabs read the fields of the tenant being viewed (the audit trail has no tenant column: KD-016).
  test("the Query and Gaps tabs list the fields of this tenant and not those of another", { tag: ["@regression"] }, async ({ authedPage: page, workspace }) => {
    // `workspace` is asked for by name: a fixture that no test asks for is never made (the pinned test of KD-016 never made its home entity,
    // and "failed" because the row was missing, not because the other tenant's was there).
    const home = workspace.entities[0].name;
    expect(home).toBe(`${prefix}Home`);
    const other = await createSecondTenant();
    try {
      await createEntityInTenant(other.tenantId, `${prefix}Away`);
      await openCompliance(page);
      await searchFor(page, prefix);
      // The entity of this tenant is listed (the query has answered), the one of the other tenant is not.
      await expect(resultRows(page).filter({ hasText: home })).toHaveCount(1);
      await expect(resultRows(page).filter({ hasText: `${prefix}Away` })).toHaveCount(0);

      // Both entities have an unclassified field `id`: a gap for the tenant's, none for the other's.
      await complianceTab(page, "Gaps").click();
      await expect(gapRows(page, home, '[data-gap="UNCLASSIFIED"]')).toHaveCount(1);
      await expect(gapRows(page, `${prefix}Away`)).toHaveCount(0);
    } finally {
      await deleteTenantWithDomain(other);
    }
  });
});
