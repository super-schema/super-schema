// @vitest-environment jsdom
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { levelCrumbs, productCrumbs } from "@/features/events/crumbs";
import { EventBreadcrumb } from "@/features/events/shared/EventBreadcrumb";
import type { LevelRoute, ProductRoute } from "@/features/events/route-scope";
import { assetHref } from "@/lib/navigation/asset-href";

afterEach(() => cleanup());

const domain = { id: "d1", name: "Payments", slug: "payments" };
const product = { id: "p1", name: "Checkout Service", slug: "checkout" };
const productRoute: ProductRoute = { tenantId: "t1", tenantSlug: "acme", domain, product };
const section = { label: "Channels", href: assetHref({ kind: "product", domainSlug: "payments", productSlug: "checkout" }, { query: { section: "channels" } }) };

describe("event breadcrumb builders", () => {
  it("productCrumbs: Domains > Domain > Product > section > current, every link through assetHref", () => {
    const crumbs = productCrumbs(productRoute, section, "orders.v1");
    expect(crumbs.map((c) => c.label)).toEqual(["Domains", "Payments", "Checkout Service", "Channels", "orders.v1"]);
    expect(crumbs[0].href).toBe("/schemas");
    expect(crumbs[1].href).toBe(assetHref({ kind: "domain", domainSlug: "payments" }));
    expect(crumbs[2].href).toBe(assetHref({ kind: "product", domainSlug: "payments", productSlug: "checkout" }));
    expect(crumbs[3]).toBe(section);
    // The current page is the only crumb without a link.
    expect(crumbs[4]).toEqual({ label: "orders.v1" });
  });

  it("levelCrumbs at product level delegates to the product chain", () => {
    const route: LevelRoute = {
      scope: { tenantId: "t1", domainId: "d1", productId: "p1" }, target: { level: "PRODUCT", productId: "p1" },
      tenantSlug: "acme", domain, product,
    };
    expect(levelCrumbs(route, section, "Retry")).toEqual(productCrumbs(productRoute, section, "Retry"));
  });

  it("levelCrumbs at domain level: Domains > Domain > section > current", () => {
    const route: LevelRoute = {
      scope: { tenantId: "t1", domainId: "d1", productId: null }, target: { level: "DOMAIN", domainId: "d1" },
      tenantSlug: "acme", domain, product: null,
    };
    const crumbs = levelCrumbs(route, { label: "Traits", href: "/x" }, "Retry");
    expect(crumbs).toEqual([
      { label: "Domains", href: "/schemas" },
      { label: "Payments", href: assetHref({ kind: "domain", domainSlug: "payments" }) },
      { label: "Traits", href: "/x" },
      { label: "Retry" },
    ]);
  });

  it("levelCrumbs at enterprise level: Enterprise > section > current", () => {
    const route: LevelRoute = {
      scope: { tenantId: "t1", domainId: null, productId: null }, target: { level: "TENANT", tenantId: "t1" },
      tenantSlug: "acme", domain: null, product: null,
    };
    expect(levelCrumbs(route, { label: "Traits", href: "/t" }, "CloudEvents")).toEqual([
      { label: "Enterprise", href: assetHref({ kind: "enterprise" }) },
      { label: "Traits", href: "/t" },
      { label: "CloudEvents" },
    ]);
  });
});

describe("EventBreadcrumb", () => {
  it("renders a labelled nav: links for crumbs with an href, plain text for the current page, hidden separators", () => {
    const crumbs = productCrumbs(productRoute, section, "orders.v1");
    const { container } = render(<EventBreadcrumb crumbs={crumbs} />);
    const nav = screen.getByRole("navigation", { name: "Breadcrumb" });
    const links = [...nav.querySelectorAll("a")];
    expect(links.map((a) => a.textContent)).toEqual(["Domains", "Payments", "Checkout Service", "Channels"]);
    expect(links.map((a) => a.getAttribute("href"))).toEqual(crumbs.slice(0, 4).map((c) => c.href));
    const current = screen.getByText("orders.v1");
    expect(current.tagName).toBe("SPAN");
    expect(current.closest("a")).toBeNull();
    // One separator between each pair, none before the first crumb, all hidden from assistive tech.
    const separators = container.querySelectorAll('svg[aria-hidden="true"]');
    expect(separators).toHaveLength(crumbs.length - 1);
  });

  it("tolerates repeated labels (keys include the index)", () => {
    render(<EventBreadcrumb crumbs={[{ label: "Same", href: "/a" }, { label: "Same" }]} />);
    expect(screen.getAllByText("Same")).toHaveLength(2);
  });
});
