// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { JsonField } from "@/features/events/shared/JsonField";
import { EventVersionList } from "@/features/events/shared/EventVersionList";

afterEach(() => cleanup());

describe("JsonField", () => {
  it("flags invalid JSON and wrong shapes inline", () => {
    const onChange = vi.fn();
    const { rerender } = render(<JsonField id="b" label="Bindings" value="{" onChange={onChange} mode="object" />);
    expect(screen.getByRole("alert").textContent).toMatch(/Bindings is not valid JSON/);
    expect(screen.getByLabelText("Bindings").getAttribute("aria-invalid")).toBe("true");
    rerender(<JsonField id="b" label="Bindings" value='{"kafka":{}}' onChange={onChange} mode="object" />);
    expect(screen.queryByRole("alert")).toBeNull();
    rerender(<JsonField id="e" label="Examples" value="{}" onChange={onChange} mode="array" />);
    expect(screen.getByRole("alert").textContent).toMatch(/Examples must be a JSON array of objects/);
    fireEvent.change(screen.getByLabelText("Examples"), { target: { value: "[]" } });
    expect(onChange).toHaveBeenCalledWith("[]");
  });
});

describe("EventVersionList", () => {
  it("renders versions newest-first with deep links, or the empty text", () => {
    const { rerender } = render(<EventVersionList versions={[]} emptyText="Not published yet." />);
    expect(screen.getByText("Not published yet.")).toBeDefined();
    rerender(
      <EventVersionList
        emptyText="-"
        hrefFor={(label) => `/x?version=${label}`}
        versions={[{ id: "v2", major: 1, minor: 1, label: "1.1", sequence: 2, changeKind: "MINOR", changeSummary: "docs", publishedByName: "Ada", publishedAt: "2026-10-14T00:00:00.000Z" }]}
      />
    );
    expect(screen.getByRole("link", { name: "v1.1" }).getAttribute("href")).toBe("/x?version=1.1");
    expect(screen.getByText("MINOR")).toBeDefined();
    expect(screen.getByText("docs")).toBeDefined();
  });
});
