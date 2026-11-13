/** @vitest-environment jsdom */
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { AttributesSection } from "@/components/custom/metadata/AttributesSection";
import type { MetadataAttributeDefinition } from "@/types/schemas/metadata-attribute";
import { ENTITY_ONLY, SECURITY } from "./fixtures";

afterEach(cleanup);

const OP_OWNER: MetadataAttributeDefinition = { ...ENTITY_ONLY, key: "x-serviceName", label: "Service name", targets: ["operation", "channel"] };
const MSG_ONLY: MetadataAttributeDefinition = { ...ENTITY_ONLY, key: "x-msg-note", label: "Message note", targets: ["message"] };
const defs = [SECURITY, OP_OWNER, MSG_ONLY];

describe("AttributesSection", () => {
  it("offers only the definitions that list the target", () => {
    render(<AttributesSection target="channel" definitions={defs} extensions={undefined} onChange={vi.fn()} />);
    fireEvent.change(screen.getByLabelText("Attribute key"), { target: { value: "x-" } });
    const names = screen.getAllByRole("option").map((o) => o.textContent);
    expect(names.some((n) => n?.includes("x-serviceName"))).toBe(true);
    expect(names.some((n) => n?.includes("x-msg-note"))).toBe(false);
    expect(names.some((n) => n?.includes("x-securityClassification"))).toBe(false);
  });

  it("renders nothing when no definition targets it and nothing is stored", () => {
    const { container } = render(<AttributesSection target="operation" definitions={[SECURITY, MSG_ONLY]} extensions={undefined} onChange={vi.fn()} />);
    expect(container.innerHTML).toBe("");
  });

  it("adds an attribute, edits it and removes it, handing the whole next map to the host", () => {
    const onChange = vi.fn();
    const { rerender } = render(<AttributesSection target="operation" definitions={defs} extensions={{ "x-legacy": { a: 1 } }} onChange={onChange} />);
    expect(screen.getByText("x-legacy")).toBeTruthy(); // stored, not defined for the target: shown raw
    fireEvent.change(screen.getByLabelText("Attribute key"), { target: { value: "x-service" } });
    fireEvent.click(screen.getByRole("option", { name: /Service name/ }));
    expect(onChange).toHaveBeenLastCalledWith({ "x-legacy": { a: 1 }, "x-serviceName": "" });

    rerender(<AttributesSection target="operation" definitions={defs} extensions={{ "x-serviceName": "a" }} onChange={onChange} />);
    fireEvent.change(screen.getByLabelText("Service name"), { target: { value: "vault" } });
    expect(onChange).toHaveBeenLastCalledWith({ "x-serviceName": "vault" });
    fireEvent.click(screen.getByRole("button", { name: "Remove Service name" }));
    expect(onChange).toHaveBeenLastCalledWith(undefined);
  });

  it("is read-only without edit rights", () => {
    render(<AttributesSection target="channel" definitions={defs} extensions={{ "x-serviceName": "a" }} onChange={vi.fn()} readOnly />);
    expect(screen.queryByRole("button", { name: "Remove Service name" })).toBeNull();
    expect(screen.queryByLabelText("Attribute key")).toBeNull();
  });
});
