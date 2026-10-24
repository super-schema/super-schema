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
});
