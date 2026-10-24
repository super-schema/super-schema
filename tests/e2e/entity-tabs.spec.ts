/**
 * The tabs and panels of the entity page that the publish spec does not touch, through the real UI on the release run's throwaway
 * database: Governance (the retention policy), Alerts, API, Deployments, TypeSpec, the field studio page, the right panel, the
 * primary-key dialog, the per-target type override and the staged emit dialog.
 *
 * The workspace (a domain, a product and the entities named by `workspaceEntities`, each with one key field `id`) is made in the
 * database by the `workspace` fixture and removed afterwards. Generation goes through the real emitters (the Schemas tab); everything
 * else is only the app.
 *
 * Affordances that exist in the code and cannot be reached in the UI (recorded in the task report, so they are not forgotten):
 *   - `TypeMappingOverrideDialog` is mounted by the entity workspace with `mappingContext={null}` and nothing ever opens it
 *     (`setOverrideDialogOpen(true)` is not called anywhere): the per-target override is reached through the Schemas tab's "Manual
 *     Override" table, which is what the type override test below drives;
 *   - `SchemaTargetChooser` and `TechnologyCard` are not rendered by any page (a unit test is their only user);
 *   - the right panel has the Field Edit and TypeSpec tabs only: there are no annotations or drift tabs. Change history is the
 *     Versions tab's Change Log, drift is the Deployments tab's "Check Drift".
 */
import { test, expect, unique } from "./helpers/fixtures";
import { centerPanel } from "./helpers/event-builder";
import { createNavFixtures, deleteNavFixtures, pg } from "./helpers/db";
import { waitForHydration } from "./helpers/hydration";
import {
  addFieldQuick,
  addReferenceField,
  afterServerAction,
  openEntityPage,
  openVersionsTab,
  publishViaDialog,
  successToast,
  versionState,
} from "./helpers/entity-page";
import { generateTarget, openEditor, openSchemasTab, readPreview, readTypeSpecSource, saveTypeSpecSource, errorToast } from "./helpers/lifecycle";

const ID = {
  tab: (name: "editor" | "versions" | "governance" | "alerts" | "api" | "deployments" | "typespec" | "schemas") => `tab-${name}`,
  governanceTab: "governance-tab",
  retentionEditor: "retention-policy-editor",
  retentionStrategy: (name: string) => `retention-strategy-${name}`,
  retentionAction: (name: string) => `retention-action-${name}`,
  retentionPeriod: "retention-period",
  retentionUnit: "retention-period-unit",
  retentionField: "retention-reference-field",
  retentionPreview: "retention-preview",
  retentionSave: "retention-save",
  inlineRetention: "inline-retention",
  inlineOwnerButton: "inline-owner-button",
  inlineOwnerInput: "inline-owner-input",
  metaSave: "meta-save-btn",
  metaControls: "meta-save-controls",
  addDescription: "entity-add-description",
  descriptionInput: "entity-description-input",
  descriptionSave: "entity-description-save",
  alertsTab: "alerts-tab",
  alertsSummary: "alerts-summary",
  alertsEmpty: "alerts-empty",
  alertCard: "alert-card",
  alertAction: "alert-action",
  apiTab: "api-tab",
  apiAdd: "api-add-operation",
  apiName: "api-op-name",
  apiMethod: "api-op-method",
  apiPath: "api-op-path",
  apiDescription: "api-op-description",
  apiCreate: "api-op-create",
  apiOperation: "api-operation",
  apiEmpty: "api-empty",
  deploymentsTab: "deployments-tab",
  deploymentEmpty: "deployment-empty",
  deploymentTarget: "deployment-target",
  deploymentEnvironment: "deployment-environment",
  deploymentUntracked: "deployment-untracked",
  deploymentMark: "deployment-mark-deployed",
  deploymentCheckDrift: "deployment-check-drift",
  markDeployedDialog: "mark-deployed-dialog",
  environmentSelector: "environment-selector",
  confirmDeploy: "confirm-deploy-button",
  typespecTextarea: "typespec-source-textarea",
  typespecSave: "typespec-save",
  typespecDiagnostics: "typespec-diagnostics",
  studioName: "field-studio-name",
  studioStatus: "field-studio-save-status",
  studioDone: "field-studio-done",
  studioDefault: "field-default-value",
  openStudio: "field-open-studio",
  rightToggle: "right-panel-toggle",
  rightTab: (name: "field-edit" | "typespec-preview") => `right-panel-tab-${name}`,
  typespecPreview: "typespec-preview",
  typespecEditToggle: "typespec-edit-toggle",
  typespecEditor: "typespec-editor-textarea",
  typespecPreviewChanges: "typespec-preview-changes-btn",
  typespecDiff: "typespec-diff-summary",
  typespecApply: "typespec-apply-btn",
  fieldEditPanel: "field-edit-panel",
  schemaTarget: (key: string) => `schema-target-${key}`,
  schemaGenerate: "schema-generate",
  schemaStage: "schema-stage-emit",
  schemaContentTab: (name: "schema" | "overrides" | "matrix") => `schema-content-tab-${name}`,
  schemaMarkDeployed: "schema-mark-deployed",
  schemaDeployedBadge: "schema-deployed-badge",
  schemaVersion: "schema-version-button",
  overrideRow: "override-row",
  overrideTrigger: "override-type-trigger",
  primaryKeyDialog: "primary-key-dialog",
  primaryKeyOption: "primary-key-option",
  primaryKeyConfirm: "primary-key-confirm",
  primaryKeyCancel: "primary-key-cancel",
  stagedDialog: "staged-emit-dialog",
  stagedTarget: "staged-emit-target",
  stagedCount: "staged-emit-count",
  stagedSubmit: "staged-emit-submit",
  stagedCancel: "staged-emit-cancel",
  changeHistory: "change-history-view",
  timelineEmpty: "timeline-empty",
} as const;

