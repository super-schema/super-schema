// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => ({
  push: vi.fn(), refresh: vi.fn(), invalidate: vi.fn(), toastSuccess: vi.fn(), updateTraitAction: vi.fn(), deleteTraitAction: vi.fn(),
}));
vi.mock("next/navigation", () => ({ useRouter: () => ({ push: h.push, refresh: h.refresh }) }));
vi.mock("sonner", () => ({ toast: { success: h.toastSuccess, error: vi.fn() } }));
vi.mock("@/hooks/useDomainsTree", () => ({ useInvalidateDomainsTree: () => h.invalidate }));
vi.mock("@/app/(dashboard)/schemas/trait-actions", () => ({ updateTraitAction: h.updateTraitAction, deleteTraitAction: h.deleteTraitAction }));
import { TraitEditor } from "@/features/events/traits/TraitEditor";
import { GENERIC_ACTION_ERROR } from "@/lib/action-error";
import { BUNDLED_TRAITS } from "@/lib/events/bundled-traits";

const base = {
  owner: { level: "TENANT" as const, tenantId: "t" },
  crumbs: [{ label: "Message properties" }],
  listHref: "/schemas/enterprise?tab=traits",
  entityOptions: [{ id: "e1", name: "CloudEventsHeaders", ownerLabel: "Enterprise", latestVersionId: "v1", latestVersionLabel: "1.0" }],
};
const messageTrait = { id: "t1", name: "AuditHeaders", kind: "MESSAGE" as const, spec: { summary: "Audit" }, headers: null, tenantId: "t", domainId: null, productId: null };
const operationTrait = { ...messageTrait, id: "t2", name: "Retry", kind: "OPERATION" as const, spec: {} };
const ce = BUNDLED_TRAITS.find((t) => t.name === "CloudEvents")!;
const builtIn = { ...messageTrait, id: "b1", name: "CloudEvents", spec: JSON.parse(JSON.stringify(ce.spec)) as Record<string, never> };

const id = (testId: string) => screen.getByTestId(testId);
const input = (testId: string) => screen.getByTestId(testId) as HTMLInputElement;
const change = (el: HTMLElement, value: string) => fireEvent.change(el, { target: { value } });
const missing = (testId: string) => screen.queryByTestId(testId) === null;
const save = () => fireEvent.click(id("trait-save"));
const openMore = () => fireEvent.click(id("trait-editor-more-toggle"));

beforeEach(() => {
  vi.clearAllMocks();
  h.updateTraitAction.mockResolvedValue({ success: true, data: { id: "t1" } });
  vi.spyOn(console, "error").mockImplementation(() => undefined);
});
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe("TraitEditor: names", () => {
  it("says Message properties (Trait) under the title of a message set, with a Trait badge and what it applies to", () => {
    render(<TraitEditor {...base} trait={messageTrait} />);
    expect(screen.getByRole("heading", { level: 1 }).textContent).toContain("AuditHeaders");
    expect(id("trait-editor-subtitle").textContent).toBe("Message properties (Trait)");
    expect(id("trait-editor-badge").textContent).toBe("Trait");
    expect(within(screen.getByRole("heading", { level: 1 })).getByText("Message")).toBeDefined();
    expect(document.body.textContent).not.toMatch(/message trait|operation trait/i);
  });

  it("says Operation properties (Trait) for an operation set", () => {
    render(<TraitEditor {...base} trait={operationTrait} />);
    expect(id("trait-editor-subtitle").textContent).toBe("Operation properties (Trait)");
    expect(within(screen.getByRole("heading", { level: 1 })).getByText("Operation")).toBeDefined();
  });
});

