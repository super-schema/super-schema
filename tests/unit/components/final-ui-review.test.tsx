/**
 * Final UI review fixes outside the metadata editors:
 * - U1: the event builder pane rail (message / operation parts) wraps its narrow-width tab row, so the last tab (Metadata) is reachable
 *   without horizontal scrolling;
 * - U2: the domain policy "Metadata attributes" section lists only definitions that target fields or entities;
 * - U3: the add-field name suggestions close on a pick, keeping the focus in the name input;
 * - U8: the admin classification Class select reads "Class 1 — Never Stored" … "Class 5 — Public".
 *
 * @vitest-environment jsdom
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { useState } from "react";
import { PaneRail } from "@/features/events/builder/sections/PaneRail";
import { PolicyTemplateEditor } from "@/components/custom/admin/PolicyTemplateEditor";
import { AutocompleteInput } from "@/components/custom/AutocompleteInput";
import { ClassificationList } from "@/components/custom/admin/ClassificationList";
import type { MetadataAttributeDefinition } from "@/types/schemas/metadata-attribute";
import type { AutocompleteSuggestion } from "@/lib/autocomplete/field-name-autocomplete";

afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

describe("PaneRail narrow tab row (U1)", () => {
  it("wraps instead of scrolling horizontally", () => {
    const panes = Array.from({ length: 10 }, (_, i) => ({ id: `p${i}`, title: i === 9 ? "Metadata" : `Part ${i}`, body: <p>{i}</p> }));
    render(<PaneRail idPrefix="message" panes={panes} active="p0" onSelect={() => {}} />);
    const list = screen.getByRole("tablist");
    expect(list.className).toContain("flex-wrap");
    expect(list.className).not.toMatch(/(^|\s)overflow-x-auto(\s|$)/);
    expect(screen.getByRole("tab", { name: "Metadata" })).toBeTruthy();
  });
});

describe("PolicyTemplateEditor Metadata attributes (U2)", () => {
  const def = (key: string, targets: MetadataAttributeDefinition["targets"]): MetadataAttributeDefinition => ({
    key, label: key, description: "", valueSchema: { type: "string" }, targets, scope: "schema", placement: "field", derive: null, requiredWhen: "never",
  });

  it("lists only field- or entity-target definitions", () => {
    const defs = [def("x-field", ["field"]), def("x-entity", ["entity"]), def("x-evt-tag", ["message", "operation"]), def("x-chan", ["channel"]), def("x-both", ["field", "channel"])];
    render(<PolicyTemplateEditor value={null} attributeDefinitions={defs} onChange={() => {}} />);
    const keys = screen.getAllByRole("combobox", { name: /^Required when for / }).map((s) => s.getAttribute("aria-label")!.replace("Required when for ", ""));
    expect(keys).toEqual(["x-field", "x-entity", "x-both"]);
  });

  it("hides the section when no definition targets fields or entities", () => {
    render(<PolicyTemplateEditor value={null} attributeDefinitions={[def("x-chan", ["channel"])]} onChange={() => {}} />);
    expect(screen.queryByText("Metadata attributes")).toBeNull();
  });
});

describe("AutocompleteInput pick (U3)", () => {
  const SUGGESTIONS: AutocompleteSuggestion[] = [
    { value: "customer_email", source: "dictionary" } as AutocompleteSuggestion,
    { value: "customer_id", source: "standard" } as AutocompleteSuggestion,
  ];
  function Host({ onSelect }: { onSelect: (s: AutocompleteSuggestion) => void }) {
    const [v, setV] = useState("");
    return (
      <AutocompleteInput
        value={v}
        onChange={setV}
        onSelect={onSelect}
        getSuggestions={(q) => SUGGESTIONS.filter((s) => s.value.includes(q))}
        placeholder="field_name"
      />
    );
  }

  it("closes the suggestions on a pick and keeps the focus in the input", () => {
    vi.useFakeTimers();
    const onSelect = vi.fn();
    render(<Host onSelect={onSelect} />);
    const input = screen.getByPlaceholderText("field_name") as HTMLInputElement;
    input.focus();
    fireEvent.change(input, { target: { value: "cust" } });
    expect(screen.getByTestId("autocomplete-suggestions")).toBeTruthy();
    fireEvent.mouseDown(screen.getByRole("button", { name: /customer_email/ }));
    expect(onSelect).toHaveBeenCalled();
    expect(input.value).toBe("customer_email");
    expect(screen.queryByTestId("autocomplete-suggestions")).toBeNull();
    act(() => vi.advanceTimersByTime(2000));
    expect(screen.queryByTestId("autocomplete-suggestions")).toBeNull();
    expect(document.activeElement).toBe(input);
    // Typing again opens them again.
    fireEvent.change(input, { target: { value: "customer_" } });
    expect(screen.getByTestId("autocomplete-suggestions")).toBeTruthy();
  });

  it("closes on an Enter pick too", () => {
    render(<Host onSelect={() => {}} />);
    const input = screen.getByPlaceholderText("field_name") as HTMLInputElement;
    fireEvent.change(input, { target: { value: "cust" } });
    fireEvent.keyDown(input, { key: "Enter" });
    expect(input.value).toBe("customer_email");
    expect(screen.queryByTestId("autocomplete-suggestions")).toBeNull();
  });
});

describe("ClassificationList Class select (U8)", () => {
  it("reads Class 1 — Never Stored … Class 5 — Public", () => {
    render(<ClassificationList />);
    fireEvent.click(screen.getByTestId("classification-add-open"));
    const options = [...(screen.getByTestId("classification-class") as HTMLSelectElement).options].map((o) => o.textContent);
    expect(options).toEqual(["Class 1 — Never Stored", "Class 2 — PII", "Class 3 — Sensitive", "Class 4 — Internal", "Class 5 — Public"]);
  });
});
