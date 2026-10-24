/**
 * @vitest-environment jsdom
 */
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ReferencePickDialog } from "@/components/custom/ReferencePickDialog/ReferencePickDialog";

afterEach(cleanup);

const CANDIDATES = [
  { entityId: "e1", domain: "Sales", product: "Crm", entity: "Customer" },
  { entityId: "e2", domain: "Billing", product: "Core", entity: "Customer" },
];

describe("ReferencePickDialog", () => {
  it("lists candidates as domain / product / entity", () => {
    render(<ReferencePickDialog candidates={CANDIDATES} onPick={vi.fn()} onCancel={vi.fn()} />);
    expect(screen.getByText("Sales / Crm / Customer")).toBeTruthy();
    expect(screen.getByText("Billing / Core / Customer")).toBeTruthy();
  });

  it("calls onPick with the chosen candidate", () => {
    const onPick = vi.fn();
    render(<ReferencePickDialog candidates={CANDIDATES} onPick={onPick} onCancel={vi.fn()} />);
    fireEvent.click(screen.getByText("Billing / Core / Customer"));
    expect(onPick).toHaveBeenCalledWith(CANDIDATES[1]);
  });

  it("calls onCancel on Cancel", () => {
    const onCancel = vi.fn();
    render(<ReferencePickDialog candidates={CANDIDATES} onPick={vi.fn()} onCancel={onCancel} />);
    fireEvent.click(screen.getByRole("button", { name: /cancel/i }));
    expect(onCancel).toHaveBeenCalled();
  });

  it("carries test ids for the dialog, the candidate list and each candidate", () => {
    render(<ReferencePickDialog candidates={CANDIDATES} onPick={vi.fn()} onCancel={vi.fn()} />);
    expect(screen.getByTestId("reference-pick-dialog")).toBeTruthy();
    expect(screen.getByTestId("reference-pick-candidates")).toBeTruthy();
    const items = screen.getAllByTestId("reference-pick-candidate");
    expect(items.map((el) => el.textContent)).toEqual(["Sales / Crm / Customer", "Billing / Core / Customer"]);
    expect(items.map((el) => el.getAttribute("data-entity-id"))).toEqual(["e1", "e2"]);
  });

  it("names the field and the name it refers to when it is told them", () => {
    render(<ReferencePickDialog candidates={CANDIDATES} field="customer" name="Customer" onPick={vi.fn()} onCancel={vi.fn()} />);
    expect(screen.getByText(/Field "customer" refers to "Customer", which matches 2 entities/)).toBeTruthy();
  });

  it("shows why a pick was not saved, and disables the candidates while one is being saved", () => {
    const { rerender } = render(<ReferencePickDialog candidates={CANDIDATES} error="Not allowed" onPick={vi.fn()} onCancel={vi.fn()} />);
    expect(screen.getByRole("alert").textContent).toBe("Not allowed");

    rerender(<ReferencePickDialog candidates={CANDIDATES} saving onPick={vi.fn()} onCancel={vi.fn()} />);
    expect(screen.getAllByTestId("reference-pick-candidate").every((el) => (el as HTMLButtonElement).disabled)).toBe(true);
  });
});
