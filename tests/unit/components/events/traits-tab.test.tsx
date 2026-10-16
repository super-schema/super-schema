// @vitest-environment jsdom
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => ({ push: vi.fn(), createTraitAction: vi.fn() }));
vi.mock("next/navigation", () => ({ useRouter: () => ({ push: h.push }) }));
vi.mock("@/app/(dashboard)/schemas/trait-actions", () => ({ createTraitAction: h.createTraitAction }));
import { TraitsTab } from "@/features/events/workspace/TraitsTab";
import { GENERIC_ACTION_ERROR } from "@/types/action-result";

beforeEach(() => vi.resetAllMocks());
afterEach(() => cleanup());
const trait = (id: string, name: string, href: string) => ({ id, name, kind: "MESSAGE" as const, summary: "", updatedAt: "", href });

describe("TraitsTab", () => {
  it("lists own traits and read-only inherited groups", () => {
    render(
      <QueryClientProvider client={new QueryClient()}>
        <TraitsTab
          target={{ level: "DOMAIN", domainId: "d1" }} domainSlug="payments"
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
        <TraitsTab target={{ level: "TENANT", tenantId: "tenant-1" }} domainSlug={null} data={{ own: [], inherited: [] }} />
      </QueryClientProvider>
    );
    expect(screen.getByTestId("traits-empty")).toBeDefined();
    cleanup();

    render(
      <QueryClientProvider client={new QueryClient()}>
        <TraitsTab
          target={{ level: "TENANT", tenantId: "tenant-1" }} domainSlug={null}
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
        <TraitsTab target={{ level: "TENANT", tenantId: "tenant-1" }} domainSlug={null} data={{ own: [], inherited: [] }} createIntent="trait" onCreateIntentConsumed={onCreateIntentConsumed} />
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
        <TraitsTab target={{ level: "DOMAIN", domainId: "d1" }} domainSlug="payments" data={{ own: [], inherited: [] }} />
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

  it("opens the created domain trait under its domain URL", async () => {
    h.createTraitAction.mockResolvedValue({ success: true, data: { id: "t7" } });
    render(
      <QueryClientProvider client={new QueryClient()}>
        <TraitsTab target={{ level: "DOMAIN", domainId: "d1" }} domainSlug="payments" data={{ own: [], inherited: [] }} createIntent="trait" />
      </QueryClientProvider>
    );
    fireEvent.change(screen.getByLabelText("Trait name"), { target: { value: "Retry" } });
    fireEvent.click(screen.getByRole("button", { name: "Create" }));
    await waitFor(() => expect(h.push).toHaveBeenCalledWith("/schemas/payments/traits/t7"));
  });

  describe("create form error display and submit guard", () => {
    function openForm() {
      render(
        <QueryClientProvider client={new QueryClient()}>
          <TraitsTab target={{ level: "TENANT", tenantId: "tenant-1" }} domainSlug={null} data={{ own: [], inherited: [] }} createIntent="trait" />
        </QueryClientProvider>
      );
      fireEvent.change(screen.getByLabelText("Trait name"), { target: { value: "CloudEvents" } });
    }

    it("shows the generic message, never the raw text, for a DB_ERROR result", async () => {
      h.createTraitAction.mockResolvedValue({
        success: false, code: "DB_ERROR", error: "Invalid `prisma.trait.create()` invocation: Can't reach database server", suggestedFix: "Check DATABASE_URL",
      });
      openForm();
      fireEvent.click(screen.getByRole("button", { name: "Create" }));
      expect((await screen.findByRole("alert")).textContent).toBe(GENERIC_ACTION_ERROR);
      expect(document.body.textContent).not.toMatch(/prisma|database server|DATABASE_URL/);
      expect(screen.getByRole("button", { name: "Create" }).hasAttribute("disabled")).toBe(false);
    });

    it("shows the generic message when the action throws and leaves the form usable", async () => {
      const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});
      h.createTraitAction.mockRejectedValue(new Error("connect ECONNREFUSED 127.0.0.1:5432"));
      openForm();
      fireEvent.click(screen.getByRole("button", { name: "Create" }));
      expect((await screen.findByRole("alert")).textContent).toBe(GENERIC_ACTION_ERROR);
      expect(document.body.textContent).not.toMatch(/ECONNREFUSED/);
      expect(screen.getByRole("button", { name: "Create" }).hasAttribute("disabled")).toBe(false);
      consoleError.mockRestore();
    });

    it("keeps a conflict message and its suggested fix", async () => {
      h.createTraitAction.mockResolvedValue({ success: false, code: "NAME_CONFLICT", error: 'Trait "CloudEvents" already exists.', suggestedFix: "Pick another name." });
      openForm();
      fireEvent.click(screen.getByRole("button", { name: "Create" }));
      expect((await screen.findByRole("alert")).textContent).toBe('Trait "CloudEvents" already exists. Pick another name.');
    });

    it("stays busy after a successful create so a double click cannot create a duplicate", async () => {
      h.createTraitAction.mockResolvedValue({ success: true, data: { id: "t9" } });
      openForm();
      fireEvent.click(screen.getByRole("button", { name: "Create" }));
      await waitFor(() => expect(h.push).toHaveBeenCalledTimes(1));
      const busy = screen.getByRole("button", { name: "Creating…" });
      expect(busy.hasAttribute("disabled")).toBe(true);
      fireEvent.click(busy);
      fireEvent.submit(screen.getByTestId("new-trait-form"));
      expect(h.createTraitAction).toHaveBeenCalledTimes(1);
      expect(h.push).toHaveBeenCalledTimes(1);
    });
  });
});
