/** @vitest-environment jsdom */
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { EntityAttributesSection } from "@/app/(dashboard)/schemas/[domainSlug]/[productSlug]/[entityId]/components/EntityAttributesSection";
import { ENTITY_ONLY, RETENTION, SECURITY } from "./fixtures";

afterEach(cleanup);

const defs = [SECURITY, ENTITY_ONLY, RETENTION];

describe("EntityAttributesSection", () => {
  it("lists entity-target dictionary keys only", () => {
    render(<EntityAttributesSection metadata={null} definitions={defs} isReadOnly={false} onSave={vi.fn()} />);
    fireEvent.change(screen.getByLabelText("Attribute key"), { target: { value: "x-" } });
    const names = screen.getAllByRole("option").map((o) => o.textContent);
    expect(names.some((n) => n?.includes("x-owner-team"))).toBe(true);
    expect(names.some((n) => n?.includes("x-retentionDays"))).toBe(true);
    expect(names.some((n) => n?.includes("x-securityClassification"))).toBe(false);
  });

  it("renders nothing when no definition targets entities", () => {
    const { container } = render(<EntityAttributesSection metadata={null} definitions={[SECURITY]} isReadOnly={false} onSave={vi.fn()} />);
    expect(container.innerHTML).toBe("");
  });

  it("picks, edits and saves one attribute; shows undefined stored keys raw", async () => {
    const onSave = vi.fn().mockResolvedValue(undefined);
    render(
      <EntityAttributesSection
        metadata={{ custom: { extensions: { "x-legacy": { a: 1 } } } }}
        definitions={defs}
        isReadOnly={false}
        onSave={onSave}
      />,
    );
    expect(screen.getByText("x-legacy")).toBeTruthy();
    fireEvent.change(screen.getByLabelText("Attribute key"), { target: { value: "x-owner" } });
    fireEvent.click(screen.getByRole("option", { name: /Owner team/ }));
    fireEvent.change(screen.getByLabelText("Owner team"), { target: { value: "data" } });
    fireEvent.click(screen.getByRole("button", { name: "Save Owner team" }));
    await vi.waitFor(() => expect(onSave).toHaveBeenCalledWith("x-owner-team", "data"));
  });

  it("removes a stored attribute", async () => {
    const onSave = vi.fn().mockResolvedValue(undefined);
    render(
      <EntityAttributesSection metadata={{ custom: { extensions: { "x-owner-team": "a" } } }} definitions={defs} isReadOnly={false} onSave={onSave} />,
    );
    fireEvent.click(screen.getByRole("button", { name: "Remove Owner team" }));
    await vi.waitFor(() => expect(onSave).toHaveBeenCalledWith("x-owner-team", undefined));
  });

  it("is read-only without edit rights", () => {
    render(
      <EntityAttributesSection metadata={{ custom: { extensions: { "x-owner-team": "a" } } }} definitions={defs} isReadOnly onSave={vi.fn()} />,
    );
    expect(screen.queryByRole("button", { name: "Remove Owner team" })).toBeNull();
    expect(screen.queryByLabelText("Attribute key")).toBeNull();
  });
});
