/**
 * @vitest-environment jsdom
 */

import type { ReactNode } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";

afterEach(() => {
  cleanup();
});
import { EntityCard } from "@/components/custom/EntityCard";

vi.mock("next/link", () => ({
  default: ({ href, children, ...props }: { href: string; children: ReactNode }) => (
    <a href={href} {...props}>{children}</a>
  ),
}));

describe("EntityCard navigation", () => {
  it("keeps the delete action outside the entity link", () => {
    const onDelete = vi.fn();

    render(
      <EntityCard
        id="entity-1"
        name="Customer"
        slug="customer"
        description="Customer entity"
        status="DRAFT"
        version={1}
        fieldCount={3}
        domainName="Customer Data"
        domainSlug="customer-data"
        updatedAt={new Date("2026-01-01T00:00:00.000Z")}
        onDelete={onDelete}
      />
    );

    expect(screen.getByRole("link", { name: /Customer/i }).getAttribute("href")).toBe(
      "/schemas/customer-data/customer"
    );

    const deleteButton = screen.getByRole("button", { name: /Delete entity Customer/i });
    expect(deleteButton.closest("a")).toBeNull();

    fireEvent.click(deleteButton);
    expect(onDelete).toHaveBeenCalledWith("entity-1", "Customer");
  });

  it("delete button is not hidden by opacity (always visible)", () => {
    const onDelete = vi.fn();
    render(
      <EntityCard
        id="entity-1"
        name="Customer"
        slug="customer"
        description="Customer entity"
        status="DRAFT"
        version={1}
        fieldCount={3}
        domainName="Customer Data"
        domainSlug="customer-data"
        updatedAt={new Date("2026-01-01T00:00:00.000Z")}
        onDelete={onDelete}
      />
    );
    const deleteButton = screen.getByRole("button", { name: /Delete entity Customer/i });
    expect(deleteButton.className).not.toContain("opacity-0");
  });
});
