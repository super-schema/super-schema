/**
 * @vitest-environment jsdom
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { DomainWorkspace } from "@/app/(dashboard)/schemas/[domainSlug]/domain-workspace";

const { pushMock, refreshMock, deleteEntityMock, deleteDomainMock } = vi.hoisted(() => ({
  pushMock: vi.fn(),
  refreshMock: vi.fn(),
  deleteEntityMock: vi.fn().mockResolvedValue({ success: true }),
  deleteDomainMock: vi.fn().mockResolvedValue({ success: true }),
}));

vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: pushMock, refresh: refreshMock }),
  useSearchParams: () => ({ get: () => null }),
}));

vi.mock("@/app/(dashboard)/schemas/[domainSlug]/actions", () => ({
  createEntityWithFieldsAction: vi.fn(),
  deleteEntityAction: deleteEntityMock,
}));

vi.mock("@/app/(dashboard)/schemas/actions", () => ({
  deleteDomainAction: deleteDomainMock,
}));

vi.mock("@/components/custom/EntityCard", () => ({
  EntityCard: ({ name, onDelete }: { name: string; onDelete?: (id: string, name: string) => void }) => (
    <div data-testid={`entity-card-${name}`}>
      <span>{name}</span>
      {onDelete && <button onClick={() => onDelete("ent-1", name)}>Delete entity {name}</button>}
    </div>
  ),
}));

vi.mock("@/app/(dashboard)/schemas/[domainSlug]/components/DomainTypesTab", () => ({
  DomainTypesTab: () => null,
}));

vi.mock("@/app/(dashboard)/schemas/[domainSlug]/components/DomainApisTab", () => ({
  DomainApisTab: () => null,
}));

vi.mock("@/components/custom/TypePicker", () => ({
  TypePicker: () => <select />,
}));

vi.mock("@/components/custom/ClassificationPicker", () => ({
  ClassificationPicker: () => null,
}));

vi.mock("sonner", () => ({
  toast: { success: vi.fn(), error: vi.fn() },
}));

afterEach(() => {
  cleanup();
  localStorage.clear();
});

const BASE_PROPS = {
  domainId: "dom-1",
  domainName: "Orders",
  domainSlug: "orders",
  domainDescription: "Order domain",
  domainPolicy: null,
  entities: [],
  models: [],
  sharedEnums: [],
  customScalars: [],
  unionTypes: [],
  decoratorDefinitions: [],
  services: [],
};

describe("DomainWorkspace — domain delete button", () => {
  it("shows Delete button for non-system domain", () => {
    render(<DomainWorkspace {...BASE_PROPS} isSystemDomain={false} />);
    expect(screen.getByTitle("Delete domain")).toBeDefined();
  });

  it("hides Delete button for system domain", () => {
    render(<DomainWorkspace {...BASE_PROPS} isSystemDomain={true} />);
    expect(screen.queryByTitle("Delete domain")).toBeNull();
  });

  it("clicking Delete opens confirm dialog with domain name", () => {
    render(<DomainWorkspace {...BASE_PROPS} isSystemDomain={false} />);
    fireEvent.click(screen.getByTitle("Delete domain"));
    const dialog = screen.getByRole("dialog");
    expect(dialog).toBeDefined();
    expect(dialog.textContent).toContain("Orders");
  });

  it("Cancel closes dialog without calling action", () => {
    render(<DomainWorkspace {...BASE_PROPS} isSystemDomain={false} />);
    fireEvent.click(screen.getByTitle("Delete domain"));
    fireEvent.click(screen.getByRole("button", { name: /Cancel/i }));
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(deleteDomainMock).not.toHaveBeenCalled();
  });

  it("Escape closes dialog without calling action", () => {
    render(<DomainWorkspace {...BASE_PROPS} isSystemDomain={false} />);
    fireEvent.click(screen.getByTitle("Delete domain"));
    fireEvent.keyDown(document, { key: "Escape" });
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(deleteDomainMock).not.toHaveBeenCalled();
  });

  it("domain with entities disables the Delete Domain confirm button", () => {
    render(<DomainWorkspace {...BASE_PROPS} isSystemDomain={false} entities={[{
      id: "ent-1", name: "Order", slug: "order", description: "", status: "DRAFT",
      version: 1, fieldCount: 0, updatedAt: new Date(),
      classifications: { NEVER_STORED: 0, PII: 0, SENSITIVE: 0, INTERNAL: 0, PUBLIC: 0 },
    }]} />);
    fireEvent.click(screen.getByTitle("Delete domain"));
    const confirmBtn = screen.getByRole("button", { name: /Delete Domain/i });
    expect((confirmBtn as HTMLButtonElement).disabled).toBe(true);
  });
});

describe("DomainWorkspace — entity list-view delete", () => {
  it("list-view rows have a delete button per entity", () => {
    localStorage.setItem("super-schema:view-mode", "list");
    render(<DomainWorkspace {...BASE_PROPS} entities={[{
      id: "ent-1", name: "Order", slug: "order", description: "", status: "DRAFT",
      version: 1, fieldCount: 2, updatedAt: new Date("2026-01-01"),
      classifications: { NEVER_STORED: 0, PII: 0, SENSITIVE: 0, INTERNAL: 0, PUBLIC: 0 },
    }]} />);
    expect(screen.getByRole("table")).toBeDefined();
    expect(screen.getByRole("button", { name: /Delete entity Order/i })).toBeDefined();
  });
});
