import type { Page } from "@playwright/test";
import { test, expect, unique } from "./helpers/fixtures";
import { centerPanel } from "./helpers/event-builder";

test.use({
  workspaceEntities: [unique("WorkspaceUX")],
  viewport: { width: 1280, height: 900 },
});

async function addAndSelectField(page: Page, entityUrl: string) {
  await page.goto(entityUrl);
  await expect(centerPanel(page).getByRole("heading", { name: "Fields (1)", exact: true })).toBeVisible();
  await expect(centerPanel(page).locator('span[title="id"]')).toBeVisible();
  await centerPanel(page).getByLabel("Row 1", { exact: true }).click();
  await expect(page.getByTestId("field-edit-panel")).toBeVisible();
}

async function editDescription(page: Page, description: string) {
  const panel = page.getByTestId("field-edit-panel");
  await panel.getByRole("button", { name: "Add description...", exact: true }).click();
  await panel.getByRole("textbox", { name: "Field description", exact: true }).fill(description);
  await page.keyboard.press("Enter");
  await expect(page.getByTestId("workspace-draft-status")).toContainText("Unsaved field edits");
}

async function navigationState(page: Page) {
  return page.evaluate(() => {
    type Entry = { key: string; index: number; url: string | null };
    const navigation = (window as unknown as {
      navigation?: { currentEntry: Entry | null; entries(): Entry[] };
    }).navigation;
    if (!navigation?.currentEntry) throw new Error("This regression requires the Chrome Navigation API");
    const entry = ({ key, index, url }: Entry) => ({ key, index, url });
    return { current: entry(navigation.currentEntry), entries: navigation.entries().map(entry) };
  });
}

async function expectEditorUrl(page: Page) {
  await expect(page).toHaveURL((url) => url.searchParams.get("tab") === "editor" && url.searchParams.get("keep") === "1");
}

