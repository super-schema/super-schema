/**
 * The right panel of the entity page pushes the selected-field panel into the layout through a context: the entities a reference can
 * point at must reach that panel through the router.
 *
 * @vitest-environment jsdom
 */
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import type { ReactNode } from "react";
import { RightPanelRouter } from "@/app/(dashboard)/schemas/[domainSlug]/[productSlug]/[entityId]/components/RightPanelRouter";

const pushed = vi.hoisted(() => ({ content: null as unknown }));
vi.mock("@/hooks/useRightPanelContent", () => ({
  useRightPanelContent: () => ({
    setContent: (content: unknown) => {
      pushed.content = content;
    },
  }),
}));
vi.mock("@/components/custom/TypeSpecPreview", () => ({ TypeSpecPreview: () => null }));

const FIELD = {
  id: "f1", name: "shipTo", type: "string", precision: null, scale: null, nullable: true, isKey: false, fieldNumber: null,
  description: "", classification: null, aliases: [], decorators: {}, sortOrder: 0,
};

beforeAll(() => {
  globalThis.ResizeObserver ??= class {
    observe() {}
    unobserve() {}
    disconnect() {}
  };
  Element.prototype.scrollIntoView ??= () => {};
});
afterEach(cleanup);

function mountRouter(referenceTargets: Array<{ id: string; name: string; domain?: string; product?: string }> | undefined) {
  render(
    <RightPanelRouter
      selectedField={FIELD}
      entityId="ent-1"
      domainSlug="payments"
      isReadOnly={false}
      rightPanelTab="field-edit"
      onTabChange={() => {}}
      onUpdateField={async () => {}}
      typeSpecTrigger={0}
      referenceTargets={referenceTargets}
    />,
  );
  render(<>{pushed.content as ReactNode}</>);
}

describe("RightPanelRouter", () => {
  it("hands the entities a reference can point at to the selected-field panel (its type picker asks for the target)", () => {
    mountRouter([{ id: "e-addr", name: "Address", domain: "Billing", product: "Core" }]);

    fireEvent.click(screen.getAllByRole("button", { name: /^string$/i })[0]);
    fireEvent.click(screen.getByText("reference"));

    expect(screen.getByPlaceholderText("Search or type entity name...")).toBeDefined();
  });

  it("without them the panel's type picker is the plain one", () => {
    mountRouter(undefined);

    fireEvent.click(screen.getAllByRole("button", { name: /^string$/i })[0]);
    fireEvent.click(screen.getByText("reference"));

    expect(screen.queryByPlaceholderText("Search or type entity name...")).toBeNull();
  });
});