describe("TraitEditor: a message set", () => {
  it("saves the name, the spec and no headers pin, and says Message properties saved", async () => {
    render(<TraitEditor {...base} trait={messageTrait} />);
    save();
    await waitFor(() => expect(h.refresh).toHaveBeenCalled());
    expect(h.updateTraitAction).toHaveBeenCalledWith("t1", base.owner, { name: "AuditHeaders", spec: { summary: "Audit" }, headers: null });
    expect(h.toastSuccess).toHaveBeenCalledWith("Message properties saved");
  });

  it("has no headers entity picker any more", () => {
    render(<TraitEditor {...base} trait={messageTrait} />);
    expect(screen.queryByLabelText("Headers entity")).toBeNull();
    expect(missing("trait-headers")).toBe(true);
    expect(missing("trait-editor-headers-note")).toBe(true);
  });

  it("edits the properties in the same table as the event builder and saves them as spec.headers", async () => {
    render(<TraitEditor {...base} trait={messageTrait} />);
    fireEvent.click(id("trait-editor-props-add"));
    change(input("trait-editor-props-name-0"), "actor");
    fireEvent.click(input("trait-editor-props-required-0"));
    change(input("trait-editor-props-description-0"), "Who did it");
    change(id("trait-editor-props-type-0"), "text");
    save();
    await waitFor(() => expect(h.refresh).toHaveBeenCalled());
    expect(h.updateTraitAction.mock.calls[0][2]).toEqual({
      name: "AuditHeaders", headers: null,
      spec: { summary: "Audit", headers: { type: "object", properties: { actor: { type: "string", description: "Who did it" } }, required: ["actor"] } },
    });
  });

  it("shows stored properties, keeps what the table does not understand, and removes `headers` when the last property goes", async () => {
    const trait = { ...messageTrait, spec: { summary: "A", headers: { type: "object", properties: { source: { type: "string", format: "uri-reference", minLength: 1 } }, required: ["source"] } } };
    render(<TraitEditor {...base} trait={trait} />);
    expect(input("trait-editor-props-name-0").value).toBe("source");
    change(input("trait-editor-props-description-0"), "Where from");
    save();
    await waitFor(() => expect(h.refresh).toHaveBeenCalledTimes(1));
    expect(h.updateTraitAction.mock.calls[0][2].spec.headers.properties.source).toEqual({ type: "string", format: "uri-reference", minLength: 1, description: "Where from" });
    fireEvent.click(id("trait-editor-props-remove-0"));
    save();
    await waitFor(() => expect(h.refresh).toHaveBeenCalledTimes(2));
    expect("headers" in h.updateTraitAction.mock.calls[1][2].spec).toBe(false);
  });

  it("round-trips an existing headers entity pin (including an explicitly unpinned one), shows it as a read-only note and never drops it", async () => {
    const pinned = { ...messageTrait, headers: { entityId: "e1", entityVersionId: null } };
    render(<TraitEditor {...base} trait={pinned} />);
    // no rows of its own: the table says where the properties come from, once (the entity has no known address here, so no link)
    expect(id("trait-editor-props-pin-note").textContent).toBe("Properties come from the entity CloudEventsHeaders.");
    expect(missing("trait-editor-headers-note")).toBe(true);
    fireEvent.click(id("trait-editor-props-add"));
    change(input("trait-editor-props-name-0"), "x");
    expect(id("trait-editor-headers-note").textContent).toBe("Headers come from the entity CloudEventsHeaders.");
    change(input("trait-editor-name"), "Renamed");
    save();
    await waitFor(() => expect(h.refresh).toHaveBeenCalledTimes(1));
    expect(h.updateTraitAction.mock.calls[0][2].headers).toEqual({ entityId: "e1", entityVersionId: null });
    expect(h.updateTraitAction.mock.calls[0][2].name).toBe("Renamed");
  });

  it("keeps a version pin as it is", async () => {
    render(<TraitEditor {...base} trait={{ ...messageTrait, headers: { entityId: "e1", entityVersionId: "v1" } }} />);
    save();
    await waitFor(() => expect(h.refresh).toHaveBeenCalled());
    expect(h.updateTraitAction.mock.calls[0][2].headers).toEqual({ entityId: "e1", entityVersionId: "v1" });
  });

  it("keeps the rest of the spec under 'More details': collapsed with a count, and every field of the message trait template but the headers entity reachable", () => {
    render(<TraitEditor {...base} trait={{ ...messageTrait, spec: { summary: "Audit", deprecated: true } }} />);
    expect(id("trait-editor-more-toggle").getAttribute("aria-expanded")).toBe("false");
    expect(id("trait-editor-more-count").textContent).toBe("2");
    expect(missing("trait-editor-more")).toBe(true);
    openMore();
    for (const key of ["title", "summary", "description", "contentType", "examples", "tags", "externalDocs", "deprecated"]) expect(missing(`trait-editor-${key}`), key).toBe(false);
    expect(missing("trait-editor-correlationId")).toBe(false);
    expect(missing("trait-editor-bindings")).toBe(false);
  });

  it("writes the other fields into the spec and saves them", async () => {
    render(<TraitEditor {...base} trait={messageTrait} />);
    openMore();
    change(input("trait-editor-title"), "Audit headers");
    change(input("trait-editor-summary"), "");
    change(input("trait-editor-contentType"), "application/json");
    save();
    await waitFor(() => expect(h.refresh).toHaveBeenCalled());
    expect(h.updateTraitAction.mock.calls[0][2].spec).toEqual({ title: "Audit headers", contentType: "application/json" });
  });

  it("keeps what it has no field for (the AsyncAPI name, x- extensions) as it is and names it", async () => {
    render(<TraitEditor {...base} trait={{ ...messageTrait, spec: { name: "audit", "x-owner": "platform", summary: "A" } }} />);
    openMore();
    expect(id("trait-editor-other").textContent).toBe("Other properties (kept as they are): name, x-owner");
    change(input("trait-editor-summary"), "B");
    save();
    await waitFor(() => expect(h.refresh).toHaveBeenCalled());
    expect(h.updateTraitAction.mock.calls[0][2].spec).toEqual({ name: "audit", "x-owner": "platform", summary: "B" });
  });

  it("writes protocol bindings into the spec and drops them when cleared", async () => {
    render(<TraitEditor {...base} trait={messageTrait} />);
    openMore();
    change(screen.getByTestId("trait-editor-bindings-protocol"), "kafka");
    fireEvent.click(id("trait-editor-bindings-add"));
    change(screen.getByTestId("trait-editor-bindings-kafka-schemaIdLocation"), "payload");
    expect(id("trait-editor-more-count").textContent).toBe("2");
    save();
    await waitFor(() => expect(h.refresh).toHaveBeenCalledTimes(1));
    expect(h.updateTraitAction.mock.calls[0][2].spec.bindings.kafka).toMatchObject({ schemaIdLocation: "payload" });
    change(screen.getByTestId("trait-editor-bindings-kafka-schemaIdLocation"), "");
    save();
    await waitFor(() => expect(h.refresh).toHaveBeenCalledTimes(2));
    expect("bindings" in h.updateTraitAction.mock.calls[1][2].spec).toBe(false);
  });

  it("renames through the Name input", async () => {
    render(<TraitEditor {...base} trait={messageTrait} />);
    change(screen.getByLabelText("Name"), "Audit2");
    save();
    await waitFor(() => expect(h.refresh).toHaveBeenCalled());
    expect(h.updateTraitAction.mock.calls[0][2]).toMatchObject({ name: "Audit2", spec: { summary: "Audit" } });
  });
});

