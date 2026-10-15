// @vitest-environment jsdom
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { PublishEntityDialog, type PublishPreview } from "@/app/(dashboard)/schemas/[domainSlug]/[productSlug]/[entityId]/components/PublishEntityDialog";

afterEach(() => cleanup());

/** What an event publish analysis looks like: no `warnings`, blockers carry their own kinds. */
const eventAnalysis = {
  isFirstPublish: false,
  latestLabel: "1.0",
  suggestedBump: "MAJOR" as const,
  candidateLabels: { MINOR: "1.1", MAJOR: "2.0" },
  initialLabel: "1.0",
  reasons: ["Operation action changed"],
  blockers: [{ kind: "UNPUBLISHED_MESSAGE", message: "Publish OrderCreated first" }],
} satisfies PublishPreview;

function open(preview: PublishPreview | null, description?: string) {
  return render(
    <PublishEntityDialog
      open
      entityName="checkout-events"
      description={description}
      preview={preview}
      loadError={null}
      isPublishing={false}
      publishError={null}
      onOpenChange={vi.fn()}
      onConfirm={vi.fn()}
    />
  );
}

describe("PublishEntityDialog (generalized for events)", () => {
  it("renders the caller's description instead of the entity wording", () => {
    open(eventAnalysis, "Publishing freezes this event spec; consumers pin it by version.");
    expect(screen.getByText("Publishing freezes this event spec; consumers pin it by version.")).toBeDefined();
    expect(screen.queryByText(/messages and other entities can pin/)).toBeNull();
  });

  it("keeps the entity description when none is given", () => {
    open(eventAnalysis);
    expect(screen.getByText(/immutable version that messages and other entities can pin/)).toBeDefined();
  });

  it("renders a warnings-less analysis: blockers, suggested bump, reasons; confirm blocked", () => {
    open(eventAnalysis, "d");
    expect(screen.queryByTestId("publish-warnings")).toBeNull();
    expect(screen.getByText("Publish OrderCreated first")).toBeDefined();
    expect(screen.getByText("Operation action changed")).toBeDefined();
    expect(screen.getByText(/These changes are breaking/)).toBeDefined();
    // MAJOR suggested: a MINOR request would lower the bump, so it is disabled; confirm is blocked by the blocker.
    expect((screen.getByTestId("bump-minor") as HTMLButtonElement).disabled).toBe(true);
    expect((screen.getByTestId("confirm-publish") as HTMLButtonElement).disabled).toBe(true);
  });

  it("still renders entity warnings when the analysis has them", () => {
    open({ ...eventAnalysis, blockers: [], warnings: [{ kind: "UNRESOLVED_REFERENCE", message: "Address no longer resolves" }] }, "d");
    expect(screen.getByTestId("publish-warnings").textContent).toMatch(/Address no longer resolves/);
    expect((screen.getByTestId("confirm-publish") as HTMLButtonElement).disabled).toBe(false);
  });

  it("shows the checking placeholder until the preview arrives", () => {
    open(null, "d");
    expect(screen.getByText(/Checking changes/)).toBeDefined();
  });
});
