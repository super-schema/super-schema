/**
 * Publishing an entity, the Versions tab, and the entity's life cycle (deprecate, retire), through the real UI on the release run's
 * throwaway PostgreSQL database.
 *
 * Publishing writes an immutable PUBLISH_VERSION audit row that no cleanup can delete; on a throwaway database that does not matter, so
 * these specs publish for real (the fixtures of helpers/entity-versions.ts, which write versions straight into the tables, exist for the
 * specs that run against a developer's database). The workspace (a domain, a product, the entities named by `workspaceEntities`) is
 * made in the database by the `workspace` fixture and removed afterwards with everything the test made under it: the UI flows that
 * CREATE entities are the specs of the creation wizard, this one is about what happens to an entity afterwards.
 *
 * What the app offers (each line is a test):
 *   - the first publish is v1.0: the header goes from "Never published" to "Published · v1.0", the Versions tab lists it as INITIAL
 *     (this one is `@smoke`), and a reload shows the same;
 *   - a later publish offers Minor (v1.1) and Major (v2.0) with their next labels, raise-only: a breaking change leaves only Major.
 *     The change summary and the bump are recorded; the Versions tab lists the newest first, each with its change kind (INITIAL,
 *     MINOR, MAJOR: what the UI shows of how compatible a version is with the one before);
 *   - what stops a publish is listed in the dialog and the Publish button stays disabled: nothing changed since the last version, a
 *     field that references an entity that was never published;
 *   - the life cycle is DRAFT, ACTIVE, DEPRECATED, RETIRED, one step at a time (a skipped step is refused with the allowed one named);
 *     deprecating asks for the details and shows a banner, retiring shows a banner and makes the entity read-only (no Publish, no
 *     Add Field, the status menu disabled).
 *
 * Not here: publishing across an ambiguous reference (the `needsReference` pick), which belongs to the multi-entity reference spec.
 */
import { test, expect, unique } from "./helpers/fixtures";
import { centerPanel } from "./helpers/event-builder";
import {
  addFieldQuick,
  addReferenceField,
  deleteField,
  openEntityPage,
  openPublishDialog,
  openVersionsTab,
  publishedLabels,
  publishViaDialog,
  successToast,
  versionState,
} from "./helpers/entity-page";

/** Test ids of the entity page's header, the publish dialog and the Versions tab (src/app/(dashboard)/schemas/.../[entityId]). */
const ID = {
  statusTrigger: "entity-status-trigger",
  statusOption: (status: "draft" | "active" | "deprecated" | "retired") => `entity-status-option-${status}`,
  statusError: "entity-status-error",
  publishButton: "publish-entity-button",
  confirmPublish: "confirm-publish",
  cancelPublish: "publish-cancel",
  blockers: "publish-blockers",
  blocker: "publish-blocker",
  bump: (kind: "minor" | "major") => `bump-${kind}`,
  latest: "publish-latest",
  first: "publish-first",
  reasons: "publish-reasons",
  breakingNote: "publish-breaking-note",
  versionItem: "entity-version-item",
  versionChangeKind: "entity-version-change-kind",
  versionSummary: "entity-version-summary",
  versionsEmpty: "entity-version-list-empty",
  deprecationForm: "deprecation-form",
  deprecationNotes: "deprecation-notes",
  deprecationReplacement: "deprecation-replacement",
  deprecationSubmit: "deprecation-submit",
  deprecationBanner: "deprecation-banner",
  retirementBanner: "retirement-banner",
  addFieldButton: "field-add-button",
} as const;

