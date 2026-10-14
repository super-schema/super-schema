import { describe, it, expect, vi } from "vitest";
import { normalizeWorkspaceTab } from "@/app/(dashboard)/schemas/[domainSlug]/domain-workspace";

// The workspace module imports server actions (Prisma / next-auth); stub them
// so this pure-helper test does not pull the server graph into the test run.
vi.mock("@/app/(dashboard)/schemas/[domainSlug]/actions", () => ({
  createEntityWithFieldsAction: vi.fn(),
  deleteEntityAction: vi.fn(),
}));

vi.mock("@/app/(dashboard)/schemas/actions", () => ({
  deleteDomainAction: vi.fn(),
}));

vi.mock("@/app/(dashboard)/schemas/[domainSlug]/components/DomainTypesTab", () => ({
  DomainTypesTab: () => null,
}));

vi.mock("@/app/(dashboard)/schemas/[domainSlug]/components/DomainApisTab", () => ({
  DomainApisTab: () => null,
}));

describe("normalizeWorkspaceTab", () => {
  it("maps legacy ?tab=types to data-types", () => {
    expect(normalizeWorkspaceTab("types")).toBe("data-types");
  });
  it("keeps known tabs", () => {
    expect(normalizeWorkspaceTab("apis")).toBe("apis");
    expect(normalizeWorkspaceTab("data-types")).toBe("data-types");
    expect(normalizeWorkspaceTab("entities")).toBe("entities");
  });
  it("falls back to entities", () => {
    expect(normalizeWorkspaceTab(null)).toBe("entities");
    expect(normalizeWorkspaceTab("bogus")).toBe("entities");
  });
});
