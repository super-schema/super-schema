/** @vitest-environment jsdom */
import { afterEach, describe, expect, it } from "vitest";
import { useState } from "react";
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { ExtensionsPanel } from "@/app/(dashboard)/schemas/[domainSlug]/[productSlug]/[entityId]/fields/[fieldId]/panels/ExtensionsPanel";
import type { Extensions } from "@/types/schemas/typespec-decorator.schema";
import type { MetadataAttributeDefinition } from "@/types/schemas/metadata-attribute";
import { ENTITY_ONLY, RETENTION, SECURITY } from "./fixtures";

afterEach(cleanup);

function Harness({ initial = {}, defs = [SECURITY, RETENTION] }: { initial?: Extensions; defs?: MetadataAttributeDefinition[] }) {
  const [v, set] = useState<Extensions>(initial);
  return (
    <>
      <ExtensionsPanel extensions={v} onChange={set} definitions={defs} />
      <output data-testid="stored">{JSON.stringify(v.openapi ?? {})}</output>
    </>
  );
}

const stored = () => JSON.parse(screen.getByTestId("stored").textContent!);

describe("ExtensionsPanel with a dictionary", () => {
  it("suggests the dictionary key, and picking it shows a 6-option select and a read-only derived member", () => {
    render(<Harness />);
    fireEvent.change(screen.getByLabelText("Attribute key"), { target: { value: "x-sec" } });
    fireEvent.click(screen.getByRole("option", { name: /Security classification \(x-securityClassification\)/ }));
    expect(within(screen.getByLabelText("data_category")).getAllByRole("option")).toHaveLength(6);
    expect((screen.getByLabelText("data_class") as HTMLInputElement).readOnly).toBe(true);
    expect(stored()).toEqual({ "x-securityClassification": {} });
    fireEvent.change(screen.getByLabelText("data_category"), { target: { value: "Intrinsic" } });
    expect(stored()["x-securityClassification"]).toEqual({ data_category: "Intrinsic" });
  });

  it("warns on an invalid value and never blocks saving", () => {
    render(<Harness initial={{ openapi: { "x-retentionDays": 0 } }} />);
    expect(screen.getByRole("alert").textContent).toContain("must be >= 1");
    fireEvent.change(screen.getByRole("spinbutton"), { target: { value: "-2" } });
    expect(stored()["x-retentionDays"]).toBe(-2);
    fireEvent.change(screen.getByLabelText("Extension name"), { target: { value: "x-raw" } });
    expect((screen.getByRole("button", { name: "Add extension" }) as HTMLButtonElement).disabled).toBe(false);
  });

  it("clearing a number keeps the key and its editor, typing '-' too; only Remove deletes", () => {
    render(<Harness initial={{ openapi: { "x-retentionDays": 5 } }} />);
    const box = () => screen.getByRole("spinbutton") as HTMLInputElement;
    fireEvent.change(box(), { target: { value: "" } });
    expect(box().value).toBe("");
    expect(stored()).toEqual({ "x-retentionDays": 5 });
    fireEvent.change(box(), { target: { value: "12" } });
    expect(stored()).toEqual({ "x-retentionDays": 12 });
    fireEvent.click(screen.getByRole("button", { name: "Remove Retention days" }));
    expect(stored()).toEqual({});
    expect(screen.queryByRole("spinbutton")).toBeNull();
  });

  it("clearing a string keeps the key (as an empty string) and its editor", () => {
    const owner = { ...ENTITY_ONLY, targets: ["field" as const] };
    render(<Harness initial={{ openapi: { "x-owner-team": "data" } }} defs={[owner]} />);
    fireEvent.change(screen.getByLabelText("Owner team", { selector: "input" }), { target: { value: "" } });
    expect(stored()).toEqual({ "x-owner-team": "" });
    expect(screen.getByLabelText("Owner team", { selector: "input" })).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Remove Owner team" }));
    expect(stored()).toEqual({});
  });

  it("removes a dictionary attribute", () => {
    render(<Harness initial={{ openapi: { "x-retentionDays": 5 } }} />);
    fireEvent.click(screen.getByRole("button", { name: "Remove Retention days" }));
    expect(stored()).toEqual({});
  });

  it("keeps the raw editor for a key the dictionary does not define", () => {
    render(<Harness initial={{ openapi: { "x-unknown": "v", "x-retentionDays": 3 } }} />);
    expect(screen.getByRole("button", { name: "Edit extension x-unknown" })).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Edit extension x-retentionDays" })).toBeNull();
  });
});

describe("ExtensionsPanel without definitions", () => {
  const extensions: Extensions = { openapi: { "x-a": "1", "x-b": { n: 2 } } };
  it("renders exactly as today", () => {
    const { container: none } = render(<ExtensionsPanel extensions={extensions} onChange={() => {}} />);
    const norm = (h: string) => h.replace(/_r_[a-z0-9]+_/g, "_r_");
    const before = norm(none.innerHTML);
    cleanup();
    const { container: empty } = render(<ExtensionsPanel extensions={extensions} onChange={() => {}} definitions={[]} />);
    expect(norm(empty.innerHTML)).toBe(before);
    expect(before).not.toContain("Attribute key");
    expect(before).toMatchSnapshot();
  });
});
