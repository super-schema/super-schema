// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import "@testing-library/jest-dom/vitest";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AlertsTab } from "@/app/(dashboard)/schemas/[domainSlug]/[productSlug]/[entityId]/components/AlertsTab";
import { PublishEntityDialog } from "@/app/(dashboard)/schemas/[domainSlug]/[productSlug]/[entityId]/components/PublishEntityDialog";
import { UsedByPanel } from "@/features/events/shared/UsedByPanel";
import type { EntityAlert } from "@/lib/validation/entity-alerts";
const mocks = vi.hoisted(() => ({ usages: vi.fn() }));
vi.mock("@/app/(dashboard)/schemas/usage-actions", () => ({ listUsagesAction: mocks.usages }));
const preview = { isFirstPublish: false, latestLabel: "1.0", suggestedBump: "MAJOR" as const, candidateLabels: { MINOR: "1.1", MAJOR: "2.0" }, initialLabel: "1.0", reasons: ["Required field email was removed"], blockers: [] };
beforeEach(() => { vi.clearAllMocks(); mocks.usages.mockResolvedValue({ success: true, data: { rows: [], truncated: false } }); });
afterEach(cleanup);

describe("workspace feedback and correction actions", () => {
  it("retries a failed consumer lookup instead of claiming there are no consumers", async () => {
    mocks.usages.mockRejectedValueOnce(new Error("offline"));
    render(<UsedByPanel subject={{ kind: "entity", entityId: "customer" }} />);
    expect(await screen.findByRole("alert")).toHaveTextContent("Could not load usages");
    expect(screen.queryByText("Nothing references this yet.")).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Retry references" }));
    expect(await screen.findByText("Nothing references this yet.")).toBeVisible();
    expect(mocks.usages).toHaveBeenCalledTimes(2);
    expect(mocks.usages).toHaveBeenLastCalledWith({ kind: "entity", entityId: "customer" });
  });

  it("shows publication consequences, compatibility reasons and existing consumers before confirmation", async () => {
    render(<PublishEntityDialog open entityName="Customer" preview={preview} loadError={null} isPublishing={false} publishError={null} onOpenChange={vi.fn()} onConfirm={vi.fn()} consumerPreview={<UsedByPanel subject={{ kind: "entity", entityId: "customer" }} title="Consumers to review" />} />);
    expect(screen.getByTestId("publish-impact")).toHaveTextContent("Creates v2.0");
    expect(screen.getByText("Required field email was removed")).toBeVisible();
    expect(screen.getByText(/Pinned versions stay fixed/)).toBeVisible();
    expect(await screen.findByText("Nothing references this yet.")).toBeVisible();
    expect(mocks.usages).toHaveBeenCalledWith({ kind: "entity", entityId: "customer" });
  });

  it("offers retry when the publish preview cannot load", () => {
    const retry = vi.fn();
    render(<PublishEntityDialog open entityName="Customer" preview={null} loadError="Preview unavailable" isPublishing={false} publishError={null} onOpenChange={vi.fn()} onConfirm={vi.fn()} onRetry={retry} />);
    fireEvent.click(screen.getByRole("button", { name: "Retry publish preview" }));
    expect(retry).toHaveBeenCalledTimes(1);
    expect(screen.queryByTestId("confirm-publish")).not.toBeInTheDocument();
  });

  it("routes stale-reference correction to the editor", () => {
    const navigate = vi.fn();
    const alerts: EntityAlert[] = [{ id: "entity-stale-references", severity: "warning", category: "entity", title: "Address has a newer version", description: "Review the recorded version.", action: "Review references" }];
    render(<AlertsTab alerts={alerts} onNavigateToField={vi.fn()} onNavigateToTab={navigate} />);
    fireEvent.click(screen.getByRole("button", { name: /Review references:/ }));
    expect(navigate).toHaveBeenCalledWith("editor");
    expect(screen.getByText(/Existing published versions stay unchanged/)).toBeVisible();
  });

  it("identifies the field or target beside its correction action", () => {
    const field = vi.fn(), navigate = vi.fn();
    const alerts: EntityAlert[] = [
      { id: "field-desc-email", severity: "warning", category: "field", fieldId: "email-id", fieldName: "email", title: "Missing description", description: "Document this field.", action: "Edit field" },
      { id: "target-avro-stale", severity: "error", category: "target", targetKey: "avro", title: "Avro overrides are stale", description: "The logical type changed.", action: "Review target" },
    ];
    render(<AlertsTab alerts={alerts} onNavigateToField={field} onNavigateToTab={navigate} />);
    fireEvent.click(screen.getByRole("button", { name: "Edit field: email" }));
    expect(field).toHaveBeenCalledWith("email-id");
    expect(screen.getByText("Field: email")).toBeVisible();
    fireEvent.click(screen.getByRole("button", { name: "Review target: avro" }));
    expect(navigate).toHaveBeenCalledWith("schemas");
    expect(screen.getByText("Target: avro")).toBeVisible();
    expect(screen.getByText(/Review persisted overrides before regenerating/)).toBeVisible();
  });

  it("does not expose an inert field correction when no destination exists", async () => {
    render(<AlertsTab alerts={[{ id: "field-unknown", severity: "warning", category: "field", title: "Missing field", description: "No field id.", action: "Edit field" }]} onNavigateToField={vi.fn()} onNavigateToTab={vi.fn()} />);
    await waitFor(() => expect(screen.getByRole("button", { name: /Edit field:/ })).toBeDisabled());
  });
});
