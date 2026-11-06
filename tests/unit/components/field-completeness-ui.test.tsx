// @vitest-environment jsdom
import { cleanup, render, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { FieldCompletenessDetails } from "@/components/custom/ValidationIndicator/FieldCompletenessDetails";

afterEach(cleanup);
describe("field completeness tooltip content", () => {
  it("shows separate lists for required and suggested information", () => {
    render(<FieldCompletenessDetails completeness={{ status: "error", missing: ["precision", "scale"], suggestions: ["description"] }} />);
    const lists = screen.getAllByRole("list");
    expect(screen.getByText("Required")).toBeDefined();
    expect(screen.getByText("Suggested")).toBeDefined();
    expect(within(lists[0]).getAllByRole("listitem").map((item) => item.textContent)).toEqual(["Precision", "Scale"]);
    expect(within(lists[1]).getAllByRole("listitem").map((item) => item.textContent)).toEqual(["Field description"]);
    expect(screen.queryByText(/classification|Class 3|SENSITIVE/i)).toBeNull();
  });
  it("does not invent suggestions for a complete field", () => {
    render(<FieldCompletenessDetails completeness={{ status: "complete", missing: [], suggestions: [] }} />);
    expect(screen.getByText("Field complete")).toBeDefined();
    expect(screen.queryByRole("list")).toBeNull();
  });
});