test.describe("publishing an entity", () => {
  test.use({ workspaceEntities: ["Invoice"] });

  test("the first publish is v1.0: the header, the Versions tab and a reload all say so", { tag: ["@smoke", "@regression"] }, async ({
    authedPage: page,
    workspace,
  }) => {
    const [invoice] = workspace.entities;
    await openEntityPage(page, invoice.url, invoice.name);
    await expect(versionState(page)).toHaveText("Never published");

    const dialog = await openPublishDialog(page);
    await expect(dialog.getByTestId(ID.first)).toContainText("v1.0");
    await expect(dialog.getByTestId(ID.blockers)).toHaveCount(0);
    // A first publish has no bump to choose: it is always 1.0.
    await expect(dialog.getByTestId(ID.bump("minor"))).toHaveCount(0);
    await expect(dialog.getByTestId(ID.confirmPublish)).toHaveText(/Publish v1\.0/);
    await dialog.getByTestId(ID.cancelPublish).click();
    await expect(dialog).toBeHidden();
    await expect(versionState(page)).toHaveText("Never published");

    expect(await publishViaDialog(page)).toBe("1.0");
    await expect(successToast(page, `Published ${invoice.name} v1.0`)).toBeVisible();

    const tab = await openVersionsTab(page);
    expect(await publishedLabels(tab)).toEqual(["1.0"]);
    await expect(tab.getByTestId(ID.versionChangeKind)).toHaveText("INITIAL");

    // Persisted, not just on this page's state.
    await openEntityPage(page, invoice.url, invoice.name);
    await expect(versionState(page)).toHaveText("Published · v1.0");
    expect(await publishedLabels(await openVersionsTab(page))).toEqual(["1.0"]);
  });

  test("a later publish offers Minor v1.1 and Major v2.0; a raised bump, the summary and the order (newest first) are recorded", { tag: ["@regression"] }, async ({
    authedPage: page,
    workspace,
  }) => {
    const [invoice] = workspace.entities;
    await openEntityPage(page, invoice.url, invoice.name);
    await publishViaDialog(page);

    // An added field is not breaking: Minor is suggested, and Major can still be chosen (the bump may be raised).
    await addFieldQuick(page, "amount");
    await expect(versionState(page)).toHaveText("Draft · unpublished changes · latest v1.0");

    const dialog = await openPublishDialog(page);
    await expect(dialog.getByTestId(ID.latest)).toContainText("Latest published: v1.0");
    await expect(dialog.getByTestId(ID.latest)).toContainText("suggested bump: MINOR");
    const minor = dialog.getByTestId(ID.bump("minor"));
    const major = dialog.getByTestId(ID.bump("major"));
    await expect(minor).toHaveText("Minor · v1.1");
    await expect(major).toHaveText("Major · v2.0");
    await expect(minor).toHaveAttribute("aria-checked", "true");
    await expect(major).toBeEnabled();
    await expect(dialog.getByTestId(ID.confirmPublish)).toHaveText(/Publish v1\.1/);
    await expect(dialog.getByTestId(ID.breakingNote)).toHaveCount(0);
    // What changed since v1.0, as the dialog tells it (the diff of the two versions).
    await expect(dialog.getByTestId(ID.reasons)).toHaveText('Added optional (nullable) field "amount" — safe addition');

    await major.click();
    await expect(major).toHaveAttribute("aria-checked", "true");
    await expect(dialog.getByTestId(ID.confirmPublish)).toHaveText(/Publish v2\.0/);
    await minor.click();
    await expect(dialog.getByTestId(ID.confirmPublish)).toHaveText(/Publish v1\.1/);
    await dialog.getByTestId(ID.cancelPublish).click();
    await expect(dialog).toBeHidden();

    // Publish it as a raised Major, with a summary.
    const summary = "Added the amount";
    expect(await publishViaDialog(page, { bump: "major", summary })).toBe("2.0");

    const tab = await openVersionsTab(page);
    expect(await publishedLabels(tab)).toEqual(["2.0", "1.0"]);
    const newest = tab.getByTestId(ID.versionItem).first();
    await expect(newest.getByTestId(ID.versionChangeKind)).toHaveText("MAJOR");
    await expect(newest.getByTestId(ID.versionSummary)).toHaveText(summary);
    const oldest = tab.getByTestId(ID.versionItem).last();
    await expect(oldest.getByTestId(ID.versionChangeKind)).toHaveText("INITIAL");
    await expect(oldest.getByTestId(ID.versionSummary)).toHaveCount(0);

    // A third publish after a small change is a Minor of the line the Major started: v2.1, listed first.
    await centerPanel(page).getByTestId("tab-editor").click();
    await addFieldQuick(page, "currency");
    expect(await publishViaDialog(page, { bump: "minor" })).toBe("2.1");
    expect(await publishedLabels(await openVersionsTab(page))).toEqual(["2.1", "2.0", "1.0"]);

    await openEntityPage(page, invoice.url, invoice.name);
    await expect(versionState(page)).toHaveText("Published · v2.1");
    const reloaded = await openVersionsTab(page);
    expect(await publishedLabels(reloaded)).toEqual(["2.1", "2.0", "1.0"]);
    await expect(reloaded.getByTestId(ID.versionChangeKind)).toHaveText(["MINOR", "MAJOR", "INITIAL"]);
    await expect(reloaded.getByTestId(ID.versionSummary)).toHaveText([summary]);
  });

  test("a breaking change (a removed field) can only be published as a Major: Minor is disabled and the reasons are listed", { tag: ["@regression"] }, async ({
    authedPage: page,
    workspace,
  }) => {
    const [invoice] = workspace.entities;
    await openEntityPage(page, invoice.url, invoice.name);
    await addFieldQuick(page, "memo");
    await publishViaDialog(page);

    await deleteField(page, "memo");
    await expect(versionState(page)).toHaveText("Draft · unpublished changes · latest v1.0");

    const dialog = await openPublishDialog(page);
    await expect(dialog.getByTestId(ID.latest)).toContainText("suggested bump: MAJOR");
    await expect(dialog.getByTestId(ID.bump("minor"))).toBeDisabled();
    await expect(dialog.getByTestId(ID.bump("major"))).toHaveAttribute("aria-checked", "true");
    await expect(dialog.getByTestId(ID.breakingNote)).toContainText("can only be published as a major version");
    await expect(dialog.getByTestId(ID.reasons)).toBeVisible();
    await expect(dialog.getByTestId(ID.reasons)).toContainText(/memo/i);
    await expect(dialog.getByTestId(ID.confirmPublish)).toHaveText(/Publish v2\.0/);
    await dialog.getByTestId(ID.confirmPublish).click();
    await expect(dialog).toBeHidden({ timeout: 60_000 });

    await expect(versionState(page)).toHaveText("Published · v2.0");
    const tab = await openVersionsTab(page);
    expect(await publishedLabels(tab)).toEqual(["2.0", "1.0"]);
    await expect(tab.getByTestId(ID.versionChangeKind).first()).toHaveText("MAJOR");
  });

  test("blocker: nothing changed since the last version is listed and the Publish button stays disabled", { tag: ["@regression"] }, async ({
    authedPage: page,
    workspace,
  }) => {
    const [invoice] = workspace.entities;
    await openEntityPage(page, invoice.url, invoice.name);
    await publishViaDialog(page);

    const dialog = await openPublishDialog(page);
    const blockers = dialog.getByTestId(ID.blockers);
    await expect(blockers).toContainText("Cannot publish yet");
    await expect(blockers.getByTestId(ID.blocker)).toHaveCount(1);
    await expect(blockers.getByTestId(ID.blocker)).toHaveAttribute("data-kind", "NO_CHANGES");
    await expect(blockers.getByTestId(ID.blocker)).toHaveText("No unpublished changes since v1.0.");
    await expect(dialog.getByTestId(ID.confirmPublish)).toBeDisabled();
    await dialog.getByTestId(ID.cancelPublish).click();

    // The refusal is not a version: still one, and the header unchanged.
    await expect(versionState(page)).toHaveText("Published · v1.0");
    expect(await publishedLabels(await openVersionsTab(page))).toEqual(["1.0"]);
  });

  test("a never-published entity shows 'Not published yet' on the Versions tab", { tag: ["@regression"] }, async ({ authedPage: page, workspace }) => {
    const [invoice] = workspace.entities;
    await openEntityPage(page, invoice.url, invoice.name);
    const tab = await openVersionsTab(page);
    await expect(tab.getByTestId(ID.versionsEmpty)).toHaveText("Not published yet. Publish to cut version 1.0.");
    await expect(tab.getByTestId(ID.versionItem)).toHaveCount(0);
    // The tab has its own Publish button, which opens the same dialog.
    await tab.getByTestId("versions-publish-button").click();
    await expect(page.getByTestId("publish-dialog").getByTestId(ID.first)).toBeVisible();
  });
});

