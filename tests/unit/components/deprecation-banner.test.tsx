/**
 * @vitest-environment jsdom
 */
import type { ReactNode } from "react";
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { DeprecationBanner } from "@/components/custom/DeprecationBanner";

vi.mock("next/link", () => ({
  default: ({ href, children }: { href: string; children: ReactNode }) => <a href={href}>{children}</a>,
}));

afterEach(() => cleanup());

const metadata = (deprecation: Record<string, unknown>) => ({ deprecation: { deprecated: true, ...deprecation } });

describe("DeprecationBanner replacement", () => {
  it("links a resolved product replacement through assetHref", () => {
    render(
      <DeprecationBanner
        metadata={metadata({ since: "2026-01-01", replacementEntityId: "ent-2" })}
        replacementEntity={{ name: "Order v2", slug: "order-v2", domainSlug: "payments", productSlug: "checkout" }}
      />
    );

    expect(screen.getByRole("link", { name: "Order v2" }).getAttribute("href")).toBe(
      "/schemas/payments/checkout/order-v2"
    );
  });

  it("links a resolved tenant-level replacement (null slugs) to its Enterprise route", () => {
    render(
      <DeprecationBanner
        metadata={metadata({ replacementEntityId: "ent-2" })}
        replacementEntity={{ name: "Customer v2", slug: "customer-v2", domainSlug: null, productSlug: null }}
      />
    );

    expect(screen.getByRole("link", { name: "Customer v2" }).getAttribute("href")).toBe(
      "/schemas/enterprise/entities/customer-v2"
    );
  });

  it("shows an unresolvable replacement as plain text, never a link", () => {
    render(
      <DeprecationBanner
        metadata={metadata({ replacementEntityId: "ent-gone", replacement: "Legacy Order" })}
        replacementEntity={null}
      />
    );

    expect(screen.queryByRole("link")).toBeNull();
    expect(screen.getByText("Legacy Order")).toBeTruthy();
  });

  it("falls back to the replacement id as the plain text when no name is known", () => {
    render(<DeprecationBanner metadata={metadata({ replacementEntityId: "ent-gone" })} />);

    expect(screen.queryByRole("link")).toBeNull();
    expect(screen.getByText("ent-gone")).toBeTruthy();
  });

  it("renders no replacement when none is named", () => {
    render(<DeprecationBanner metadata={metadata({ since: "2026-01-01" })} />);

    expect(screen.queryByText(/Replacement/)).toBeNull();
    expect(screen.queryByRole("link")).toBeNull();
  });
});
