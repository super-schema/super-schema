import React from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";

const { mockEntityFindMany, mockGetActiveTenantId } = vi.hoisted(() => ({
  mockEntityFindMany: vi.fn(),
  mockGetActiveTenantId: vi.fn(),
}));

vi.mock("@/lib/db", () => ({ prisma: { entity: { findMany: mockEntityFindMany } } }));
vi.mock("@/lib/active-tenant", () => ({ getActiveTenantId: mockGetActiveTenantId }));
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
    mockGetActiveTenantId.mockResolvedValue("tenant_default");
    mockEntityFindMany.mockResolvedValue([]);
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