// Unique names: the reference prompt lists every entity of the tenant, and another test's `Customer` must not be a candidate here.
const CUSTOMER = unique("Customer");
const ORDER = unique("Order");

test.describe("publishing an entity that references another", () => {
  test.use({ workspaceEntities: [CUSTOMER, ORDER] });

  test("blocker: a field that references an entity never published (Publish Customer first); publishing it lifts the blocker", { tag: ["@regression"] }, async ({
    authedPage: page,
    workspace,
  }) => {
    const [customer, order] = workspace.entities;

    // Order gets a reference field to Customer, through the type picker's reference prompt.
    await openEntityPage(page, order.url, order.name);
    await addReferenceField(page, "customer", customer);

    const dialog = await openPublishDialog(page);
    const blocker = dialog.getByTestId(ID.blockers).getByTestId(ID.blocker);
    await expect(blocker.first()).toContainText(`Publish ${customer.name} first`);
    await expect(blocker.first()).toHaveAttribute("data-kind", "UNPUBLISHED_REFERENCE");
    await expect(dialog.getByTestId(ID.confirmPublish)).toBeDisabled();
    await dialog.getByTestId(ID.cancelPublish).click();
    await expect(versionState(page)).toHaveText("Never published");

    // Publish the referenced entity, then Order is publishable.
    await openEntityPage(page, customer.url, customer.name);
    expect(await publishViaDialog(page)).toBe("1.0");

    await openEntityPage(page, order.url, order.name);
    const again = await openPublishDialog(page);
    await expect(again.getByTestId(ID.blockers)).toHaveCount(0);
    await expect(again.getByTestId(ID.confirmPublish)).toBeEnabled();
    await again.getByTestId(ID.cancelPublish).click();
    expect(await publishViaDialog(page)).toBe("1.0");
    expect(await publishedLabels(await openVersionsTab(page))).toEqual(["1.0"]);
  });

  test("the life cycle: DRAFT to ACTIVE to DEPRECATED (a banner, the replacement linked) to RETIRED (a banner, read-only); a skipped step is refused", { tag: ["@regression"] }, async ({
    authedPage: page,
    workspace,
  }) => {
    const [customer, order] = workspace.entities;
    const main = centerPanel(page);
    const trigger = main.getByTestId(ID.statusTrigger);

    await openEntityPage(page, order.url, order.name);
    await expect(trigger).toHaveText("DRAFT");

    // A step cannot be skipped: the refusal names where the entity can go.
    await trigger.click();
    await main.getByTestId(ID.statusOption("retired")).click();
    await expect(main.getByTestId(ID.statusError)).toHaveText("Cannot transition from DRAFT to RETIRED. Allowed transitions: ACTIVE");
    await expect(trigger).toHaveText("DRAFT");

    await trigger.click();
    await main.getByTestId(ID.statusOption("active")).click();
    await expect(trigger).toHaveText("ACTIVE");
    await expect(main.getByTestId(ID.statusError)).toHaveCount(0);

    // Deprecating asks for the details first; nothing changes until they are submitted.
    await trigger.click();
    await main.getByTestId(ID.statusOption("deprecated")).click();
    const form = main.getByTestId(ID.deprecationForm);
    await expect(form).toBeVisible();
    await expect(trigger).toHaveText("ACTIVE");
    await form.getByTestId("deprecation-since").fill("2026-01-31");
    await form.getByTestId(ID.deprecationReplacement).fill(customer.id);
    await form.getByTestId(ID.deprecationNotes).fill("Move to Customer before March");
    await form.getByTestId(ID.deprecationSubmit).click();

    const banner = main.getByTestId(ID.deprecationBanner);
    await expect(banner).toBeVisible();
    await expect(banner).toContainText("This entity is deprecated since 2026-01-31.");
    await expect(banner).toContainText("Move to Customer before March");
    await expect(banner.getByRole("link", { name: customer.name })).toHaveAttribute("href", customer.url);
    await expect(trigger).toHaveText("DEPRECATED");
    await expect(form).toHaveCount(0);

    // A deprecated entity is still editable and publishable.
    await expect(main.getByTestId(ID.publishButton)).toBeVisible();
    await expect(main.getByTestId(ID.addFieldButton)).toBeVisible();

    // Persisted: the banner and the status are what a fresh load shows.
    await openEntityPage(page, order.url, order.name);
    await expect(main.getByTestId(ID.statusTrigger)).toHaveText("DEPRECATED");
    await expect(main.getByTestId(ID.deprecationBanner)).toContainText("deprecated since 2026-01-31");

    // Retiring is the last step: a banner, and the entity is read-only.
    await main.getByTestId(ID.statusTrigger).click();
    await main.getByTestId(ID.statusOption("retired")).click();
    await expect(main.getByTestId(ID.retirementBanner)).toContainText("This entity is retired since");
    await expect(main.getByTestId(ID.retirementBanner)).toContainText("It is read-only.");
    await expect(main.getByTestId(ID.statusTrigger)).toHaveText("RETIRED");
    await expect(main.getByTestId(ID.statusTrigger)).toBeDisabled();
    await expect(main.getByTestId(ID.publishButton)).toHaveCount(0);
    await expect(main.getByTestId(ID.addFieldButton)).toHaveCount(0);
    await expect(main.getByTestId(ID.deprecationBanner)).toHaveCount(0);

    await openEntityPage(page, order.url, order.name);
    await expect(main.getByTestId(ID.retirementBanner)).toBeVisible();
    await expect(main.getByTestId(ID.statusTrigger)).toBeDisabled();
    await expect(main.getByTestId(ID.publishButton)).toHaveCount(0);
  });
});
