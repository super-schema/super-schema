// @vitest-environment jsdom
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => ({ push: vi.fn(), createTraitAction: vi.fn() }));
vi.mock("next/navigation", () => ({ useRouter: () => ({ push: h.push }) }));
vi.mock("@/app/(dashboard)/schemas/trait-actions", () => ({ createTraitAction: h.createTraitAction }));
import { TraitsTab } from "@/features/events/workspace/TraitsTab";
import { GENERIC_ACTION_ERROR } from "@/types/action-result";

beforeEach(() => vi.resetAllMocks());
afterEach(() => cleanup());
const trait = (id: string, name: string, href: string) => ({ id, name, kind: "MESSAGE" as const, summary: "", updatedAt: "", href });
const TENANT = { level: "TENANT" as const, tenantId: "tenant-1" };
const renderTab = (props: Partial<Parameters<typeof TraitsTab>[0]> = {}) =>
  render(
    <QueryClientProvider client={new QueryClient()}>
      <TraitsTab target={TENANT} domainSlug={null} data={{ own: [], inherited: [] }} {...props} />
    </QueryClientProvider>
  );

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

  it("shows an empty state, and kind badges per set of message properties", () => {
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
    expect(screen.getByText("Message")).toBeDefined();
    expect(screen.getByText("Operation")).toBeDefined();
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
    fireEvent.change(screen.getByLabelText("Name"), { target: { value: "CloudEvents" } });
    fireEvent.change(screen.getByLabelText("Applies to"), { target: { value: "OPERATION" } });
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
    fireEvent.change(screen.getByLabelText("Name"), { target: { value: "Retry" } });
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
    fireEvent.change(screen.getByLabelText("Name"), { target: { value: "Retry" } });
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
      fireEvent.change(screen.getByLabelText("Name"), { target: { value: "CloudEvents" } });
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

describe("TraitsTab: Message properties (Trait)", () => {
  it("is named Message properties (Trait), never 'Traits', with a New Message Properties button and an empty state in the same words", () => {
    renderTab();
    expect(screen.getByTestId("traits-subtitle").textContent).toBe("Message properties (Trait)");
    expect(screen.getByTestId("traits-new").textContent).toContain("New Message Properties");
    expect(screen.getByTestId("traits-empty").textContent).toBe("No message properties at this level yet.");
    expect(document.body.textContent).not.toMatch(/\bTraits?\b(?! *\))/);
  });

  it("shows a lock and 'Built in' on the built-in sets, and how many properties each set brings", () => {
    renderTab({
      data: {
        own: [],
        inherited: [{
          label: "From Enterprise", href: "/schemas/enterprise?tab=traits",
          traits: [
            { ...trait("b1", "CloudEvents", "/schemas/enterprise/traits/b1"), bundled: true, propertyCount: 8 },
            { ...trait("b2", "Audit", "/schemas/enterprise/traits/b2"), bundled: false, propertyCount: 1 },
            { ...trait("b3", "Retry", "/schemas/enterprise/traits/b3"), kind: "OPERATION" as const, bundled: false, propertyCount: 0 },
            trait("b4", "Legacy", "/schemas/enterprise/traits/b4"),
          ],
        }],
      },
    });
    expect(screen.getByTestId("trait-card-b1-builtin").textContent).toBe("Built in");
    expect(screen.getByTestId("trait-card-b1-count").textContent).toBe("8 properties");
    expect(screen.getByTestId("trait-card-b2-count").textContent).toBe("1 property");
    expect(screen.queryByTestId("trait-card-b2-builtin")).toBeNull();
    expect(screen.queryByTestId("trait-card-b3-count")).toBeNull();
    expect(screen.queryByTestId("trait-card-b4-count")).toBeNull();
    expect(screen.queryByTestId("trait-card-b4-builtin")).toBeNull();
  });

  it("opens the 'New Message Properties' form with a name, what it applies to and an optional description", () => {
    renderTab({ createIntent: "trait" });
    const form = screen.getByTestId("new-trait-form");
    expect(within(form).getByRole("heading").textContent).toBe("New Message Properties");
    expect((screen.getByLabelText("Applies to") as HTMLSelectElement).value).toBe("MESSAGE");
    expect(Array.from((screen.getByLabelText("Applies to") as HTMLSelectElement).options).map((o) => o.textContent)).toEqual(["Message", "Operation"]);
    expect(screen.getByLabelText("Description")).toBeDefined();
    expect(form.textContent).toContain("You add the properties themselves on the next page.");
    expect(form.textContent).not.toMatch(/Headers|entity/i);
  });

  it("creates the set with its description as spec.description and opens it", async () => {
    h.createTraitAction.mockResolvedValue({ success: true, data: { id: "t5" } });
    renderTab({ createIntent: "trait" });
    fireEvent.change(screen.getByLabelText("Name"), { target: { value: "Audit headers" } });
    fireEvent.change(screen.getByLabelText("Description"), { target: { value: "  Who did it  " } });
    fireEvent.click(screen.getByRole("button", { name: "Create" }));
    await waitFor(() => expect(h.push).toHaveBeenCalledWith("/schemas/enterprise/traits/t5"));
    expect(h.createTraitAction).toHaveBeenCalledWith(TENANT, { name: "Audit headers", kind: "MESSAGE", spec: { description: "Who did it" } });
  });

  it("leaves spec out when the description is blank", async () => {
    h.createTraitAction.mockResolvedValue({ success: true, data: { id: "t6" } });
    renderTab({ createIntent: "trait" });
    fireEvent.change(screen.getByLabelText("Name"), { target: { value: "Retry" } });
    fireEvent.change(screen.getByLabelText("Description"), { target: { value: "   " } });
    fireEvent.click(screen.getByRole("button", { name: "Create" }));
    await waitFor(() => expect(h.push).toHaveBeenCalled());
    expect(h.createTraitAction).toHaveBeenCalledWith(TENANT, { name: "Retry", kind: "MESSAGE" });
  });
});