const alertsLabel = (count: number) => (count === 0 ? "Alerts" : `Alerts (${count})`);

test.describe("Governance and Alerts", () => {
  test.use({ workspaceEntities: ["Ledger"] });

  test("Governance: the retention policy is edited, saved, shown in the entity's header and kept after a reload", { tag: ["@regression"] }, async ({
    authedPage: page,
    workspace,
  }) => {
    const [ledger] = workspace.entities;
    const main = centerPanel(page);
    await openEntityPage(page, ledger.url, ledger.name);
    await expect(main.getByTestId(ID.inlineRetention)).toHaveText("No retention policy");

    await main.getByTestId(ID.tab("governance")).click();
    const editor = main.getByTestId(ID.retentionEditor);
    await expect(editor).toBeVisible();
    // Defaults: age-based, 90 days, delete.
    await expect(editor.getByTestId(ID.retentionStrategy("age-based"))).toHaveAttribute("aria-pressed", "true");
    await expect(editor.getByTestId(ID.retentionPreview)).toHaveText("Delete after 90 days");

    // A period of exactly one reads singular; the preview follows each control.
    await editor.getByTestId(ID.retentionPeriod).fill("1");
    await editor.getByTestId(ID.retentionUnit).selectOption("years");
    await editor.getByTestId(ID.retentionAction("archive")).click();
    await editor.getByTestId(ID.retentionField).selectOption("id");
    await expect(editor.getByTestId(ID.retentionPreview)).toHaveText("Archive after 1 year (id)");

    await editor.getByTestId(ID.retentionSave).click();
    await expect(successToast(page, "Retention policy saved")).toBeVisible();
    await expect(main.getByTestId(ID.inlineRetention)).toHaveText("Archive after 1 year (id)");

    // Persisted: the header and the editor are what a fresh load shows.
    await openEntityPage(page, ledger.url, ledger.name);
    await expect(main.getByTestId(ID.inlineRetention)).toHaveText("Archive after 1 year (id)");
    await main.getByTestId(ID.tab("governance")).click();
    const again = main.getByTestId(ID.retentionEditor);
    await expect(again.getByTestId(ID.retentionAction("archive"))).toHaveAttribute("aria-pressed", "true");
    await expect(again.getByTestId(ID.retentionPeriod)).toHaveValue("1");
    await expect(again.getByTestId(ID.retentionUnit)).toHaveValue("years");

    // Another strategy replaces it (indefinite has no period).
    await again.getByTestId(ID.retentionStrategy("indefinite")).click();
    await expect(again.getByTestId(ID.retentionPreview)).toHaveText("Retain indefinitely");
    await again.getByTestId(ID.retentionSave).click();
    await expect(successToast(page, "Retention policy saved").last()).toBeVisible();
    await expect(main.getByTestId(ID.inlineRetention)).toHaveText("Retain indefinitely");
  });

  test("Alerts: the count on the tab, one card per unmet requirement, and each fix takes its alert away", { tag: ["@regression"] }, async ({
    authedPage: page,
    workspace,
  }) => {
    test.setTimeout(120_000);
    const [ledger] = workspace.entities;
    const main = centerPanel(page);
    const tab = main.getByTestId(ID.tab("alerts"));
    const cards = main.getByTestId(ID.alertCard);

    await openEntityPage(page, ledger.url, ledger.name);
    // A domain without a policy uses the defaults: an owner, a description, a retention policy and a description per field.
    await expect(tab).toHaveText(alertsLabel(4));
    await expect(tab).toHaveAttribute("data-alert-count", "4");
    await tab.click();
    await expect(main.getByTestId(ID.alertsTab)).toBeVisible();
    await expect(main.getByTestId(ID.alertsSummary)).toContainText("4 warnings");
    await expect(cards).toHaveCount(4);
    await expect(cards.filter({ hasText: "Owner not set" })).toHaveAttribute("data-alert-id", "entity-owner");
    await expect(cards.filter({ hasText: "Description missing" })).toHaveAttribute("data-alert-id", "entity-description");
    await expect(cards.filter({ hasText: "No retention policy" })).toHaveAttribute("data-alert-id", "entity-retention");
    await expect(cards.filter({ hasText: 'Field "id" has no description' })).toHaveAttribute("data-alert-id", /^field-desc-/);
    await expect(cards.first()).toHaveAttribute("data-severity", "warning");

    // "Set retention policy" goes to the Governance tab, where the fix is made.
    await cards.filter({ hasText: "No retention policy" }).getByTestId(ID.alertAction).click();
    await expect(main.getByTestId(ID.governanceTab)).toBeVisible();
    await main.getByTestId(ID.retentionStrategy("indefinite")).click();
    await main.getByTestId(ID.retentionSave).click();
    await expect(successToast(page, "Retention policy saved")).toBeVisible();

    // The owner and the description are the entity's header (shown on every tab).
    await main.getByTestId(ID.inlineOwnerButton).click();
    await main.getByTestId(ID.inlineOwnerInput).fill("Data Platform");
    await main.getByTestId(ID.inlineOwnerInput).press("Enter");
    await main.getByTestId(ID.metaSave).click();
    await expect(main.getByTestId(ID.metaControls)).toHaveCount(0);

    await main.getByTestId(ID.addDescription).click();
    await main.getByTestId(ID.descriptionInput).fill("The general ledger of the company");
    // Nothing on the page says the description was saved: wait for the server's answer before leaving the page.
    await afterServerAction(page, () => main.getByTestId(ID.descriptionSave).click());
    await expect(main.getByTestId("entity-description")).toHaveText("The general ledger of the company");

    // Three of the four are met, and that is what a fresh load says.
    await openEntityPage(page, ledger.url, ledger.name);
    await expect(tab).toHaveText(alertsLabel(1));
    await tab.click();
    await expect(cards).toHaveCount(1);
    await expect(cards.first()).toContainText('Field "id" has no description');

    // "Edit field" goes back to the editor with the field selected in the right panel; describe it there.
    await cards.first().getByTestId(ID.alertAction).click();
    const panel = page.getByTestId(ID.fieldEditPanel);
    await expect(panel).toBeVisible({ timeout: 30_000 });
    await panel.getByRole("button", { name: "Add description..." }).click();
    await panel.getByPlaceholder("Add description...").fill("The key of the ledger entry");
    await page.keyboard.press("Enter");
    // The Save bar goes at once; the server's answer is what says the field is stored (a load before it would read the old field).
    await afterServerAction(page, () => panel.getByTestId("field-save-btn").click());
    await expect(panel.getByTestId("field-save-btn")).toHaveCount(0);

    await openEntityPage(page, ledger.url, ledger.name);
    await expect(tab).toHaveText("Alerts");
    await expect(tab).toHaveAttribute("data-alert-count", "0");
    await tab.click();
    await expect(main.getByTestId(ID.alertsEmpty)).toContainText("No alerts");
    await expect(main.getByTestId(ID.alertsEmpty)).toContainText("This entity meets all completeness requirements.");
  });
});

