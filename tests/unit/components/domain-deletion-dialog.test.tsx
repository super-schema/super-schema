/**
 * @vitest-environment jsdom
 */
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { DomainDeletionDialog } from "@/components/custom/DomainDeletionDialog";
import type { DomainDeletionImpact } from "@/types/domain-deletion";

const EMPTY: DomainDeletionImpact = {
  entities: 0,
  products: 0,
  productLevelAssets: 0,
  modelDefinitions: 0,
  decoratorDefinitions: 0,
  sharedEnums: 0,
  customScalars: 0,
  unionTypes: 0,
  services: 0,
  interfaces: 0,
  userRoles: 0,
  traits: 0,
  eventSpecs: 0,
};

function renderDialog(impact: DomainDeletionImpact, onConfirm = vi.fn()) {
  render(
    <DomainDeletionDialog open domainName="Orders" impact={impact} isDeleting={false} onOpenChange={vi.fn()} onConfirm={onConfirm} />
  );
  return { onConfirm, confirm: () => screen.getByRole("button", { name: "Delete Domain" }) as HTMLButtonElement };
}

describe("DomainDeletionDialog blockers", () => {
  afterEach(() => cleanup());

  it("keeps the entity-only wording and blocks the confirm button", () => {
    const { confirm, onConfirm } = renderDialog({ ...EMPTY, entities: 2 });
    expect(screen.getByText("Delete or move all entities first.")).toBeDefined();
    expect(screen.getByText("This domain currently contains 2 entities.")).toBeDefined();
    expect(confirm().disabled).toBe(true);
    fireEvent.click(confirm());
    expect(onConfirm).not.toHaveBeenCalled();
  });

  it.each([
    [{ traits: 1 }, "1 trait"],
    [{ eventSpecs: 1 }, "1 event"],
    [{ eventSpecs: 3 }, "3 events"],
  ])("blocks on Events assets alone: %j", (counts, listed) => {
    const { confirm, onConfirm } = renderDialog({ ...EMPTY, ...counts });
    expect(screen.getByText("Delete or move all Events assets first.")).toBeDefined();
    expect(screen.getByText(`This domain currently contains ${listed}.`)).toBeDefined();
    expect(confirm().disabled).toBe(true);
    fireEvent.click(confirm());
    expect(onConfirm).not.toHaveBeenCalled();
  });

  it("names entities and Events assets together when both block", () => {
    const { confirm } = renderDialog({ ...EMPTY, entities: 1, traits: 1, eventSpecs: 2 });
    expect(screen.getByText("Delete or move all entities and Events assets first.")).toBeDefined();
    expect(screen.getByText("This domain currently contains 1 entity, 1 trait and 2 events.")).toBeDefined();
    expect(confirm().disabled).toBe(true);
  });

  it("lets an admin confirm when only cascading assets exist", () => {
    const { confirm, onConfirm } = renderDialog({ ...EMPTY, products: 2, productLevelAssets: 1, sharedEnums: 1 });
    expect(screen.queryByText(/Delete or move all/)).toBeNull();
    expect(confirm().disabled).toBe(false);
    fireEvent.click(confirm());
    expect(onConfirm).toHaveBeenCalledTimes(1);
  });
});