describe("TraitEditor: an operation set", () => {
  it("has no Properties table, shows title, summary and description up front and never sends headers", async () => {
    render(<TraitEditor {...base} trait={operationTrait} />);
    expect(missing("trait-editor-props-add")).toBe(true);
    for (const key of ["title", "summary", "description"]) expect(missing(`trait-editor-${key}`), key).toBe(false);
    change(input("trait-editor-title"), "Retry three times");
    save();
    await waitFor(() => expect(h.refresh).toHaveBeenCalled());
    expect(h.updateTraitAction).toHaveBeenCalledWith("t2", base.owner, { name: "Retry", spec: { title: "Retry three times" }, headers: null });
  });

  it("keeps tags and docs under More details and a security list it cannot offer as it is", async () => {
    render(<TraitEditor {...base} trait={{ ...operationTrait, spec: { title: "T", security: ["basic"] } }} />);
    openMore();
    expect(missing("trait-editor-tags")).toBe(false);
    expect(missing("trait-editor-externalDocs-url")).toBe(false);
    expect(missing("trait-editor-security")).toBe(true);
    expect(id("trait-editor-other").textContent).toContain("security");
    save();
    await waitFor(() => expect(h.refresh).toHaveBeenCalled());
    expect(h.updateTraitAction.mock.calls[0][2].spec).toEqual({ title: "T", security: ["basic"] });
  });
});