// Unique names: the reference prompt lists every entity of the tenant.
const CUSTOMER = unique("Customer");
const ORDER = unique("Order");

test.describe("Alerts about references", () => {
  test.use({ workspaceEntities: [CUSTOMER, ORDER] });

  test("Alerts: a referenced entity that published a newer version since is reported on the entity that references it", { tag: ["@regression"] }, async ({
    authedPage: page,
    workspace,
  }) => {
    test.setTimeout(120_000);
    const [customer, order] = workspace.entities;
    const main = centerPanel(page);

    await openEntityPage(page, customer.url, customer.name);
    expect(await publishViaDialog(page)).toBe("1.0");

    await openEntityPage(page, order.url, order.name);
    await addReferenceField(page, "customer", customer);
    expect(await publishViaDialog(page)).toBe("1.0");

    // Customer moves on; Order, published against Customer 1.0, did not.
    await openEntityPage(page, customer.url, customer.name);
    await addFieldQuick(page, "segment");
    expect(await publishViaDialog(page)).toBe("1.1");

    await openEntityPage(page, order.url, order.name);
    const stale = main.getByTestId(ID.tab("alerts"));
    await stale.click();
    const card = main.locator('[data-testid="alert-card"][data-alert-id="entity-stale-references"]');
    await expect(card).toContainText(`1 referenced entity has a newer published version: ${customer.name} 1.0 to 1.1`);
    await expect(card).toContainText("Publish this entity again to use the newer versions");

    // Publishing Order again takes the newer version in, and the alert goes.
    await main.getByTestId(ID.tab("editor")).click();
    await addFieldQuick(page, "note");
    expect(await publishViaDialog(page)).toBe("1.1");
    await openEntityPage(page, order.url, order.name);
    await main.getByTestId(ID.tab("alerts")).click();
    await expect(main.locator('[data-testid="alert-card"][data-alert-id="entity-stale-references"]')).toHaveCount(0);
  });
});

