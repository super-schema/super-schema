// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { PublishEntityForm } from "@/app/(dashboard)/schemas/[domainSlug]/[productSlug]/[entityId]/components/PublishEntityDialog";
import { EntityVersionList } from "@/app/(dashboard)/schemas/[domainSlug]/[productSlug]/[entityId]/components/EntityVersionList";
import type { PublishAnalysis } from "@/lib/entity-versioning/publish-plan";

afterEach(cleanup);

function analysis(overrides: Partial<PublishAnalysis> = {}): PublishAnalysis {
  return {
    isFirstPublish: false, latestLabel: "2.1", suggestedBump: "MINOR", candidateLabels: { MAJOR: "3.0", MINOR: "2.2" },
    initialLabel: "1.0", reasons: [], diffSummary: { added: 1, removed: 0, modified: 0 }, blockers: [], warnings: [], pins: [],
    ...overrides,
  };
}

const isDisabled = (el: HTMLElement) => el.hasAttribute("disabled") || el.getAttribute("aria-disabled") === "true";

function renderForm(preview: PublishAnalysis, onConfirm = vi.fn()) {
  render(
    <PublishEntityForm entityName="Order" preview={preview} isPublishing={false} publishError={null} onCancel={vi.fn()} onConfirm={onConfirm} />
  );
  return onConfirm;
}

describe("PublishEntityForm", () => {
  it("defaults to the suggested MINOR bump and lets the user raise it to MAJOR", () => {
    const onConfirm = renderForm(analysis());
    expect(screen.getByTestId("confirm-publish").textContent).toContain("Publish v2.2");
    fireEvent.click(screen.getByTestId("bump-major"));
    expect(screen.getByTestId("confirm-publish").textContent).toContain("Publish v3.0");
    fireEvent.click(screen.getByTestId("confirm-publish"));
    expect(onConfirm).toHaveBeenCalledWith({ bump: "MAJOR", changeSummary: undefined });
  });

  it("never offers MINOR when the change is breaking", () => {
    renderForm(analysis({ suggestedBump: "MAJOR", reasons: ['Removed field "email" — consumers depending on this field will break'] }));
    expect(isDisabled(screen.getByTestId("bump-minor"))).toBe(true);
    expect(screen.getByText(/Removed field "email"/)).toBeTruthy();
    expect(screen.getByTestId("confirm-publish").textContent).toContain("Publish v3.0");
  });

  it("first publish shows v1.0 and sends no bump", () => {
    const onConfirm = renderForm(
      analysis({ isFirstPublish: true, latestLabel: null, suggestedBump: null, candidateLabels: null })
    );
    expect(screen.queryByTestId("bump-major")).toBeNull();
    fireEvent.change(screen.getByRole("textbox"), { target: { value: " initial import " } });
    fireEvent.click(screen.getByTestId("confirm-publish"));
    expect(onConfirm).toHaveBeenCalledWith({ bump: undefined, changeSummary: "initial import" });
  });

  it("shows warnings without blocking Publish", () => {
    renderForm(
      analysis({
        warnings: [
          {
            kind: "UNRESOLVED_REFERENCE",
            entityName: "Ghost",
            message: 'Reference "Ghost" does not match any entity in this line; it will not be pinned.',
          },
        ],
      })
    );
    expect(screen.getByTestId("publish-warnings").textContent).toContain('Reference "Ghost"');
    expect(isDisabled(screen.getByTestId("confirm-publish"))).toBe(false);
  });

  it("lists blockers and disables Publish", () => {
    renderForm(
      analysis({
        blockers: [{ kind: "UNPUBLISHED_REFERENCE", entityId: "c1", entityName: "Customer", message: "Publish Customer first" }],
      })
    );
    expect(screen.getByRole("alert").textContent).toContain("Publish Customer first");
    expect(isDisabled(screen.getByTestId("confirm-publish"))).toBe(true);
  });
});

describe("EntityVersionList", () => {
  it("renders rows in the given (newest-first) order", () => {
    render(
      <EntityVersionList
        versions={[
          { id: "v2", entityId: "e", major: 1, minor: 1, label: "1.1", sequence: 2, changeKind: "MINOR", changeSummary: "add email", publishedById: "u", publishedByName: "Ada", publishedAt: "2026-10-14T10:00:00.000Z" },
          { id: "v1", entityId: "e", major: 1, minor: 0, label: "1.0", sequence: 1, changeKind: "INITIAL", changeSummary: null, publishedById: "u", publishedByName: null, publishedAt: "2026-10-13T10:00:00.000Z" },
        ]}
      />
    );
    const rows = screen.getByTestId("entity-version-list").querySelectorAll("li");
    expect(rows).toHaveLength(2);
    expect(rows[0].textContent).toContain("v1.1");
    expect(rows[0].textContent).toContain("add email");
    expect(rows[1].textContent).toContain("v1.0");
  });

  it("shows an empty state", () => {
    render(<EntityVersionList versions={[]} />);
    expect(screen.getByTestId("entity-version-list-empty").textContent).toContain("Not published yet");
  });
});
