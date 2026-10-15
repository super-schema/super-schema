// @vitest-environment jsdom
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => ({ push: vi.fn(), createTraitAction: vi.fn() }));
vi.mock("next/navigation", () => ({ useRouter: () => ({ push: h.push }) }));
vi.mock("@/app/(dashboard)/schemas/trait-actions", () => ({ createTraitAction: h.createTraitAction }));
import { TraitsTab } from "@/features/events/workspace/TraitsTab";

beforeEach(() => vi.clearAllMocks());
afterEach(() => cleanup());
const trait = (id: string, name: string, href: string) => ({ id, name, kind: "MESSAGE" as const, summary: "", updatedAt: "", href });

describe("TraitsTab", () => {
  it("lists own traits and read-only inherited groups", () => {
    render(
      <QueryClientProvider client={new QueryClient()}>
        <TraitsTab
          target={{ level: "DOMAIN", domainId: "d1" }} domainSlug="payments" productSlug={null}
          data={{ own: [trait("t1", "Retry", "/schemas/payments/traits/t1")], inherited: [{ label: "From Enterprise", href: "/schemas/enterprise?tab=traits", traits: [trait("t2", "CloudEvents", "/schemas/enterprise/traits/t2")] }] }}
        />
      </QueryClientProvider>
    );
    expect(screen.getByRole("link", { name: /Retry/ }).getAttribute("href")).toBe("/schemas/payments/traits/t1");
    expect(screen.getByRole("link", { name: "From Enterprise" }).getAttribute("href")).toBe("/schemas/enterprise?tab=traits");
    expect(screen.getByRole("link", { name: /CloudEvents/ }).getAttribute("href")).toBe("/schemas/enterprise/traits/t2");
  });

  it("shows an empty state, and kind badges per trait", () => {
    render(
      <QueryClientProvider client={new QueryClient()}>
        <TraitsTab target={{ level: "TENANT", tenantId: "tenant-1" }} domainSlug={null} productSlug={null} data={{ own: [], inherited: [] }} />
      </QueryClientProvider>
    );
    expect(screen.getByTestId("traits-empty")).toBeDefined();
    cleanup();

    render(
      <QueryClientProvider client={new QueryClient()}>
        <TraitsTab
          target={{ level: "TENANT", tenantId: "tenant-1" }} domainSlug={null} productSlug={null}
          data={{ own: [trait("t1", "Retry", "/schemas/enterprise/traits/t1"), { ...trait("t3", "Idempotent", "/schemas/enterprise/traits/t3"), kind: "OPERATION" as const }], inherited: [] }}
        />
      </QueryClientProvider>
    );
    expect(screen.getByText("message")).toBeDefined();
    expect(screen.getByText("operation")).toBeDefined();
    expect(screen.queryByTestId("traits-empty")).toBeNull();
  });

  it("creates a trait at the tab's level and opens it", async () => {
    h.createTraitAction.mockResolvedValue({ success: true, data: { id: "t9" } });
    const onCreateIntentConsumed = vi.fn();
    render(
      <QueryClientProvider client={new QueryClient()}>
        <TraitsTab target={{ level: "TENANT", tenantId: "tenant-1" }} domainSlug={null} productSlug={null} data={{ own: [], inherited: [] }} createIntent="trait" onCreateIntentConsumed={onCreateIntentConsumed} />
      </QueryClientProvider>
    );
    expect(onCreateIntentConsumed).toHaveBeenCalled();
    fireEvent.change(screen.getByLabelText("Trait name"), { target: { value: "CloudEvents" } });
    fireEvent.change(screen.getByLabelText("Kind"), { target: { value: "OPERATION" } });
    fireEvent.click(screen.getByRole("button", { name: "Create" }));
    await waitFor(() => expect(h.push).toHaveBeenCalledWith("/schemas/enterprise/traits/t9"));
    expect(h.createTraitAction).toHaveBeenCalledWith({ level: "TENANT", tenantId: "tenant-1" }, { name: "CloudEvents", kind: "OPERATION" });
  });

  it("the tab's own New Trait button opens the form (domain level) and a failure shows the error without navigating", async () => {
    h.createTraitAction.mockResolvedValue({ success: false, error: 'Trait "Retry" already exists at Domain level.', suggestedFix: "Pick another name." });
    render(
      <QueryClientProvider client={new QueryClient()}>
        <TraitsTab target={{ level: "DOMAIN", domainId: "d1" }} domainSlug="payments" productSlug={null} data={{ own: [], inherited: [] }} />
      </QueryClientProvider>
    );
    expect(screen.queryByTestId("new-trait-form")).toBeNull();
    fireEvent.click(screen.getByTestId("traits-new"));
    fireEvent.change(screen.getByLabelText("Trait name"), { target: { value: "Retry" } });
    fireEvent.click(screen.getByRole("button", { name: "Create" }));
    const alert = await screen.findByRole("alert");
    expect(alert.textContent).toMatch(/already exists/);
    expect(alert.textContent).toMatch(/Pick another name/);
    expect(h.createTraitAction).toHaveBeenCalledWith({ level: "DOMAIN", domainId: "d1" }, { name: "Retry", kind: "MESSAGE" });
    expect(h.push).not.toHaveBeenCalled();
  });

  it("opens the created product trait under its product URL", async () => {
    h.createTraitAction.mockResolvedValue({ success: true, data: { id: "t7" } });
    render(
      <QueryClientProvider client={new QueryClient()}>
        <TraitsTab target={{ level: "PRODUCT", productId: "p1" }} domainSlug="payments" productSlug="checkout" data={{ own: [], inherited: [] }} createIntent="trait" />
      </QueryClientProvider>
    );
    fireEvent.change(screen.getByLabelText("Trait name"), { target: { value: "Retry" } });
    fireEvent.click(screen.getByRole("button", { name: "Create" }));
    await waitFor(() => expect(h.push).toHaveBeenCalledWith("/schemas/payments/checkout/traits/t7"));
  });
});