test.describe("API, Deployments and TypeSpec", () => {
  test.use({ workspaceEntities: ["Invoice"] });

  test("API: operations are added with a method and a path (path parameters are read from it), survive a reload, and are deleted", { tag: ["@regression"] }, async ({
    authedPage: page,
    workspace,
  }) => {
    const [invoice] = workspace.entities;
    const main = centerPanel(page);
    await openEntityPage(page, invoice.url, invoice.name);
    await main.getByTestId(ID.tab("api")).click();
    const api = main.getByTestId(ID.apiTab);
    await expect(api).toBeVisible();
    await expect(api.getByTestId(ID.apiEmpty)).toContainText("No API operations defined yet");

    // The path suggested for a new operation is the entity's name, lowercased, plural.
    await api.getByTestId(ID.apiAdd).click();
    await expect(api.getByTestId(ID.apiPath)).toHaveValue("/invoices");
    await expect(api.getByTestId(ID.apiCreate)).toBeDisabled();
    await api.getByTestId(ID.apiName).fill("listInvoices");
    await api.getByTestId(ID.apiDescription).fill("List the invoices");
    await api.getByTestId(ID.apiCreate).click();
    const list = api.locator('[data-testid="api-operation"][data-name="listInvoices"]');
    await expect(list).toBeVisible();
    await expect(list).toContainText("GET");
    await expect(list).toContainText("/invoices");
    await expect(list).toContainText("0p · 1r");

    // A path parameter in the path becomes a required path parameter of the operation.
    await api.getByTestId(ID.apiAdd).click();
    await api.getByTestId(ID.apiName).fill("getInvoice");
    await api.getByTestId(ID.apiMethod).selectOption("GET");
    await api.getByTestId(ID.apiPath).fill("/invoices/{invoiceId}");
    await api.getByTestId(ID.apiCreate).click();
    const get = api.locator('[data-testid="api-operation"][data-name="getInvoice"]');
    await expect(get).toContainText("/invoices/{invoiceId}");
    await expect(get).toContainText("1p · 1r");

    await openEntityPage(page, invoice.url, invoice.name);
    await main.getByTestId(ID.tab("api")).click();
    await expect(main.getByTestId(ID.apiOperation)).toHaveCount(2);
    await expect(main.locator('[data-testid="api-operation"][data-name="getInvoice"]')).toContainText("1p · 1r");

    // Delete one: expand it, Delete.
    const toDelete = main.locator('[data-testid="api-operation"][data-name="listInvoices"]');
    await toDelete.getByRole("button").first().click();
    await toDelete.getByRole("button", { name: /^Delete/ }).click();
    await expect(main.getByTestId(ID.apiOperation)).toHaveCount(1);
    await openEntityPage(page, invoice.url, invoice.name);
    await main.getByTestId(ID.tab("api")).click();
    await expect(main.getByTestId(ID.apiOperation)).toHaveCount(1);
    await expect(main.locator('[data-testid="api-operation"][data-name="getInvoice"]')).toBeVisible();
  });

  test("Deployments: an empty state, then a generated target to mark as deployed in an environment and to check for drift", { tag: ["@regression"] }, async ({
    authedPage: page,
    workspace,
  }) => {
    test.setTimeout(180_000);
    const [invoice] = workspace.entities;
    const main = centerPanel(page);
    await openEntityPage(page, invoice.url, invoice.name);

    await main.getByTestId(ID.tab("deployments")).click();
    const deployments = main.getByTestId(ID.deploymentsTab);
    await expect(deployments).toBeVisible();
    await expect(deployments.getByTestId(ID.deploymentEmpty)).toContainText("No emission targets configured");

    // Generate one target: it becomes a row, emitted at its version, tracked in no environment.
    await openSchemasTab(page);
    const generated = await generateTarget(page, "Avro Schema");
    expect(generated.error).toBeUndefined();
    // A schema version is a Draft until it is marked deployed on the Schemas tab.
    const version = main.getByTestId(ID.schemaVersion).first();
    await expect(version).toHaveAttribute("data-status", "draft");
    await main.getByTestId(ID.schemaMarkDeployed).click();
    await expect(successToast(page, /Avro Schema v\d+ marked as deployed/)).toBeVisible();
    await expect(main.getByTestId(ID.schemaDeployedBadge)).toBeVisible();
    await expect(version).toHaveAttribute("data-status", "published");

    await main.getByTestId(ID.tab("deployments")).click();
    const target = deployments.getByTestId(ID.deploymentTarget);
    await expect(target).toHaveCount(1);
    await expect(target).toContainText(/avro/i);
    await expect(target.getByTestId(ID.deploymentUntracked)).toHaveText("Not tracked in any environment");

    // Mark it deployed to staging.
    await target.getByTestId(ID.deploymentMark).click();
    const dialog = page.getByTestId(ID.markDeployedDialog);
    await expect(dialog).toBeVisible();
    await expect(dialog.getByTestId(ID.environmentSelector)).toHaveValue("production");
    await dialog.getByTestId(ID.environmentSelector).selectOption("staging");
    await dialog.getByTestId(ID.confirmDeploy).click();
    await expect(successToast(page, "Marked deployed to staging")).toBeVisible();
    const staging = target.locator('[data-testid="deployment-environment"][data-environment="staging"]');
    await expect(staging).toBeVisible();
    await expect(staging).toContainText("staging");
    await expect(target.getByTestId(ID.deploymentUntracked)).toHaveCount(0);

    // Drift is checked against what was emitted.
    await target.getByTestId(ID.deploymentCheckDrift).click();
    await expect(successToast(page, "Drift check complete")).toBeVisible();

    // Persisted.
    await openEntityPage(page, invoice.url, invoice.name);
    await main.getByTestId(ID.tab("deployments")).click();
    await expect(main.locator('[data-testid="deployment-environment"][data-environment="staging"]')).toBeVisible();
  });

  test("TypeSpec: an edit of the source is compiled and applied (the fields follow); source that does not compile is refused and nothing is saved", { tag: ["@regression"] }, async ({
    authedPage: page,
    workspace,
  }) => {
    test.setTimeout(180_000);
    const [invoice] = workspace.entities;
    await openEntityPage(page, invoice.url, invoice.name);

    const source = await readTypeSpecSource(page);
    expect(source).toContain(`model ${invoice.name}`);
    // Save is disabled until the text changes.
    await expect(page.getByTestId(ID.typespecSave)).toBeDisabled();

    // A new field in the source is a new field of the entity.
    const edited = source.replace(/(\bid\??:\s*string;)/, "$1\n  amount: int32;");
    expect(edited).not.toBe(source);
    const saved = await saveTypeSpecSource(page, edited);
    expect(saved.ok, saved.message).toBe(true);
    expect(saved.message).toMatch(/1 added/);
    // The right panel's preview of the entity follows the saved source.
    await expect(page.getByTestId(ID.typespecPreview)).toContainText("amount");

    await openEditor(page);
    await expect(centerPanel(page).locator('span[title="amount"]')).toBeVisible();
    await expect(centerPanel(page).getByRole("heading", { name: "Fields (2)" })).toBeVisible();

    // Source that does not compile: the error and its diagnostics are shown, and the entity is unchanged.
    await readTypeSpecSource(page);
    const broken = `${await page.getByTestId(ID.typespecTextarea).inputValue()}\nmodel Broken {\n  oops: ;\n`;
    const refused = await saveTypeSpecSource(page, broken);
    expect(refused.ok).toBe(false);
    expect(refused.message.length).toBeGreaterThan(0);
    await expect(page.getByTestId(ID.typespecDiagnostics)).toBeVisible();
    await expect(page.getByTestId(ID.typespecDiagnostics)).toContainText(/\[[\w/-]+\]/);

    await openEntityPage(page, invoice.url, invoice.name);
    await expect(centerPanel(page).getByRole("heading", { name: "Fields (2)" })).toBeVisible();
    const afterReload = await readTypeSpecSource(page);
    expect(afterReload).not.toContain("Broken");
    expect(afterReload).toContain("amount");
  });
});

