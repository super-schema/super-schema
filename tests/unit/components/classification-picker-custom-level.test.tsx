/**
 * A classification level outside the app's five-level scale (a JSON Schema import keeps the vendor's own `data_class`, e.g.
 * `class4`) must be shown as itself, not as the "Sensitive" default.
 *
 * @vitest-environment jsdom
 */
import { afterEach, describe, expect, it } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import { ClassificationPicker } from "@/components/custom/ClassificationPicker";

afterEach(cleanup);

describe("ClassificationPicker", () => {
  it("shows a level of the scale by its short label", () => {
    render(<ClassificationPicker value="PII" onChange={() => {}} />);
    expect(screen.getByText("PII")).toBeTruthy();
  });

  it("shows no value as the Class 3 default", () => {
    render(<ClassificationPicker value={null} onChange={() => {}} />);
    expect(screen.getByText("Class 3")).toBeTruthy();
  });

  it("shows a level outside the scale verbatim, not as Sensitive", () => {
    render(<ClassificationPicker value="class4" onChange={() => {}} />);
    expect(screen.getByText("class4")).toBeTruthy();
    expect(screen.queryByText("Sensitive")).toBeNull();
  });
});
