/**
 * @vitest-environment jsdom
 */

import type { ReactNode } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { EntityCard } from "@/components/custom/EntityCard";

afterEach(() => {
  cleanup();
});

vi.mock("next/link", () => ({
  default: ({ href, children, ...props }: { href: string; children: ReactNode }) => (
    <a href={href} {...props}>{children}</a>
  ),
}));

describe("EntityCard navigation", () => {
  const defaultProps = {
    id: "entity-1",
    name: "Customer",
    slug: "customer",
    description: "Customer entity",
    status: "DRAFT" as const,
    version: 1,
    fieldCount: 3,
    domainName: "Customer Data",
    domainSlug: "customer-data",
    productSlug: "default",
    updatedAt: new Date("2026-01-01T00:00:00.000Z"),
  };

  it("keeps the delete action outside the entity link", () => {
    const onDelete = vi.fn();

    render(<EntityCard {...defaultProps} onDelete={onDelete} />);

    expect(screen.getByRole("link", { name: /Customer/i }).getAttribute("href")).toBe(
      "/schemas/customer-data/default/customer"
    );

    const deleteButton = screen.getByRole("button", { name: /Delete entity Customer/i });
    expect(deleteButton.closest("a")).toBeNull();

    fireEvent.click(deleteButton);
    expect(onDelete).toHaveBeenCalledWith("entity-1", "Customer");
  });

  it("delete button className does not include opacity-0 or group-hover:opacity-100", () => {
    const onDelete = vi.fn();
    render(<EntityCard {...defaultProps} onDelete={onDelete} />);
    const deleteButton = screen.getByRole("button", { name: /Delete entity Customer/i });
    expect(deleteButton.className).not.toContain("opacity-0");
    expect(deleteButton.className).not.toContain("group-hover:opacity-100");
  });
});