test.describe("the field studio and the right panel", () => {
  test.use({ workspaceEntities: ["Invoice"] });

  test("field studio: opened from the field, edited with autosave, and what was typed is there after a reload and in the editor", { tag: ["@regression"] }, async ({
    authedPage: page,
    workspace,
  }) => {
    const [invoice] = workspace.entities;
    const main = centerPanel(page);
    await openEntityPage(page, invoice.url, invoice.name);

    await main.locator('[data-testid="field-card"][data-field="id"]').getByTestId(ID.openStudio).click();
    await expect(page).toHaveURL(new RegExp(`${invoice.url}/fields/[^/]+$`));
    await expect(main.getByTestId(ID.studioName)).toHaveValue("id");
    // The input is on the page before React is: typing in that gap changes nothing (no onChange, no autosave).
    await waitForHydration(main.getByTestId(ID.studioName));

    // Autosave: nothing says "Saved" until something is typed; the save is debounced and one request. (The page refreshes after it,
    // so what is waited for is the server's answer, not the indicator that is gone again with the refresh.)
    await expect(main.getByTestId(ID.studioStatus)).toHaveCount(0);
    await afterServerAction(page, () => main.getByTestId(ID.studioName).fill("invoice_id"));
    await expect(main.getByTestId(ID.studioName)).toHaveValue("invoice_id");
    await waitForHydration(main.getByTestId(ID.studioDefault));
    await afterServerAction(page, () => main.getByTestId(ID.studioDefault).fill("INV-0"));
    await expect(errorToast(page)).toHaveCount(0);

    // The address names the field by its id, so a rename (which changes the slug) does not take the page away; a reload shows both.
    await expect(page).toHaveURL(/\/fields\/e2e[0-9a-f]+$/);
    await page.reload();
    await expect(main.getByTestId(ID.studioName)).toHaveValue("invoice_id");
    await expect(main.getByTestId(ID.studioDefault)).toHaveValue("INV-0");

    // "Done" goes back to the entity, whose list has the new name.
    await main.getByTestId(ID.studioDone).click();
    await expect(page).toHaveURL(invoice.url);
    await expect(centerPanel(page).locator('span[title="invoice_id"]')).toBeVisible();
    await expect(centerPanel(page).locator('span[title="id"]')).toHaveCount(0);
  });

  // OPEN PRODUCT BUG (task-5-report.md, "Bugs open" 2): every autosave of the studio is followed by a refresh of the page that REMOUNTS
  // the form: the input a user is typing in is replaced and the focus falls to <body>, so after a pause of half a second the next
  // keystroke goes nowhere. Expected to fail (`test.fail`); when it passes, remove that line.
  test("field studio [open defect: the form is remounted by the refresh after an autosave]: the name field keeps the focus", { tag: ["@regression"] }, async ({
    authedPage: page,
    workspace,
  }) => {
    test.fail(true, "the studio remounts after an autosave and loses the focus (task-5-report.md, Bugs open 2)");
    const [invoice] = workspace.entities;
    const main = centerPanel(page);
    await openEntityPage(page, invoice.url, invoice.name);
    await main.locator('[data-testid="field-card"][data-field="id"]').getByTestId(ID.openStudio).click();
    await waitForHydration(main.getByTestId(ID.studioName));
    // Mark the input that is typed in; the refresh after the save is over when that very node is gone from the page (with the defect
    // it is within a moment of the answer; without it the node stays and this waits out its bound, which is the defect being gone).
    await main.getByTestId(ID.studioName).evaluate((input) => ((input as HTMLElement & { __typedIn?: boolean }).__typedIn = true));
    await afterServerAction(page, () => main.getByTestId(ID.studioName).fill("invoice_id"));
    await page
      .waitForFunction(() => !(document.querySelector('[data-testid="field-studio-name"]') as (HTMLElement & { __typedIn?: boolean }) | null)?.__typedIn, undefined, {
        timeout: 5_000,
      })
      .catch(() => undefined);
    await expect(main.getByTestId(ID.studioName)).toBeFocused();
  });

  test("right panel: the Field Edit tab waits for a field, the TypeSpec tab follows the entity and applies an edit", { tag: ["@regression"] }, async ({
    authedPage: page,
    workspace,
  }) => {
    test.setTimeout(120_000);
    const [invoice] = workspace.entities;
    const main = centerPanel(page);
    await openEntityPage(page, invoice.url, invoice.name);

    // Open by default on the TypeSpec preview of the entity.
    const preview = page.getByTestId(ID.typespecPreview);
    await expect(preview).toBeVisible({ timeout: 30_000 });
    await expect(preview).toContainText(`model ${invoice.name}`);
    await addFieldQuick(page, "amount");
    await expect(preview).toContainText("amount");

    // Field Edit: nothing selected, then a field.
    await page.getByTestId(ID.rightTab("field-edit")).click();
    await expect(page.getByText("Select a field to edit its properties.")).toBeVisible();
    await main.getByLabel("Row 2", { exact: true }).click();
    await expect(page.getByTestId(ID.fieldEditPanel)).toBeVisible();

    // The panel closes and opens again.
    await main.getByTestId(ID.rightToggle).click();
    await expect(page.getByTestId(ID.fieldEditPanel)).toBeHidden();
    await main.getByTestId(ID.rightToggle).click();
    await expect(page.getByTestId(ID.fieldEditPanel)).toBeVisible();

    // The TypeSpec tab edits too: preview the change, then apply it (the page reloads with the new field).
    await page.getByTestId(ID.rightTab("typespec-preview")).click();
    await page.getByTestId(ID.typespecEditToggle).click();
    const editor = page.getByTestId(ID.typespecEditor);
    // The editor opens with the entity's source; it is typed over only once that is in.
    await expect(editor).toHaveValue(/amount/);
    const text = await editor.inputValue();
    await editor.fill(text.replace(/(\bamount\??:\s*[\w.]+;)/, "$1\n  currency: string;"));
    await page.getByTestId(ID.typespecPreviewChanges).click();
    await expect(page.getByTestId(ID.typespecDiff)).toContainText("+ Add 1 field: currency");
    await page.getByTestId(ID.typespecApply).click();
    await expect(centerPanel(page).locator('span[title="currency"]')).toBeVisible({ timeout: 60_000 });
    await expect(centerPanel(page).getByRole("heading", { name: "Fields (3)" })).toBeVisible();
  });

  test("Versions: the Change Log lists what happened to the entity and can be filtered by type", { tag: ["@regression"] }, async ({
    authedPage: page,
    workspace,
  }) => {
    const [invoice] = workspace.entities;
    await openEntityPage(page, invoice.url, invoice.name);
    await addFieldQuick(page, "amount");
    await publishViaDialog(page);

    const tab = await openVersionsTab(page);
    const log = tab.getByTestId(ID.changeHistory);
    await expect(log).toBeVisible();
    // A version was published: the empty state is gone, and the publish is one entry of the log.
    await expect(log.getByTestId(ID.timelineEmpty)).toHaveCount(0);
    await expect(log.getByTestId("change-timeline")).toBeVisible();
    await expect(log.locator('[data-testid^="timeline-audit-"]')).toHaveCount(1);
    // The filter bar is hidden until asked for, and narrows by change type.
    await expect(log.getByTestId("filter-bar")).toHaveCount(0);
    await log.getByRole("button", { name: "Filters" }).click();
    await expect(log.getByTestId("filter-bar")).toBeVisible();
    await log.getByTestId("filter-change-type").selectOption("status_change");
    await expect(log.getByTestId(ID.timelineEmpty)).toBeVisible();
    await log.getByRole("button", { name: "Clear" }).click();
    await expect(log.getByTestId("change-timeline")).toBeVisible();
    await expect(versionState(page)).toHaveText("Published · v1.0");
  });
});