describe("TraitEditor: a built-in set is read-only", () => {
  it("shows the lock, the explanation and the properties, with no Save and no Delete", () => {
    render(<TraitEditor {...base} trait={builtIn} />);
    expect(id("trait-editor-builtin-badge").textContent).toBe("Built in");
    expect(id("trait-editor-builtin-note").textContent).toContain("Built in — can't be modified");
    expect(id("trait-editor-builtin-note").textContent).toContain("CloudEvents is built in");
    expect(missing("trait-save")).toBe(true);
    expect(missing("trait-delete")).toBe(true);
    const names = within(id("trait-editor-props-table")).getAllByRole("rowheader").map((r) => r.textContent);
    expect(names).toEqual(["specversion", "id", "source", "type", "subject", "time", "datacontenttype", "dataschema"]);
    expect(id("trait-editor-props-row-specversion-allowed").textContent).toBe("Always1.0");
    expect(screen.getByText("8 properties")).toBeDefined();
  });

  it("has nothing to edit: no input, select, textarea or button inside the page content", () => {
    render(<TraitEditor {...base} trait={builtIn} />);
    expect(id("trait-editor-readonly").querySelectorAll("input, select, textarea, button")).toHaveLength(0);
    expect(missing("trait-editor-form")).toBe(true);
    expect(missing("trait-editor-name")).toBe(true);
    expect(h.updateTraitAction).not.toHaveBeenCalled();
  });

  it("shows the description the specification gives", () => {
    render(<TraitEditor {...base} trait={builtIn} />);
    expect(id("trait-editor-description").textContent).toContain("CloudEvents 1.0 envelope");
  });
});

describe("TraitEditor: errors and delete", () => {
  it("shows service errors with their fix, but never database error text", async () => {
    render(<TraitEditor {...base} trait={messageTrait} />);
    h.updateTraitAction.mockResolvedValueOnce({ success: false, error: "Trait is owned by another Domain scope.", code: "FORBIDDEN", suggestedFix: "Open it from its owning level to edit it." });
    save();
    const alert = await screen.findByTestId("trait-error");
    expect(alert.textContent).toMatch(/owned by another Domain scope/);
    expect(alert.textContent).toMatch(/Open it from its owning level/);

    const raw = 'insert or update on table "schema_references" violates foreign key constraint';
    h.updateTraitAction.mockResolvedValueOnce({ success: false, error: raw, code: "DB_ERROR" });
    save();
    await waitFor(() => expect(screen.getByTestId("trait-error").textContent).toBe(GENERIC_ACTION_ERROR));
    h.updateTraitAction.mockRejectedValueOnce(new Error("connect ECONNREFUSED"));
    save();
    await waitFor(() => expect(screen.getByTestId("trait-error").textContent).toBe(GENERIC_ACTION_ERROR));
    expect(document.body.textContent).not.toMatch(/schema_references|ECONNREFUSED/);
    expect((id("trait-save") as HTMLButtonElement).disabled).toBe(false);
  });

  it("deletes after confirmation, naming the message properties, and returns to the list; declining or failing leaves the page alone", async () => {
    const confirm = vi.spyOn(window, "confirm").mockReturnValue(false);
    render(<TraitEditor {...base} trait={messageTrait} />);
    fireEvent.click(id("trait-delete"));
    expect(confirm).toHaveBeenCalledWith('Delete message properties "AuditHeaders"?');
    expect(h.deleteTraitAction).not.toHaveBeenCalled();
    confirm.mockReturnValue(true);
    h.deleteTraitAction.mockResolvedValueOnce({ success: false, error: "Trait is in use", code: "IN_USE" });
    fireEvent.click(id("trait-delete"));
    expect((await screen.findByTestId("trait-error")).textContent).toMatch(/in use/);
    expect(h.push).not.toHaveBeenCalled();
    // Neither a declined confirmation nor a refused delete refreshes the explorer: nothing was deleted.
    expect(h.invalidate).not.toHaveBeenCalled();
    h.deleteTraitAction.mockResolvedValueOnce({ success: true, data: { id: "t1" } });
    fireEvent.click(id("trait-delete"));
    await waitFor(() => expect(h.push).toHaveBeenCalledWith(base.listHref));
    expect(h.deleteTraitAction).toHaveBeenLastCalledWith("t1", base.owner);
    expect((id("trait-delete") as HTMLButtonElement).disabled).toBe(true);
    // The explorer's React Query cache only refreshes through invalidate (revalidatePath does not reach it).
    expect(h.invalidate).toHaveBeenCalledTimes(1);
  });

  it("names operation properties in the delete confirmation of an operation set", () => {
    const confirm = vi.spyOn(window, "confirm").mockReturnValue(false);
    render(<TraitEditor {...base} trait={operationTrait} />);
    fireEvent.click(id("trait-delete"));
    expect(confirm).toHaveBeenCalledWith('Delete operation properties "Retry"?');
  });
});
