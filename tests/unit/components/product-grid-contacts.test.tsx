/**
 * @vitest-environment jsdom
 */
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ProductGrid } from "@/app/(dashboard)/schemas/[domainSlug]/product-grid";

const { createProductActionMock, pushMock } = vi.hoisted(() => ({
  createProductActionMock: vi.fn(),
  pushMock: vi.fn(),
}));

vi.mock("@/app/(dashboard)/schemas/[domainSlug]/product-actions", () => ({
  createProductAction: createProductActionMock,
  deleteProductAction: vi.fn(),
}));
vi.mock("next/navigation", () => ({ useRouter: () => ({ refresh: vi.fn(), push: pushMock }) }));
vi.mock("sonner", () => ({ toast: { error: vi.fn(), success: vi.fn() } }));

function renderGrid() {
  return render(
    <QueryClientProvider client={new QueryClient()}>
      <ProductGrid domainId="dom-1" domainName="Orders" domainSlug="orders" products={[]} tiers={[]} />
    </QueryClientProvider>
  );
}

const lead = () => screen.getByTestId("product-engineering-lead-input") as HTMLInputElement;
const manager = () => screen.getByTestId("product-manager-input") as HTMLInputElement;
const team = () => screen.getByTestId("product-team-emails-input") as HTMLInputElement;
const submit = () => fireEvent.click(screen.getByRole("button", { name: "Create" }));
const typeInto = (input: HTMLInputElement, value: string) => fireEvent.change(input, { target: { value } });

function openCreateForm(name = "Billing") {
  fireEvent.click(screen.getAllByRole("button", { name: /New Product/i })[0]);
  fireEvent.change(screen.getByPlaceholderText(/OneSCM/), { target: { value: name } });
}