test.describe("what a target needs and what can be overridden", () => {
  test.use({ workspaceEntities: ["Invoice"] });

  test("primary-key dialog: an entity without a key is asked for one, Cancel generates nothing, the answer is saved and not asked again", { tag: ["@regression"] }, async ({
    authedPage: page,
    workspace,
  }) => {
    test.setTimeout(180_000);
    const [invoice] = workspace.entities;
    const main = centerPanel(page);
    // The fixture's `id` is flagged as the key: take the flag off, and add a second candidate.
    await pg().query(`UPDATE fields SET "isKey" = false WHERE "entityId" = $1`, [invoice.id]);
    await openEntityPage(page, invoice.url, invoice.name);
    await addFieldQuick(page, "amount");
    await openSchemasTab(page);

    // BigQuery needs a key: Generate asks.
    await main.getByTestId(ID.schemaTarget("bigquery")).click();
    await main.getByTestId(ID.schemaGenerate).click();
    const dialog = page.getByTestId(ID.primaryKeyDialog);
    await expect(dialog).toBeVisible();
    await expect(dialog).toContainText("This target needs a primary key");
    await expect(dialog).toContainText(`${invoice.name} has no primary key.`);
    const options = dialog.getByTestId(ID.primaryKeyOption);
    await expect(options).toHaveCount(2);
    // `id` is suggested (pre-checked); with nothing checked the answer cannot be saved.
    await expect(dialog.locator('[data-testid="primary-key-option"][data-field="id"]')).toBeChecked();
    await expect(dialog.locator('[data-testid="primary-key-option"][data-field="amount"]')).not.toBeChecked();
    await dialog.locator('[data-testid="primary-key-option"][data-field="id"]').uncheck();
    await expect(dialog.getByTestId(ID.primaryKeyConfirm)).toBeDisabled();

    // Cancel: nothing was generated, nothing failed.
    await dialog.getByTestId(ID.primaryKeyCancel).click();
    await expect(dialog).toBeHidden();
    await expect(errorToast(page)).toHaveCount(0);
    await expect(main.getByText("No schema generated yet")).toBeVisible();

    // Answer with `amount`: it is saved on the entity and the target is generated.
    await main.getByTestId(ID.schemaGenerate).click();
    await expect(dialog).toBeVisible();
    await dialog.locator('[data-testid="primary-key-option"][data-field="id"]').uncheck();
    await dialog.locator('[data-testid="primary-key-option"][data-field="amount"]').check();
    await dialog.getByTestId(ID.primaryKeyConfirm).click();
    await expect(dialog).toBeHidden({ timeout: 60_000 });
    await expect(page.locator('[data-sonner-toast][data-type="success"]').filter({ hasText: /BigQuery DDL schema generated/ })).toBeVisible({ timeout: 60_000 });
    const ddl = await readPreview(page);
    expect(ddl).toMatch(/PRIMARY KEY\s*\(\s*`?amount`?\s*\)/i);

    // The key is the entity's now: another target does not ask, and a reload still has it.
    const postgres = await generateTarget(page, "PostgreSQL DDL");
    expect(postgres.error).toBeUndefined();
    expect(postgres.askedForKey).toBe(false);
    expect(postgres.code).toMatch(/PRIMARY KEY\s*\(\s*"?amount"?\s*\)/i);
    await openEntityPage(page, invoice.url, invoice.name);
    await openSchemasTab(page);
    await main.getByTestId(ID.schemaTarget("spanner")).click();
    await main.getByTestId(ID.schemaGenerate).click();
    await expect(page.getByTestId(ID.primaryKeyDialog)).toHaveCount(0);
    await expect(page.locator('[data-sonner-toast][data-type="success"]').filter({ hasText: /Spanner DDL schema generated/ })).toBeVisible({ timeout: 60_000 });
  });

  test("type override: a target's data type is chosen per field, saved with the entity, marked overridden, kept after a reload, and shown by the Alerts tab and the matrix", { tag: ["@regression"] }, async ({
    authedPage: page,
    workspace,
  }) => {
    test.setTimeout(180_000);
    const [invoice] = workspace.entities;
    const main = centerPanel(page);
    await openEntityPage(page, invoice.url, invoice.name);
    await openSchemasTab(page);
    const generated = await generateTarget(page, "BigQuery DDL");
    expect(generated.error).toBeUndefined();
    expect(generated.code).toMatch(/\bid\b\s+STRING\b(?!\()/);

    await main.getByTestId(ID.schemaContentTab("overrides")).click();
    const row = main.locator('[data-testid="override-row"][data-field="id"]');
    await expect(row).toHaveAttribute("data-overridden", "false");
    await row.getByTestId(ID.overrideTrigger).click();
    await page.getByRole("option", { name: /^STRING\(36\)/ }).click();
    await expect(successToast(page, "Override applied — schema regenerated")).toBeVisible({ timeout: 60_000 });
    await expect(row).toHaveAttribute("data-overridden", "true");
    await expect(row).toContainText("overridden");
    await expect(row.getByTestId(ID.overrideTrigger)).toHaveText("STRING(36)");

    // Kept: after a reload the table and the alert of the Alerts tab still know the override.
    await openEntityPage(page, invoice.url, invoice.name);
    await openSchemasTab(page);
    await main.getByTestId(ID.schemaContentTab("overrides")).click();
    const again = main.locator('[data-testid="override-row"][data-field="id"]');
    await expect(again).toHaveAttribute("data-overridden", "true");
    await expect(again.getByTestId(ID.overrideTrigger)).toHaveText("STRING(36)");
    await main.getByTestId(ID.tab("alerts")).click();
    await expect(main.locator('[data-testid="alert-card"][data-alert-id="target-bigquery-overrides"]')).toContainText("BigQuery DDL uses persisted field overrides");

    // The mapping matrix lists the field against every target.
    await main.getByTestId(ID.tab("schemas")).click();
    await main.getByTestId(ID.schemaContentTab("matrix")).click();
    await expect(main.getByRole("table")).toContainText("id");
  });

  // OPEN PRODUCT BUG (task-5-report.md, "Bugs open" 1): the Manual Override table says "Changes are saved immediately and regenerate this
  // schema", the override is saved and the toast says "schema regenerated", but the DDL the TypeSpec emitter writes is the same as
  // before: nothing in src/lib/typespec-official reads `schemaTargetTypeOverrides`. This test states what the page promises; it is
  // expected to fail (`test.fail`), and when the emitters apply overrides it passes, which Playwright reports as a failure: remove
  // the `test.fail` line then.
  test("type override [open defect: the regenerated BigQuery DDL ignores the override]: the schema carries the chosen type", { tag: ["@regression"] }, async ({
    authedPage: page,
    workspace,
  }) => {
    test.fail(true, "Manual Override is saved but the TypeSpec emitters do not apply it (task-5-report.md, Bugs open 1)");
    test.setTimeout(180_000);
    const [invoice] = workspace.entities;
    const main = centerPanel(page);
    await openEntityPage(page, invoice.url, invoice.name);
    await openSchemasTab(page);
    const generated = await generateTarget(page, "BigQuery DDL");
    expect(generated.error).toBeUndefined();
    await main.getByTestId(ID.schemaContentTab("overrides")).click();
    const row = main.locator('[data-testid="override-row"][data-field="id"]');
    await row.getByTestId(ID.overrideTrigger).click();
    await page.getByRole("option", { name: /^STRING\(36\)/ }).click();
    await expect(successToast(page, "Override applied — schema regenerated")).toBeVisible({ timeout: 60_000 });
    await main.getByTestId(ID.schemaContentTab("schema")).click();
    await expect.poll(() => readPreview(page), { message: "the regenerated BigQuery DDL", timeout: 20_000 }).toMatch(/\bid\b\s+STRING\(36\)/);
  });

  test("staged emit: the dialog offers every target (all checked), counts the selection, and emits only the chosen ones", { tag: ["@regression"] }, async ({
    authedPage: page,
    workspace,
  }) => {
    test.setTimeout(240_000);
    const [invoice] = workspace.entities;
    const main = centerPanel(page);
    await openEntityPage(page, invoice.url, invoice.name);
    await openSchemasTab(page);

    await main.getByTestId(ID.schemaStage).click();
    const dialog = page.getByTestId(ID.stagedDialog);
    await expect(dialog).toBeVisible();
    const targets = dialog.getByTestId(ID.stagedTarget);
    const count = await targets.count();
    expect(count).toBeGreaterThanOrEqual(8);
    await expect(dialog.getByTestId(ID.stagedCount)).toHaveText(`${count} of ${count} targets selected`);
    await expect(dialog.getByTestId(ID.stagedSubmit)).toBeEnabled();

    // Cancel changes nothing.
    await dialog.getByTestId(ID.stagedCancel).click();
    await expect(dialog).toBeHidden();
    await expect(main.getByText("No schema generated yet")).toBeVisible();

    // Choose two: Avro and JSON Schema.
    await main.getByTestId(ID.schemaStage).click();
    await expect(dialog).toBeVisible();
    for (let i = 0; i < count; i += 1) {
      const row = targets.nth(i);
      if ((await row.getAttribute("data-selected")) === "true") await row.click();
    }
    await expect(dialog.getByTestId(ID.stagedCount)).toHaveText(`0 of ${count} targets selected`);
    await expect(dialog.getByTestId(ID.stagedSubmit)).toBeDisabled();
    await dialog.locator('[data-testid="staged-emit-target"][data-target="avro"]').click();
    await dialog.locator('[data-testid="staged-emit-target"][data-target="json-schema"]').click();
    await expect(dialog.getByTestId(ID.stagedCount)).toHaveText(`2 of ${count} targets selected`);
    await dialog.getByTestId(ID.stagedSubmit).click();
    await expect(dialog).toBeHidden();
    await expect(successToast(page, "Generated 2 schemas (Draft)")).toBeVisible({ timeout: 120_000 });

    // Both have a draft version now, the others none.
    await expect(main.getByTestId(ID.schemaTarget("avro"))).toContainText("v1");
    await expect(main.getByTestId(ID.schemaTarget("json-schema"))).toContainText("v1");
    await expect(main.getByTestId(ID.schemaTarget("bigquery"))).not.toContainText("v1");
  });
});

test.describe("an Enterprise entity", () => {
  test("has no API tab (operations belong to a product)", { tag: ["@regression"] }, async ({ authedPage: page }) => {
    const fx = await createNavFixtures();
    try {
      await openEntityPage(page, `/schemas/enterprise/entities/${fx.tenantEntity.slug}`, fx.tenantEntity.name);
      const main = centerPanel(page);
      await expect(main.getByTestId(ID.tab("schemas"))).toBeVisible();
      await expect(main.getByTestId(ID.tab("deployments"))).toBeVisible();
      await expect(main.getByTestId(ID.tab("typespec"))).toBeVisible();
      await expect(main.getByTestId(ID.tab("api"))).toHaveCount(0);
    } finally {
      await deleteNavFixtures(fx);
    }
  });
});
