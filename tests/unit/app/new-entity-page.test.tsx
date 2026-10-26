import React from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { assign, globalAdmin, principalOf, signInAs } from "../../helpers/access-mocks";

const { mockDomainFindFirst, mockProductFindFirst, mockEntityFindMany, mockGetActiveTenantId } =
  vi.hoisted(() => ({
    mockDomainFindFirst: vi.fn(),
    mockProductFindFirst: vi.fn(),
    mockEntityFindMany: vi.fn(),
    mockGetActiveTenantId: vi.fn(),
  }));

vi.mock("@/lib/db", () => ({
  prisma: {
    domain: {
      findFirst: mockDomainFindFirst,
    },
    product: {
      findFirst: mockProductFindFirst,
    },
    entity: {
      findMany: mockEntityFindMany,
    },
  },
}));

vi.mock("@/lib/active-tenant", () => ({
  getActiveTenantId: mockGetActiveTenantId,
  requireActiveTenantId: mockGetActiveTenantId,
  NO_ACCESS_PATH: "/no-access",
}));
vi.mock("@/lib/auth", () => ({ auth: vi.fn() }));
vi.mock("@/lib/access/principal", async () => (await import("../../helpers/access-mocks")).principalModule);

vi.mock("@/services/ai.service", () => ({
  isAiConfigured: vi.fn(() => false),
}));

vi.mock("next/navigation", () => ({
  notFound: vi.fn(() => {
    throw new Error("not found");
  }),
  redirect: (url: string) => {
    throw new Error(`NEXT_REDIRECT ${url}`);
  },
}));

vi.mock("next/link", () => ({
  default: ({
    href,
    children,
    className,
  }: {
    href: string;
    children: React.ReactNode;
    className?: string;
  }) => React.createElement("a", { href, className }, children),
}));

vi.mock("@/components/custom/EntityCreationWizard", () => ({
  EntityCreationWizard: ({
    target,
  }: {
    target: { domainId: string; productId: string; productSlug: string };
  }) =>
    React.createElement("div", {
      "data-domain-id": target.domainId,
      "data-product-id": target.productId,
      "data-product-slug": target.productSlug,
    }),
}));

import NewEntityPage from "@/app/(dashboard)/schemas/[domainSlug]/[productSlug]/new/page";

describe("NewEntityPage", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    signInAs(globalAdmin());
    mockGetActiveTenantId.mockResolvedValue("tenant_default");
    mockDomainFindFirst.mockResolvedValue({
      id: "domain-1",
      name: "cascade-test-1782425718902",
      slug: "cascade-test-1782425718902",
    });
    mockProductFindFirst.mockResolvedValue({
      id: "product-1",
      name: "Default",
      slug: "default",
    });
    mockEntityFindMany.mockResolvedValue([]);
  });

  it("loads the domain scoped to the active tenant by route slug", async () => {
    await NewEntityPage({
      params: Promise.resolve({
        domainSlug: "cascade-test-1782425718902",
        productSlug: "default",
      }),
    });

    expect(mockDomainFindFirst).toHaveBeenCalledWith({
      where: { slug: "cascade-test-1782425718902", tenantId: "tenant_default" },
    });
  });

  it("resolves the product by slug within the domain", async () => {
    await NewEntityPage({
      params: Promise.resolve({
        domainSlug: "cascade-test-1782425718902",
        productSlug: "default",
      }),
    });

    expect(mockProductFindFirst).toHaveBeenCalledWith({
      where: { slug: "default", domainId: "domain-1" },
    });
  });

  it("hands the wizard a PRODUCT target carrying the domain and product placement", async () => {
    const page = await NewEntityPage({
      params: Promise.resolve({
        domainSlug: "cascade-test-1782425718902",
        productSlug: "default",
      }),
    });

    const wizard = findElement(page, "EntityCreationWizard");
    expect(wizard?.props.target).toEqual({
      level: "PRODUCT",
      productId: "product-1",
      domainId: "domain-1",
      domainName: "cascade-test-1782425718902",
      domainSlug: "cascade-test-1782425718902",
      productSlug: "default",
    });
  });

  const params = Promise.resolve({ domainSlug: "cascade-test-1782425718902", productSlug: "default" });

  it("is for an author over the product (its own, its domain's, the tenant's) or above; a viewer, an author elsewhere and a user with no role get a 404, and no entity name is read", async () => {
    for (const assignments of [
      [assign.tenant("AUTHOR", "tenant_default")],
      [assign.domain("AUTHOR", "tenant_default", "domain-1")],
      [assign.product("AUTHOR", "tenant_default", "domain-1", "product-1")],
    ]) {
      signInAs(principalOf(assignments));
      await expect(NewEntityPage({ params }), JSON.stringify(assignments)).resolves.toBeTruthy();
    }
    for (const assignments of [
      [assign.tenant("VIEWER", "tenant_default")],
      [assign.domain("AUTHOR", "tenant_default", "domain-2")],
      [assign.product("AUTHOR", "tenant_default", "domain-1", "product-2")],
      [assign.tenant("ADMIN", "another-tenant")],
      [],
    ]) {
      signInAs(principalOf(assignments));
      mockEntityFindMany.mockClear();
      await expect(NewEntityPage({ params }), JSON.stringify(assignments)).rejects.toThrow("not found");
      expect(mockEntityFindMany).not.toHaveBeenCalled();
    }
  });

  it("offers as reference targets only the entities of the domain that the caller may read (the restriction is in the query)", async () => {
    signInAs(principalOf([assign.domain("AUTHOR", "tenant_default", "domain-1")]));
    await NewEntityPage({ params });
    expect(mockEntityFindMany.mock.calls[0][0].where).toEqual({
      domainId: "domain-1",
      tenantId: "tenant_default",
      OR: [{ domainId: { in: ["domain-1"] } }, { productId: { in: [] } }],
    });
  });

  it("labels its breadcrumb landmark so it is distinguishable from the other navigation regions", async () => {
    const page = await NewEntityPage({
      params: Promise.resolve({ domainSlug: "cascade-test-1782425718902", productSlug: "default" }),
    });
    expect(findByType(page, "nav")?.props["aria-label"]).toBe("Breadcrumb");
  });
});

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

function findElement(
  node: React.ReactNode,
  name: string
): React.ReactElement<{ target: unknown }> | null {
  if (!React.isValidElement(node)) return null;
  const element = node as React.ReactElement<{ target: unknown; children?: React.ReactNode }>;
  if (typeof element.type === "function" && element.type.name === name) return element;
  for (const child of React.Children.toArray(element.props.children)) {
    const found = findElement(child, name);
    if (found) return found;
  }
  return null;
}
