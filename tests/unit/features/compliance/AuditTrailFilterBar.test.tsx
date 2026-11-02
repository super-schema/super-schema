// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { AuditTrailFilterBar } from "@/features/compliance/AuditTrailFilterBar";
import type { AuditTrailFilter } from "@/types/schemas/compliance";

// The From and To inputs choose whole LOCAL days. The filter they send is `from` (the start of the first day) and `to` (the start of the day AFTER
// the last one, exclusive): a To day is never cut at midnight, and a From chosen alone invents no To.

afterEach(() => {
  cleanup();
});

const dateInput = (name: "From" | "To") => screen.getByPlaceholderText(name) as HTMLInputElement;

function renderBar(filters: AuditTrailFilter, onFilterChange = vi.fn()) {
  render(<AuditTrailFilterBar filters={filters} onFilterChange={onFilterChange} onExport={() => undefined} />);
  return onFilterChange;
}

describe("the Audit Trail's export button", () => {
  it("is off while an export is made, and on again after", () => {
    const { rerender } = render(<AuditTrailFilterBar filters={{}} onFilterChange={vi.fn()} onExport={vi.fn()} exporting />);
    expect((screen.getByTestId("audit-export") as HTMLButtonElement).disabled).toBe(true);

    rerender(<AuditTrailFilterBar filters={{}} onFilterChange={vi.fn()} onExport={vi.fn()} exporting={false} />);
    expect((screen.getByTestId("audit-export") as HTMLButtonElement).disabled).toBe(false);
  });
});

describe("the Audit Trail's date inputs", () => {
  it("choosing From alone sends that day's start and no To", () => {
    const onFilterChange = renderBar({});

    fireEvent.change(dateInput("From"), { target: { value: "2026-10-01" } });

    const sent = onFilterChange.mock.calls[0][0] as AuditTrailFilter;
    expect(sent.dateRange?.from).toEqual(new Date(2026, 9, 1));
    expect(sent.dateRange).not.toHaveProperty("to");
  });

  it("choosing To sends the start of the day AFTER it (exclusive), so the whole day is in", () => {
    const onFilterChange = renderBar({ dateRange: { from: new Date(2026, 9, 1) } });

    fireEvent.change(dateInput("To"), { target: { value: "2026-10-31" } });

    const sent = onFilterChange.mock.calls[0][0] as AuditTrailFilter;
    expect(sent.dateRange).toEqual({ from: new Date(2026, 9, 1), to: new Date(2026, 10, 1) });
  });

  it("the inputs show the days the range holds: From the first day, To the last one", () => {
    renderBar({ dateRange: { from: new Date(2026, 9, 1), to: new Date(2026, 10, 1) } });

    expect(dateInput("From").value).toBe("2026-10-01");
    expect(dateInput("To").value).toBe("2026-10-31");
  });

  it("clearing To keeps From, and clearing From keeps To", () => {
    const onFilterChange = renderBar({ dateRange: { from: new Date(2026, 9, 1), to: new Date(2026, 10, 1) } });

    fireEvent.change(dateInput("To"), { target: { value: "" } });
    expect(onFilterChange.mock.calls[0][0].dateRange).toEqual({ from: new Date(2026, 9, 1), to: undefined });

    fireEvent.change(dateInput("From"), { target: { value: "" } });
    expect(onFilterChange.mock.calls[1][0].dateRange).toEqual({ from: undefined, to: new Date(2026, 10, 1) });
  });

  it("a range with no bound left is no filter at all", () => {
    const onFilterChange = renderBar({ dateRange: { from: new Date(2026, 9, 1) } });

    fireEvent.change(dateInput("From"), { target: { value: "" } });

    expect(onFilterChange.mock.calls[0][0].dateRange).toBeUndefined();
  });
});