describe("Create New Product: contacts", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    createProductActionMock.mockResolvedValue({ success: true, productId: "prd-2", slug: "billing" });
  });
  afterEach(() => cleanup());

  it("shows Engineering Lead, Manager and Team email addresses in the create form", () => {
    renderGrid();
    openCreateForm();

    expect(screen.getByLabelText("Engineering Lead")).toBe(lead());
    expect(screen.getByLabelText("Manager")).toBe(manager());
    expect(screen.getByLabelText("Team email addresses")).toBe(team());
    expect(lead().placeholder).toBe("Jane Doe <jane@acme.com>");
  });

  it("submits no contacts (null, null, []) when the three fields are left empty", async () => {
    renderGrid();
    openCreateForm();

    submit();

    await waitFor(() => expect(createProductActionMock).toHaveBeenCalledTimes(1));
    expect(createProductActionMock).toHaveBeenCalledWith({
      domainId: "dom-1",
      name: "Billing",
      description: "",
      tierId: null,
      ownerTeam: null,
      engineeringLead: null,
      manager: null,
      teamEmails: [],
    });
  });

  it("submits canonical contact text: names kept, quotes only where needed, chips as an array", async () => {
    renderGrid();
    openCreateForm();
    typeInto(lead(), '  "Jane Doe"   <jane@acme.com> ');
    typeInto(manager(), '"Roe, Rick" <rick@acme.com>');
    typeInto(team(), "Platform Team <platform@acme.com>");
    fireEvent.keyDown(team(), { key: "Enter" });
    typeInto(team(), "oncall@acme.com");
    fireEvent.keyDown(team(), { key: "," });

    submit();

    await waitFor(() => expect(createProductActionMock).toHaveBeenCalledTimes(1));
    expect(createProductActionMock).toHaveBeenCalledWith(
      expect.objectContaining({
        engineeringLead: "Jane Doe <jane@acme.com>",
        manager: '"Roe, Rick" <rick@acme.com>',
        teamEmails: ["Platform Team <platform@acme.com>", "oncall@acme.com"],
      })
    );
  });

  it("does not lose an address that was typed into the team box but not yet added (it is submitted too)", async () => {
    renderGrid();
    openCreateForm();
    typeInto(team(), "a@acme.com");
    fireEvent.keyDown(team(), { key: "Enter" });
    typeInto(team(), "pending@acme.com");

    submit();

    await waitFor(() => expect(createProductActionMock).toHaveBeenCalledTimes(1));
    expect(createProductActionMock).toHaveBeenCalledWith(expect.objectContaining({ teamEmails: ["a@acme.com", "pending@acme.com"] }));
  });

  it("submits a pasted list of team addresses, with a comma-in-quotes name intact", async () => {
    renderGrid();
    openCreateForm();
    fireEvent.paste(team(), { clipboardData: { getData: () => '"Doe, Jane" <j@x.com>, b@acme.com; B@ACME.COM' } });

    submit();

    await waitFor(() => expect(createProductActionMock).toHaveBeenCalledTimes(1));
    expect(createProductActionMock).toHaveBeenCalledWith(expect.objectContaining({ teamEmails: ['"Doe, Jane" <j@x.com>', "b@acme.com"] }));
  });

  it("blocks the submit and shows an inline error on every malformed contact field, without calling the server", async () => {
    renderGrid();
    openCreateForm();
    typeInto(lead(), "jane");
    typeInto(manager(), "Doe, Jane <j@x.com>");
    typeInto(team(), "broken");

    submit();

    expect(screen.getByTestId("product-engineering-lead-error").textContent).toContain("jane");
    expect(screen.getByTestId("product-manager-error").textContent).toMatch(/quotes/i);
    expect(screen.getByTestId("product-team-emails-error").textContent).toContain("broken");
    expect(lead().getAttribute("aria-invalid")).toBe("true");
    expect(createProductActionMock).not.toHaveBeenCalled();
    expect(screen.getByRole("button", { name: "Create" })).toBeTruthy();
  });

  it("shows the name problem and the contact problems together", () => {
    renderGrid();
    openCreateForm("");
    typeInto(manager(), "nope");

    submit();

    expect(screen.getByText("Product name is required")).toBeTruthy();
    expect(screen.getByTestId("product-manager-error")).toBeTruthy();
    expect(createProductActionMock).not.toHaveBeenCalled();
  });

  it("creates once the malformed field is fixed", async () => {
    renderGrid();
    openCreateForm();
    typeInto(lead(), "jane");
    submit();
    expect(createProductActionMock).not.toHaveBeenCalled();

    typeInto(lead(), "Jane <jane@acme.com>");
    expect(screen.queryByTestId("product-engineering-lead-error")).toBeNull();
    submit();

    await waitFor(() => expect(createProductActionMock).toHaveBeenCalledTimes(1));
    expect(createProductActionMock).toHaveBeenCalledWith(expect.objectContaining({ engineeringLead: "Jane <jane@acme.com>" }));
  });

  it("shows the server's per-field contact messages inline and keeps the form open", async () => {
    createProductActionMock.mockResolvedValue({
      error: "Manager message",
      fieldErrors: { manager: "Manager message", teamEmails: "Team message" },
    });
    renderGrid();
    openCreateForm();
    typeInto(manager(), "mo@acme.com");

    submit();

    expect((await screen.findByTestId("product-manager-error")).textContent).toBe("Manager message");
    expect(screen.getByTestId("product-team-emails-error").textContent).toBe("Team message");
    expect(screen.getByRole("button", { name: "Create" })).toBeTruthy();
    expect((screen.getByRole("button", { name: "Create" }) as HTMLButtonElement).disabled).toBe(false);
    expect(pushMock).not.toHaveBeenCalled();
  });

  it("forgets typed contacts and errors when the form is cancelled and reopened", () => {
    renderGrid();
    openCreateForm();
    typeInto(lead(), "jane");
    typeInto(team(), "a@acme.com");
    fireEvent.keyDown(team(), { key: "Enter" });
    submit();
    expect(screen.getByTestId("product-engineering-lead-error")).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    fireEvent.click(screen.getAllByRole("button", { name: /New Product/i })[0]);

    expect(lead().value).toBe("");
    expect(team().value).toBe("");
    expect(screen.queryAllByTestId("product-team-emails-chip")).toHaveLength(0);
    expect(screen.queryByTestId("product-engineering-lead-error")).toBeNull();
  });

  it("navigates to the new product after a create with contacts", async () => {
    renderGrid();
    openCreateForm();
    typeInto(lead(), "Jane <jane@acme.com>");

    submit();

    await waitFor(() => expect(pushMock).toHaveBeenCalledWith(expect.stringContaining("billing")));
  });
});
