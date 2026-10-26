import React from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { assign, globalAdmin, principalOf, signInAs } from "../../helpers/access-mocks";

const { mockEntityFindMany, mockGetActiveTenantId } = vi.hoisted(() => ({
  mockEntityFindMany: vi.fn(),
  mockGetActiveTenantId: vi.fn(),
}));

vi.mock("@/lib/db", () => ({ prisma: { entity: { findMany: mockEntityFindMany } } }));
vi.mock("@/lib/active-tenant", () => ({ getActiveTenantId: mockGetActiveTenantId, requireActiveTenantId: mockGetActiveTenantId, NO_ACCESS_PATH: "/no-access" }));
vi.mock("@/lib/auth", () => ({ auth: vi.fn() }));
vi.mock("@/lib/access/principal", async () => (await import("../../helpers/access-mocks")).principalModule);
vi.mock("next/navigation", () => ({
  notFound: () => {
    throw new Error("not found");
  },
  redirect: (url: string) => {
    throw new Error(`NEXT_REDIRECT ${url}`);
  },
}));
vi.mock("next/link", () => ({
  default: ({ href, children, className }: { href: string; children: React.ReactNode; className?: string }) =>
    React.createElement("a", { href, className }, children),
}));
vi.mock("@/components/custom/EntityCreationWizard", () => ({
  EntityCreationWizard: () => React.createElement("div"),
}));

import NewEnterpriseEntityPage from "@/app/(dashboard)/schemas/enterprise/new/page";

function findByType(node: React.ReactNode, type: string): React.ReactElement<Record<string, unknown>> | null {
  if (!React.isValidElement(node)) return null;
  const element = node as React.ReactElement<{ children?: React.ReactNode } & Record<string, unknown>>;
  if (element.type === type) return element;
  for (const child of React.Children.toArray(element.props.children)) {
    const found = findByType(child, type);
    if (found) return found;
  }
  return null;
}

function findWithHref(node: React.ReactNode): React.ReactElement<Record<string, unknown>> | null {
  if (!React.isValidElement(node)) return null;
  const element = node as React.ReactElement<{ children?: React.ReactNode } & Record<string, unknown>>;
  if (typeof element.props.href === "string") return element;
  for (const child of React.Children.toArray(element.props.children)) {
    const found = findWithHref(child);
    if (found) return found;
  }
  return null;
}

describe("NewEnterpriseEntityPage", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    signInAs(globalAdmin());
    mockGetActiveTenantId.mockResolvedValue("tenant_default");
    mockEntityFindMany.mockResolvedValue([]);
  });

  // Creating a tenant-level entity needs `entity.write` over the tenant as a whole.
  it("is for an author of the tenant or above; a viewer, an author of one domain and a user with no role get a 404 and nothing is read", async () => {
    signInAs(principalOf([assign.tenant("AUTHOR", "tenant_default")]));
    await expect(NewEnterpriseEntityPage()).resolves.toBeTruthy();
    for (const assignments of [[assign.tenant("VIEWER", "tenant_default")], [assign.domain("AUTHOR", "tenant_default", "d1")], []]) {
      signInAs(principalOf(assignments));
      mockEntityFindMany.mockClear();
      await expect(NewEnterpriseEntityPage(), JSON.stringify(assignments)).rejects.toThrow("not found");
      expect(mockEntityFindMany).not.toHaveBeenCalled();
    }
  });

  it("labels its breadcrumb landmark and links back to Enterprise", async () => {
    const page = await NewEnterpriseEntityPage();
    const nav = findByType(page, "nav");
    expect(nav?.props["aria-label"]).toBe("Breadcrumb");
    // `Link` is a component in the element tree (the mock only applies at render time): find it by its href prop.
    const link = findWithHref(nav);
    expect(link?.props.href).toBe("/schemas/enterprise");
  });
});
