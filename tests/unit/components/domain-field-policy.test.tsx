// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import "@testing-library/jest-dom/vitest";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DomainDataTable } from "@/components/custom/admin/DomainDataTable";

const mocks = vi.hoisted(() => ({ list: vi.fn(), save: vi.fn(), invalidate: vi.fn() }));
vi.mock("@/app/(dashboard)/admin/actions", () => ({ getDomainsAdminAction: mocks.list, updateDomainPolicyAction: mocks.save, createDomainAdminAction: vi.fn() }));
vi.mock("@/hooks/useDomainsTree", () => ({ useInvalidateDomainsTree: () => mocks.invalidate }));

const DOMAIN = { id: "d1", name: "Identity", description: "Accounts", entityCount: 3, policyTemplateStatus: "No template", policyTemplate: null, createdAt: new Date("2026-01-01") };
beforeEach(() => {
  vi.clearAllMocks();
  mocks.list.mockResolvedValue({ data: [DOMAIN] });
  mocks.save.mockImplementation(async (_id, policyTemplate) => ({ success: true, data: { ...DOMAIN, policyTemplate } }));
});
afterEach(cleanup);

async function openPolicy() {
  render(<DomainDataTable />);
  fireEvent.click(await screen.findByRole("button", { name: "Configure policy for Identity" }));
  return within(screen.getByRole("dialog"));
}

describe("domain field completeness configuration", () => {
  it("preserves the rest of an existing policy and confirms before saving", async () => {
    const original = { classification: "PUBLIC", retention: "90 days", fieldCompleteness: { decimal: { scale: "required" } } };
    mocks.list.mockResolvedValue({ data: [{ ...DOMAIN, policyTemplateStatus: "Configured", policyTemplate: original }] });
    const form = await openPolicy();
    fireEvent.change(form.getByLabelText("Minimum length"), { target: { value: "required" } });
    fireEvent.click(form.getByRole("button", { name: "Save Template" }));
    expect(mocks.save).not.toHaveBeenCalled();
    fireEvent.click(form.getByRole("button", { name: "Confirm" }));
    await waitFor(() => expect(mocks.save).toHaveBeenCalledWith("d1", {
      ...original, fieldCompleteness: { decimal: { scale: "required" }, string: { minLength: "required" } },
    }));
  });
  it("saves per-type checks through the admin action and shows them on reopening", async () => {
    const form = await openPolicy();
    fireEvent.change(form.getByLabelText("Minimum length"), { target: { value: "required" } });
    fireEvent.change(form.getByLabelText("Maximum length"), { target: { value: "off" } });
    fireEvent.click(form.getByRole("button", { name: "Save Template" }));
    const policy = { fieldCompleteness: { string: { minLength: "required", maxLength: "off" } } };
    await waitFor(() => expect(mocks.save).toHaveBeenCalledWith("d1", policy));
    await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
    fireEvent.click(screen.getByRole("button", { name: "Configure policy for Identity" }));
    expect(screen.getByLabelText("Minimum length")).toHaveValue("required");
    expect(screen.getByLabelText("Maximum length")).toHaveValue("off");
  });

  it("inherits a parent's rules and lets a subtype restore inheritance", async () => {
    const form = await openPolicy();
    fireEvent.change(form.getByLabelText("Minimum length"), { target: { value: "required" } });
    fireEvent.change(form.getByLabelText("Field check data type"), { target: { value: "url" } });
    expect(form.getByLabelText("Minimum length")).toHaveDisplayValue("Default (Required)");
    fireEvent.change(form.getByLabelText("Minimum length"), { target: { value: "off" } });
    fireEvent.change(form.getByLabelText("Minimum length"), { target: { value: "inherit" } });
    fireEvent.click(form.getByRole("button", { name: "Save Template" }));
    await waitFor(() => expect(mocks.save).toHaveBeenCalledWith("d1", { fieldCompleteness: { string: { minLength: "required" } } }));
  });

  it("keeps the policy open on refusal so the user can retry", async () => {
    mocks.save.mockResolvedValueOnce({ error: "You do not have permission to do this" });
    const form = await openPolicy();
    fireEvent.change(form.getByLabelText("Minimum length"), { target: { value: "required" } });
    fireEvent.click(form.getByRole("button", { name: "Save Template" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("do not have permission");
    expect(form.getByLabelText("Minimum length")).toHaveValue("required");
    fireEvent.click(form.getByRole("button", { name: "Save Template" }));
    await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
    expect(mocks.save).toHaveBeenCalledTimes(2);
  });
});