test.describe("Entity workspace UX", () => {
  for (const decision of ["save", "discard"] as const) {
    test(`Stay preserves browser history, then ${decision} traverses the original entry`, { tag: ["@regression"] }, async ({ authedPage: page, workspace, browserName }) => {
      test.skip(browserName !== "chromium", "Requires Chrome's cancelable Navigation API traversal");
      await addAndSelectField(page, workspace.entities[0].url);
      await page.getByTestId("tab-schemas").click();
      await expect(page.getByTestId("tab-schemas")).toHaveAttribute("aria-selected", "true");
      // Tab clicks replace the current entry. Construct a second same-document entry so actual Back/Forward is exercised.
      await page.evaluate(() => {
        const schemas = new URL(window.location.href);
        schemas.searchParams.set("keep", "1");
        window.history.replaceState(null, "", schemas);
        const editor = new URL(schemas);
        editor.searchParams.set("tab", "editor");
        window.history.pushState(null, "", editor);
      });
      await expect(page.getByTestId("tab-editor")).toHaveAttribute("aria-selected", "true");
      await centerPanel(page).getByLabel("Row 1", { exact: true }).click();
      const description = `History ${decision} description`;
      await editDescription(page, description);
      const before = await navigationState(page);
      const destination = before.entries.find((entry) => entry.index === before.current.index - 1);
      expect(destination?.url).toContain("tab=schemas");

      await page.evaluate(() => window.history.back());
      const guard = page.getByTestId("unsaved-changes-dialog");
      await expect(guard).toBeVisible();
      await expectEditorUrl(page);
      await guard.getByRole("button", { name: "Stay", exact: true }).click();
      await expect(guard).toBeHidden();
      await expectEditorUrl(page);
      expect(await navigationState(page)).toEqual(before);
      await expect(page.getByTestId("field-edit-panel").getByText(description, { exact: true })).toBeVisible();

      await page.evaluate(() => window.history.back());
      await expect(guard).toBeVisible();
      await guard.getByRole("button", {
        name: decision === "save" ? "Save and continue" : "Discard and continue",
        exact: true,
      }).click();
      await expect(guard).toBeHidden();
      await expect(page.getByTestId("tab-schemas")).toHaveAttribute("aria-selected", "true");
      await expect(page).toHaveURL((url) => url.searchParams.get("tab") === "schemas" && url.searchParams.get("keep") === "1");
      expect((await navigationState(page)).current.key).toBe(destination?.key);

      await page.evaluate(() => window.history.forward());
      await expect(page.getByTestId("tab-editor")).toHaveAttribute("aria-selected", "true");
      await expectEditorUrl(page);
      await centerPanel(page).getByLabel("Row 1", { exact: true }).click();
      const panel = page.getByTestId("field-edit-panel");
      if (decision === "save") {
        await expect(panel.getByText(description, { exact: true })).toBeVisible();
        // A document refresh independently verifies that continuation waited for the server write.
        await page.reload();
        await centerPanel(page).getByLabel("Row 1", { exact: true }).click();
        await expect(page.getByTestId("field-edit-panel").getByText(description, { exact: true })).toBeVisible();
      } else {
        await expect(panel.getByText(description, { exact: true })).toHaveCount(0);
        await expect(panel.getByRole("button", { name: "Add description...", exact: true })).toBeVisible();
      }
    });
  }

  test("dirty Publish and right-panel Preview require an explicit decision", { tag: ["@regression"] }, async ({ authedPage: page, workspace }, testInfo) => {
    await addAndSelectField(page, workspace.entities[0].url);
    await editDescription(page, "Keep this local description");
    await page.screenshot({ path: testInfo.outputPath("workspace-1280.png"), fullPage: true });
    await page.getByRole("button", { name: "Publish", exact: true }).first().click();
    const guard = page.getByTestId("unsaved-changes-dialog");
    await expect(guard).toBeVisible();
    await expect(page.getByTestId("publish-dialog")).toBeHidden();
    await guard.getByRole("button", { name: "Stay", exact: true }).click();
    await expect(guard).toBeHidden();
    await expect(page.getByTestId("field-edit-panel").getByText("Keep this local description", { exact: true })).toBeVisible();

    await page.getByRole("button", { name: "Preview", exact: true }).click();
    await expect(guard).toBeVisible();
    await expect(page.getByTestId("field-edit-panel")).toBeVisible();
    await guard.getByRole("button", { name: "Stay", exact: true }).click();
    await expect(guard).toBeHidden();
    await page.getByRole("button", { name: "Preview", exact: true }).click();
    await expect(guard).toBeVisible();
    await guard.getByRole("button", { name: "Discard and continue", exact: true }).click();
    await expect(guard).toBeHidden();
    await expect(page.getByTestId("field-edit-panel")).toBeHidden();
    await expect(page.getByTestId("workspace-draft-status")).not.toContainText("Unsaved field edits");
  });

  test("all workspace views remain keyboard reachable at 900px", { tag: ["@regression"] }, async ({ authedPage: page, workspace }, testInfo) => {
    await page.setViewportSize({ width: 900, height: 900 });
    await page.goto(workspace.entities[0].url);
    const tabs = page.getByRole("tablist", { name: "Entity workspace views" });
    await tabs.getByRole("tab", { name: "Editor", exact: true }).focus();
    for (const name of ["TypeSpec source", "Schemas", "API", "Deployments", "Governance", "Alerts", "Versions", "Editor"]) {
      await page.keyboard.press("ArrowRight");
      const tab = tabs.getByRole("tab", { name: name === "Alerts" ? /^Alerts(?: \(\d+\))?$/ : name, exact: true });
      await expect(tab).toBeFocused();
      // Base UI tabs use manual activation: arrows move focus, Enter selects the view.
      await tab.press("Enter");
      await expect(tab).toHaveAttribute("aria-selected", "true");
      await expect(tab).toBeInViewport();
    }
    await expect(page.getByTestId("publish-entity-button")).toBeInViewport();
    await expect(page.getByTitle("Delete entity", { exact: true })).toBeInViewport();
    await centerPanel(page).getByLabel("Row 1", { exact: true }).click();
    await expect(page.getByTestId("field-edit-panel")).toBeVisible();
    await page.screenshot({ path: testInfo.outputPath("workspace-900.png"), fullPage: true });
  });
});
