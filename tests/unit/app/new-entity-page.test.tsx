import React from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";

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
}));

vi.mock("@/services/ai.service", () => ({
  isAiConfigured: vi.fn(() => false),
}));

vi.mock("next/navigation", () => ({
  notFound: vi.fn(() => {
    throw new Error("not found");
  }),
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
    domainId,
    productId,
    productSlug,
  }: {
    domainId: string;
    productId: string;
    productSlug: string;
  }) =>
    React.createElement("div", {
      "data-domain-id": domainId,
      "data-product-id": productId,
      "data-product-slug": productSlug,
    }),
}));

import NewEntityPage from "@/app/(dashboard)/schemas/[domainSlug]/[productSlug]/new/page";

describe("NewEntityPage", () => {
  beforeEach(() => {
    vi.clearAllMocks();
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
});
