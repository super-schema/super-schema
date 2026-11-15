// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { AlertsTab } from "@/app/(dashboard)/schemas/[domainSlug]/[productSlug]/[entityId]/components/AlertsTab";
import type { EntityAlert } from "@/lib/validation/entity-alerts";

afterEach(cleanup);
it.each(["MISSING", "INVALID"])("opens the entity metadata editor for %s attribute alerts", (problem) => {
  const scrollIntoView = vi.fn();
  render(<>
    <section id="entity-metadata" tabIndex={-1} ref={(node) => { if (node) node.scrollIntoView = scrollIntoView; }} />
    <AlertsTab alerts={[{ id: `entity-attr-METADATA_ATTRIBUTE_${problem}-x-owner`, category: "entity", severity: "warning", title: "Metadata issue", description: "Fix it", action: "Fix attribute" }]} onNavigateToField={vi.fn()} onNavigateToTab={vi.fn()} />
  </>);
  fireEvent.click(screen.getByRole("button", { name: "Fix attribute: Metadata issue" }));
  expect(scrollIntoView).toHaveBeenCalled();
  expect(document.activeElement?.id).toBe("entity-metadata");
});
it("opens API operations for operation metadata alerts", () => {
  const navigate = vi.fn();
  const alert: EntityAlert = { id: "operation-attr-METADATA_ATTRIBUTE_MISSING-x-owner-op1", category: "entity", severity: "warning", title: "Operation issue", description: "Fix it", action: "Edit operation" };
  render(<AlertsTab alerts={[alert]} onNavigateToField={vi.fn()} onNavigateToTab={navigate} />);
  fireEvent.click(screen.getByRole("button", { name: "Edit operation: Operation issue" }));
  expect(navigate).toHaveBeenCalledWith("api");
});
