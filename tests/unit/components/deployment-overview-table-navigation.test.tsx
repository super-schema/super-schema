/**
 * @vitest-environment jsdom
 */
import type { ReactNode } from "react";
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { DeploymentOverviewTable } from "@/components/custom/DeploymentOverview/DeploymentOverviewTable";

vi.mock("next/link", () => ({
  default: ({ href, children }: { href: string; children: ReactNode }) => (
    <a href={href}>{children}</a>
  ),
}));

afterEach(() => {
  cleanup();
});

describe("DeploymentOverviewTable navigation", () => {
  it("uses the entity route when route slugs are available", () => {
    render(
      <DeploymentOverviewTable
        targetFormats={["typescript"]}
        rows={[
          {
            entityId: "entity-1",
            entityName: "Customer",
            entitySlug: "customer",
            domain: "CRM",
            domainSlug: "crm",
            productSlug: "accounts",
            currentVersion: "v1",
            targets: [],
          },
        ]}
      />
    );

    expect(screen.getByRole("link", { name: "Customer" }).getAttribute("href")).toBe(
      "/schemas/crm/accounts/customer"
    );
  });

  it("links a tenant-level entity (null slugs) to its Enterprise route", () => {
    render(
      <DeploymentOverviewTable
        targetFormats={["typescript"]}
        rows={[
          {
            entityId: "entity-1",
            entityName: "Customer",
            entitySlug: "customer",
            domain: "Enterprise",
            domainSlug: null,
            productSlug: null,
            currentVersion: "v1",
            targets: [],
          },
        ]}
      />
    );

    expect(screen.getByRole("link", { name: "Customer" }).getAttribute("href")).toBe(
      "/schemas/enterprise/entities/customer"
    );
  });

  it("falls back to schemas index instead of generating an underscore route", () => {
    render(
      <DeploymentOverviewTable
        targetFormats={["typescript"]}
        rows={[
          {
            entityId: "entity-1",
            entityName: "Customer",
            domain: "CRM",
            currentVersion: "v1",
            targets: [],
          },
        ]}
      />
    );

    expect(screen.getByRole("link", { name: "Customer" }).getAttribute("href")).toBe(
      "/schemas?entityId=entity-1"
    );
  });
});
