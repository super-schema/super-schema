/**
 * @vitest-environment jsdom
 */
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { PrimaryKeyDialog } from "@/app/(dashboard)/schemas/[domainSlug]/[productSlug]/[entityId]/components/PrimaryKeyDialog";
import type { MissingRequirement } from "@/lib/schema-targets/requirements";

const REQUIREMENT: MissingRequirement = {
  code: "primary-key",
  message: "Order has no primary key. This target needs at least one field that identifies a row.",
  candidates: ["id", "tenant", "note"],
  suggested: ["id"],
};

function open(over: Partial<MissingRequirement> = {}, onConfirm = vi.fn(), onCancel = vi.fn()) {
  render(<PrimaryKeyDialog requirement={{ ...REQUIREMENT, ...over }} onConfirm={onConfirm} onCancel={onCancel} />);
  return {
    onConfirm,
    onCancel,
    box: (name: string) => screen.getByRole("checkbox", { name }) as HTMLInputElement,
    save: () => screen.getByRole("button", { name: /Save key and generate/ }) as HTMLButtonElement,
  };
}

describe("PrimaryKeyDialog", () => {
  afterEach(() => cleanup());

  it("explains what is needed and lists every candidate as a checkbox", () => {
    open();
    expect(screen.getByText("This target needs a primary key")).toBeDefined();
    expect(screen.getByText(REQUIREMENT.message)).toBeDefined();
    expect(screen.getAllByRole("checkbox").map((b) => (b.closest("label") as HTMLElement).textContent)).toEqual(["id", "tenant", "note"]);
  });

  it("pre-checks the suggestion only", () => {
    const { box } = open();
    expect([box("id").checked, box("tenant").checked, box("note").checked]).toEqual([true, false, false]);
  });

  it("disables the confirm button with nothing selected and enables it again on a pick", () => {
    const { box, save } = open({ suggested: [] });
    expect(save().disabled).toBe(true);
    fireEvent.click(box("tenant"));
    expect(save().disabled).toBe(false);
    fireEvent.click(box("tenant"));
    expect(save().disabled).toBe(true);
  });

  it("confirms a composite key with the names in declaration order", async () => {
    const { box, save, onConfirm } = open();
    fireEvent.click(box("note"));
    fireEvent.click(box("tenant"));
    fireEvent.click(save());
    await waitFor(() => expect(onConfirm).toHaveBeenCalledWith(["id", "tenant", "note"]));
  });

  it("cancel calls onCancel and never onConfirm", () => {
    const { onCancel, onConfirm } = open();
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    expect(onCancel).toHaveBeenCalledTimes(1);
    expect(onConfirm).not.toHaveBeenCalled();
  });

  it("shows a failure returned by onConfirm inline and keeps the dialog open for another try", async () => {
    const onConfirm = vi.fn().mockResolvedValueOnce("Not a field of this entity: x").mockResolvedValueOnce(undefined);
    const { save } = open({}, onConfirm);
    fireEvent.click(save());
    expect((await screen.findByRole("alert")).textContent).toBe("Not a field of this entity: x");
    expect(save().disabled).toBe(false);
    fireEvent.click(save());
    await waitFor(() => expect(onConfirm).toHaveBeenCalledTimes(2));
    await waitFor(() => expect(screen.queryByRole("alert")).toBeNull());
  });

  it("shows a generic failure when onConfirm throws", async () => {
    const { save } = open({}, vi.fn().mockRejectedValue(new Error("boom")));
    fireEvent.click(save());
    expect((await screen.findByRole("alert")).textContent).toBe("Could not save the primary key");
  });

  it("with no fields offers nothing to pick and cannot be confirmed", () => {
    const { save } = open({ candidates: [], suggested: [] });
    expect(screen.getByText(/no fields to choose from/)).toBeDefined();
    expect(save().disabled).toBe(true);
  });
});
