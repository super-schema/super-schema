// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { useState } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { KeyInput } from "@/features/events/builder/controls";
import { SECTION_COMPONENTS } from "@/features/events/builder/EventBuilder";
import type { SaveDocument } from "@/features/events/builder/use-event-draft";
import { parseEventDocument } from "@/lib/events/document/parse";
import { emptyEventDocument } from "@/lib/events/document/types";
import { bindingVersion, TEMPLATES } from "@/lib/events/templates";
import type { ActionResult } from "@/types/action-result";
import type { EventDetail } from "@/services/events/event.service";
import { makeEvent, renderBuilder, sampleDocument } from "./builder-harness";

const HOST_MESSAGE = "host must be host or host:port — no spaces and no scheme";

beforeEach(() => vi.clearAllMocks());
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

const type = (el: HTMLElement, value: string) => fireEvent.change(el, { target: { value } });
const click = (testId: string) => fireEvent.click(screen.getByTestId(testId));
const button = (testId: string) => screen.getByTestId(testId) as HTMLButtonElement;
const box = (testId: string) => screen.getByTestId(testId) as HTMLInputElement;
const field = (label: string) => screen.getByLabelText(label) as HTMLInputElement;
const status = () => screen.getByTestId("builder-status").textContent;
const text = (testId: string) => screen.getByTestId(testId).textContent;

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((r) => { resolve = r; });
  return { promise, resolve };
}

describe("EventBuilder: outline", () => {
  it("renders the seven outline nodes in order with their item counts (Metadata has none)", () => {
    renderBuilder();
    const nodes = ["metadata", "servers", "channels", "messages", "operations", "traits", "advanced"];
    const outline = within(screen.getByRole("navigation", { name: "Event outline" }));
    expect(outline.getAllByRole("button").map((b) => b.getAttribute("data-testid"))).toEqual(nodes.map((n) => `outline-${n}`));
    expect(nodes.map((n) => button(`outline-${n}`).textContent)).toEqual([
      expect.stringContaining("Metadata"), expect.stringContaining("Servers"), expect.stringContaining("Channels"),
      expect.stringContaining("Messages"), expect.stringContaining("Operations"), expect.stringContaining("Message properties"), expect.stringContaining("Advanced"),
    ]);
    expect(screen.getByTestId("outline-count-servers").textContent).toBe("2");
    expect(screen.getByTestId("outline-count-channels").textContent).toBe("2");
    expect(screen.getByTestId("outline-count-messages").textContent).toBe("1");
    expect(screen.getByTestId("outline-count-operations").textContent).toBe("1");
    // the sample document has no traits and no security schemes
    expect(screen.getByTestId("outline-count-traits").textContent).toBe("0");
    expect(screen.getByTestId("outline-count-advanced").textContent).toBe("0");
    expect(screen.queryByTestId("outline-count-metadata")).toBeNull();
  });

  it("uses real buttons, and only the active section carries aria-current", () => {
    renderBuilder({ section: "servers" });
    for (const s of ["metadata", "servers", "channels", "messages", "operations", "traits", "advanced"]) {
      expect(button(`outline-${s}`).tagName).toBe("BUTTON");
      expect(button(`outline-${s}`).getAttribute("type")).toBe("button");
    }
    expect(button("outline-servers").getAttribute("aria-current")).toBe("true");
    expect(button("outline-metadata").hasAttribute("aria-current")).toBe(false);
    expect(button("outline-operations").hasAttribute("aria-current")).toBe(false);
  });

  it("switches the section when a node is clicked and clears the selected item", () => {
    const { probe } = renderBuilder({ section: "servers", item: "kafka-dev" });
    expect(screen.getByTestId("section-servers")).toBeDefined();
    click("outline-metadata");
    expect(probe.section).toBe("metadata");
    expect(probe.item).toBeNull();
    expect(screen.getByTestId("section-metadata")).toBeDefined();
    expect(screen.queryByTestId("section-servers")).toBeNull();
    expect(button("outline-metadata").getAttribute("aria-current")).toBe("true");
    expect(button("outline-servers").hasAttribute("aria-current")).toBe(false);
  });

  it("shows a problem badge on Servers when a server host is empty, and on no other node", () => {
    const doc = sampleDocument();
    doc.servers[1] = { ...doc.servers[1], host: "" };
    renderBuilder({ doc });
    expect(screen.getByTestId("outline-problems-servers").textContent).toContain("1");
    for (const s of ["metadata", "channels", "messages", "operations", "traits", "advanced"]) expect(screen.queryByTestId(`outline-problems-${s}`)).toBeNull();
  });

  it("updates the badge live as the document becomes valid again", () => {
    const doc = sampleDocument();
    doc.servers[1] = { ...doc.servers[1], host: "" };
    renderBuilder({ doc, section: "servers", item: "kafka-dev" });
    expect(screen.queryByTestId("outline-problems-servers")).not.toBeNull();
    type(field("Host"), "dev.internal:9092");
    expect(screen.queryByTestId("outline-problems-servers")).toBeNull();
  });

  it("renders a placeholder for a section that has no component yet", () => {
    const original = SECTION_COMPONENTS.operations;
    delete SECTION_COMPONENTS.operations;
    try {
      renderBuilder({ section: "operations" });
      const placeholder = screen.getByTestId("section-placeholder");
      expect(placeholder.textContent).toContain("Operations");
      expect(placeholder.textContent).toContain("Coming in the next slice");
    } finally {
      SECTION_COMPONENTS.operations = original;
    }
  });

  it("registers a component for every section of the outline", () => {
    for (const section of ["metadata", "servers", "channels", "messages", "operations", "traits", "advanced"] as const) {
      expect(SECTION_COMPONENTS[section], section).toBeTypeOf("function");
    }
  });
});

describe("EventBuilder: layout", () => {
  const STORAGE_KEY = "events-builder-outline";
  const root = () => screen.getByTestId("event-builder");
  // This jsdom environment ships no localStorage; install a Map-backed one (or one that throws, as a browser with blocked storage does).
  function installStorage(blocked = false) {
    const store = new Map<string, string>();
    const guard = <T,>(fn: () => T): T => { if (blocked) throw new Error("blocked"); return fn(); };
    Object.defineProperty(globalThis, "localStorage", {
      configurable: true,
      value: {
        getItem: (key: string) => guard(() => store.get(key) ?? null),
        setItem: (key: string, value: string) => guard(() => void store.set(key, value)),
        removeItem: (key: string) => guard(() => void store.delete(key)),
        clear: () => store.clear(),
      },
    });
  }
  beforeEach(() => installStorage());

  it("lets the outline be switched between compact and open, and remembers the choice", () => {
    renderBuilder();
    // No choice yet: the pane's width decides (CSS only), so the attribute is absent.
    expect(root().hasAttribute("data-outline")).toBe(false);
    // jsdom has no layout: an undecided outline counts as compact, so the first click opens it.
    click("outline-toggle");
    expect(root().getAttribute("data-outline")).toBe("open");
    expect(button("outline-toggle").getAttribute("aria-pressed")).toBe("false");
    click("outline-toggle");
    expect(root().getAttribute("data-outline")).toBe("compact");
    expect(button("outline-toggle").getAttribute("aria-pressed")).toBe("true");
    expect(localStorage.getItem(STORAGE_KEY)).toBe("compact");
  });

  it("restores the remembered outline choice", () => {
    localStorage.setItem(STORAGE_KEY, "compact");
    renderBuilder();
    expect(root().getAttribute("data-outline")).toBe("compact");
    expect(button("outline-toggle").getAttribute("aria-pressed")).toBe("true");
  });

  it("ignores a remembered value it does not know", () => {
    localStorage.setItem(STORAGE_KEY, "sideways");
    renderBuilder();
    expect(root().hasAttribute("data-outline")).toBe(false);
  });

  it("still renders and toggles when the browser blocks storage", () => {
    installStorage(true);
    renderBuilder();
    click("outline-toggle");
    expect(root().getAttribute("data-outline")).toBe("open");
  });

  it("gives every outline node its label as a title, and keeps the label text in the DOM when compact", () => {
    localStorage.setItem(STORAGE_KEY, "compact");
    renderBuilder();
    const labels: Record<string, string> = {
      metadata: "Metadata", servers: "Servers", channels: "Channels", messages: "Messages", operations: "Operations",
      traits: "Message properties", advanced: "Advanced",
    };
    for (const [section, label] of Object.entries(labels)) {
      expect(button(`outline-${section}`).getAttribute("title")).toBe(label);
      const text = within(button(`outline-${section}`)).getByText(label);
      expect(text.className).toContain("sr-only");
    }
  });

  it("makes the content column a size container, so sections lay out by the pane's width and not the viewport's", () => {
    renderBuilder({ section: "messages" });
    expect(screen.getByTestId("builder-content").className).toContain("@container");
  });
});

describe("EventBuilder: Mod+S", () => {
  const press = (init: KeyboardEventInit) => fireEvent.keyDown(document, { key: "s", ...init });

  it("saves a dirty draft with Cmd+S and Ctrl+S, and takes the key from the browser", async () => {
    const { probe } = renderBuilder();
    type(field("Title"), "Changed");
    let notPrevented = true;
    await act(async () => { notPrevented = press({ metaKey: true }); });
    expect(notPrevented).toBe(false);
    expect(probe.saveDocument).toHaveBeenCalledTimes(1);
    type(field("Title"), "Changed again");
    await act(async () => { press({ ctrlKey: true }); });
    expect(probe.saveDocument).toHaveBeenCalledTimes(2);
  });

  it("does not save a clean draft, and still keeps the browser's save-page dialog away", async () => {
    const { probe } = renderBuilder();
    let notPrevented = true;
    await act(async () => { notPrevented = press({ metaKey: true }); });
    expect(notPrevented).toBe(false);
    expect(probe.saveDocument).not.toHaveBeenCalled();
  });

  it("does not start a second save while one is running", async () => {
    const pending = deferred<ActionResult<EventDetail>>();
    const saveDocument = vi.fn<SaveDocument>().mockReturnValue(pending.promise);
    renderBuilder({ saveDocument });
    type(field("Title"), "Changed");
    await act(async () => { press({ metaKey: true }); });
    await act(async () => { press({ metaKey: true }); });
    expect(saveDocument).toHaveBeenCalledTimes(1);
    await act(async () => { pending.resolve({ success: true, data: makeEvent() }); });
  });

  it("answers nothing while the Design tab is hidden, and leaves the key to the browser", async () => {
    const { probe } = renderBuilder({ active: false });
    type(field("Title"), "Changed");
    let notPrevented = false;
    await act(async () => { notPrevented = press({ metaKey: true }); });
    expect(notPrevented).toBe(true);
    expect(probe.saveDocument).not.toHaveBeenCalled();
  });

  it("ignores S with Shift or Alt, and other keys with the modifier", async () => {
    const { probe } = renderBuilder();
    type(field("Title"), "Changed");
    await act(async () => {
      press({ metaKey: true, shiftKey: true });
      press({ metaKey: true, altKey: true });
      fireEvent.keyDown(document, { key: "k", metaKey: true });
      fireEvent.keyDown(document, { key: "s" });
    });
    expect(probe.saveDocument).not.toHaveBeenCalled();
  });

  it("keeps the key from the shell's own Mod+S handler, which would flash 'All changes saved' whatever the save does", async () => {
    const shell = vi.fn();
    document.addEventListener("keydown", shell);
    try {
      renderBuilder();
      type(field("Title"), "Changed");
      await act(async () => { press({ metaKey: true }); });
      expect(shell).not.toHaveBeenCalled();
    } finally {
      document.removeEventListener("keydown", shell);
    }
  });

  it("leaves the shell's handler alone while the Design tab is hidden", async () => {
    const shell = vi.fn();
    document.addEventListener("keydown", shell);
    try {
      renderBuilder({ active: false });
      await act(async () => { press({ metaKey: true }); });
      expect(shell).toHaveBeenCalledTimes(1);
    } finally {
      document.removeEventListener("keydown", shell);
    }
  });

  it("flashes 'All changes saved' once the save has succeeded, and not for a refused save or a clean draft", async () => {
    const flash = vi.fn();
    document.addEventListener("super-schema:save-flash", flash);
    try {
      const refused = vi.fn<SaveDocument>().mockResolvedValue({ success: false, error: "no", code: "VALIDATION_ERROR" });
      const { probe, unmount } = renderBuilder({ saveDocument: refused });
      await act(async () => { press({ metaKey: true }); });
      expect(flash).not.toHaveBeenCalled(); // clean draft
      type(field("Title"), "Changed");
      await act(async () => { press({ metaKey: true }); });
      expect(refused).toHaveBeenCalledTimes(1);
      expect(flash).not.toHaveBeenCalled(); // refused
      unmount();
      const ok = renderBuilder();
      type(field("Title"), "Changed again");
      await act(async () => { press({ metaKey: true }); });
      expect(ok.probe.saveDocument).toHaveBeenCalledTimes(1);
      expect(flash).toHaveBeenCalledTimes(1);
      expect(probe).toBeDefined();
    } finally {
      document.removeEventListener("super-schema:save-flash", flash);
    }
  });

  it("stops listening when the builder goes away", async () => {
    const { probe, unmount } = renderBuilder();
    type(field("Title"), "Changed");
    unmount();
    await act(async () => { press({ metaKey: true }); });
    expect(probe.saveDocument).not.toHaveBeenCalled();
  });
});

describe("EventBuilder: jump palette", () => {
  // cmdk measures its list and scrolls the selected item into view; jsdom has neither.
  beforeEach(() => {
    globalThis.ResizeObserver ??= class { observe() { /* no layout */ } unobserve() { /* no layout */ } disconnect() { /* no layout */ } } as unknown as typeof ResizeObserver;
    Element.prototype.scrollIntoView ??= () => undefined;
  });
  const palette = () => screen.findByRole("dialog");
  const pressJ = (init: KeyboardEventInit = { metaKey: true }) => fireEvent.keyDown(document, { key: "j", ...init });

  it("opens from the Jump to button, which names the shortcut", async () => {
    renderBuilder();
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(button("jump-open").textContent).toContain("Jump to");
    expect(button("jump-open").textContent).toContain("⌘J");
    click("jump-open");
    expect(await palette()).toBeDefined();
  });

  it("opens and closes with Cmd+J and Ctrl+J, and takes the key from the browser", async () => {
    renderBuilder();
    let notPrevented = true;
    await act(async () => { notPrevented = pressJ({ metaKey: true }); });
    expect(notPrevented).toBe(false);
    expect(await palette()).toBeDefined();
    await act(async () => { pressJ({ ctrlKey: true }); });
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("does not answer Mod+J while the Design tab is hidden", async () => {
    renderBuilder({ active: false });
    let notPrevented = false;
    await act(async () => { notPrevented = pressJ(); });
    expect(notPrevented).toBe(true);
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("does not answer Mod+K, which belongs to the app's own palette", async () => {
    renderBuilder();
    let notPrevented = false;
    await act(async () => { notPrevented = fireEvent.keyDown(document, { key: "k", metaKey: true }); });
    expect(notPrevented).toBe(true);
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("jumps to a section, or to an item in a section, and closes", async () => {
    const { probe } = renderBuilder({ section: "metadata" });
    click("jump-open");
    fireEvent.click(within(await palette()).getByText("kafka-dev"));
    expect(probe.section).toBe("servers");
    expect(probe.item).toBe("kafka-dev");
    expect(screen.queryByRole("dialog")).toBeNull();

    pressJ();
    fireEvent.click(within(await palette()).getAllByRole("option").find((o) => o.textContent === "Operations") as HTMLElement);
    expect(probe.section).toBe("operations");
    expect(probe.item).toBeNull();
  });

  it("marks the entries that have problems", async () => {
    const doc = sampleDocument();
    doc.servers[1] = { ...doc.servers[1], host: "not a host" };
    renderBuilder({ doc });
    click("jump-open");
    const entry = within(await palette()).getByText("kafka-dev").closest("[role=option]") as HTMLElement;
    expect(entry.getAttribute("aria-label")).toBe("kafka-dev, 1 problem");
  });
});

describe("EventBuilder: save bar in a narrow pane", () => {
  it("wraps instead of running past the edge: status, problem count and buttons may take a second line", () => {
    renderBuilder();
    const bar = screen.getByTestId("builder-bar");
    expect(bar.className).toContain("flex-wrap");
    expect(bar.className).not.toContain("@");
  });
});

describe("EventBuilder: problem count", () => {
  it("is absent while the draft has no problems", () => {
    renderBuilder();
    expect(screen.queryByTestId("builder-problems")).toBeNull();
  });

  it("counts the problems in the save bar, and a click goes to the first one", () => {
    const doc = sampleDocument();
    doc.servers[1] = { ...doc.servers[1], host: "not a host" };
    doc.channels[0] = { ...doc.channels[0], serverKeys: ["kafka-gone"] };
    const { probe } = renderBuilder({ doc, section: "metadata" });
    const problems = probe.draft.problems.length;
    expect(problems).toBeGreaterThan(1);
    expect(text("builder-problems")).toBe(`${problems} problems`);
    click("builder-problems");
    const first = probe.draft.problems[0].pointer;
    expect(first.startsWith("/servers/1") || first.startsWith("/channels/0")).toBe(true);
    expect(probe.section).toBe(first.startsWith("/servers/1") ? "servers" : "channels");
    expect(probe.item).toBe(first.startsWith("/servers/1") ? "kafka-dev" : "orders");
  });

  it("says '1 problem' for one", () => {
    const doc = sampleDocument();
    doc.servers[1] = { ...doc.servers[1], host: "not a host" };
    renderBuilder({ doc });
    expect(text("builder-problems")).toBe("1 problem");
  });
});

describe("EventBuilder: save bar", () => {
  it("starts clean with Save and Discard disabled", () => {
    renderBuilder();
    expect(button("builder-save").disabled).toBe(true);
    expect(button("builder-discard").disabled).toBe(true);
    expect(status()).toBe("No unsaved changes");
  });

  it("a Metadata edit marks the draft dirty and enables Save and Discard", () => {
    renderBuilder();
    type(field("Title"), "Orders v2");
    expect(button("builder-save").disabled).toBe(false);
    expect(button("builder-discard").disabled).toBe(false);
    expect(status()).toBe("Unsaved changes");
  });

  it("Save calls the action with the edited document, then the draft is clean again", async () => {
    const { probe } = renderBuilder();
    type(field("Title"), "Orders v2");
    await act(async () => { fireEvent.click(button("builder-save")); });
    expect(probe.saveDocument).toHaveBeenCalledTimes(1);
    expect(probe.saveDocument).toHaveBeenCalledWith("ev1", "p1", expect.objectContaining({ info: { title: "Orders v2", description: "Order events" } }));
    expect(button("builder-save").disabled).toBe(true);
    expect(status()).toBe("No unsaved changes");
    expect(screen.queryByTestId("builder-error")).toBeNull();
  });

  it("disables Save and Discard while a save is in flight", async () => {
    const gate = deferred<ActionResult<EventDetail>>();
    const saveDocument = vi.fn<SaveDocument>().mockReturnValue(gate.promise);
    renderBuilder({ saveDocument });
    type(field("Title"), "Orders v2");
    await act(async () => { fireEvent.click(button("builder-save")); });
    expect(button("builder-save").disabled).toBe(true);
    expect(button("builder-discard").disabled).toBe(true);
    expect(status()).toBe("Saving…");
    await act(async () => { gate.resolve({ success: true, data: makeEvent() }); });
    expect(status()).toBe("No unsaved changes");
  });

  it("Discard restores the last saved document", () => {
    const { probe } = renderBuilder();
    type(field("Title"), "Orders v2");
    click("builder-discard");
    expect(field("Title").value).toBe("Orders");
    expect(probe.draft.dirty).toBe(false);
    expect(button("builder-save").disabled).toBe(true);
  });

  it("a failed save keeps the edits, shows the error in an alert and the problems next to their fields", async () => {
    const saveDocument = vi.fn<SaveDocument>().mockResolvedValue({
      success: false, error: "1 problem(s) in the event document", code: "VALIDATION_ERROR",
      details: { problems: [{ pointer: "/servers/0/host", message: HOST_MESSAGE }] },
    });
    const { probe } = renderBuilder({ saveDocument, section: "servers", item: "kafka-prod" });
    type(field("Host"), "kafka://prod");
    await act(async () => { fireEvent.click(button("builder-save")); });

    const alert = screen.getByRole("alert");
    expect(alert.getAttribute("data-testid")).toBe("builder-error");
    expect(alert.textContent).toContain("1 problem(s) in the event document");
    // The client and the server report the same problem: the message sits next to the field exactly once.
    const inline = screen.getByText(HOST_MESSAGE);
    expect(inline.id).toBe("server-host-error");
    expect(field("Host").getAttribute("aria-describedby")).toContain("server-host-error");
    expect(field("Host").getAttribute("aria-invalid")).toBe("true");
    expect(field("Host").value).toBe("kafka://prod");
    expect(probe.draft.dirty).toBe(true);
    expect(button("builder-save").disabled).toBe(false);
  });

  it("lists the problems of a failed save and jumps to the field's section and item", async () => {
    const saveDocument = vi.fn<SaveDocument>().mockResolvedValue({
      success: false, error: "2 problem(s) in the event document", code: "VALIDATION_ERROR",
      details: { problems: [
        { pointer: "/servers/1/host", message: "host is required" },
        { pointer: "/info/title", message: "title is required" },
        { pointer: "/documentVersion", message: "documentVersion must be 2" },
      ] },
    });
    const { probe } = renderBuilder({ saveDocument });
    type(field("Description"), "Changed");
    await act(async () => { fireEvent.click(button("builder-save")); });
    const alert = within(screen.getByRole("alert"));
    expect(alert.getByRole("button", { name: "Metadata: title is required" })).toBeDefined();
    expect(alert.getByText("/documentVersion: documentVersion must be 2")).toBeDefined();
    fireEvent.click(alert.getByRole("button", { name: "Servers · kafka-dev: host is required" }));
    expect(probe.section).toBe("servers");
    expect(probe.item).toBe("kafka-dev");
    expect(screen.getByTestId("section-servers")).toBeDefined();
    expect(button("outline-servers").getAttribute("aria-current")).toBe("true");
  });

  it("clears the alert on the next edit", async () => {
    const saveDocument = vi.fn<SaveDocument>().mockResolvedValue({ success: false, error: "You do not have access to this event", code: "FORBIDDEN" });
    renderBuilder({ saveDocument });
    type(field("Title"), "Orders v2");
    await act(async () => { fireEvent.click(button("builder-save")); });
    expect(screen.getByRole("alert").textContent).toContain("You do not have access to this event");
    type(field("Title"), "Orders v3");
    expect(screen.queryByRole("alert")).toBeNull();
  });

  it("an empty draft saves: Save is never blocked by client problems", async () => {
    const { probe } = renderBuilder({ doc: emptyEventDocument("Orders") });
    type(field("Title"), "");
    expect(button("builder-save").disabled).toBe(false);
    await act(async () => { fireEvent.click(button("builder-save")); });
    expect(probe.saveDocument).toHaveBeenCalledTimes(1);
  });
});

describe("MetadataSection", () => {
  it("edits the title, description and default content type", () => {
    const { probe } = renderBuilder();
    type(field("Title"), "Order events API");
    type(field("Description"), "Everything about orders");
    type(field("Default content type"), "application/json");
    expect(probe.draft.doc.info).toEqual({ title: "Order events API", description: "Everything about orders" });
    expect(probe.draft.doc.defaultContentType).toBe("application/json");
  });

  it("removes the optional keys when they are blanked instead of saving empty strings", () => {
    const { probe } = renderBuilder({ doc: { ...sampleDocument(), defaultContentType: "application/json" } });
    type(field("Description"), "");
    type(field("Default content type"), "");
    expect("description" in probe.draft.doc.info).toBe(false);
    expect("defaultContentType" in probe.draft.doc).toBe(false);
    expect(probe.draft.problems).toEqual([]);
  });

  it("shows the fields it used to hide (contact, tags) and keeps them when it edits the title", () => {
    const doc = sampleDocument();
    doc.info = { ...doc.info, contact: { name: "Payments team" }, tags: [{ name: "orders" }] };
    const { probe } = renderBuilder({ doc });
    // Set values open the "More properties" group by themselves.
    expect(box("metadata-contact-name").value).toBe("Payments team");
    expect(screen.getByTestId("metadata-tags-chip-0").textContent).toContain("orders");
    type(field("Title"), "Orders v2");
    expect(probe.draft.doc.info).toEqual({ title: "Orders v2", description: "Order events", contact: { name: "Payments team" }, tags: [{ name: "orders" }] });
  });

  it("keeps properties it has no field for (x- extensions) untouched", () => {
    const doc = sampleDocument();
    (doc.info as Record<string, unknown>)["x-owner"] = "payments";
    const { probe } = renderBuilder({ doc });
    expect(screen.getByTestId("metadata-other").textContent).toContain("x-owner");
    type(field("Title"), "Orders v2");
    expect((probe.draft.doc.info as Record<string, unknown>)["x-owner"]).toBe("payments");
  });

  it("shows an empty title as an inline error linked to the input with aria-describedby", () => {
    renderBuilder();
    expect(screen.queryByTestId("metadata-title-error")).toBeNull();
    type(field("Title"), "");
    const error = screen.getByTestId("metadata-title-error");
    expect(error.textContent).toBe("title is required");
    expect(field("Title").getAttribute("aria-invalid")).toBe("true");
    expect((field("Title").getAttribute("aria-describedby") ?? "").split(" ")).toContain(error.id);
    type(field("Title"), "Orders");
    expect(screen.queryByTestId("metadata-title-error")).toBeNull();
    expect(field("Title").hasAttribute("aria-invalid")).toBe(false);
  });

  it("marks the title as required and offers no version (it is set when the event is published)", () => {
    renderBuilder();
    expect(screen.getByTestId("metadata-title-required")).toBeDefined();
    expect(screen.queryByLabelText(/^version$/i)).toBeNull();
    expect(screen.queryByTestId("metadata-version")).toBeNull();
  });

  it("offers the common media types for the default content type", () => {
    renderBuilder();
    const listId = field("Default content type").getAttribute("list");
    expect(listId).toBeTruthy();
    const options = Array.from(document.getElementById(listId as string)?.querySelectorAll("option") ?? []).map((o) => o.getAttribute("value"));
    expect(options).toContain("application/json");
    expect(options).toContain("application/avro");
  });

  it("keeps everything but the basics under a collapsed 'More properties (0 set)'", () => {
    renderBuilder();
    expect(screen.getByTestId("metadata-more-toggle").textContent).toBe("More properties (0 set)");
    expect(screen.getByTestId("metadata-more-toggle").getAttribute("aria-expanded")).toBe("false");
    expect(screen.queryByTestId("metadata-contact")).toBeNull();
    fireEvent.click(screen.getByTestId("metadata-more-toggle"));
    expect(screen.getByTestId("metadata-contact")).toBeDefined();
  });

  it("every property of the AsyncAPI info object is reachable once 'More properties' is open", () => {
    renderBuilder();
    fireEvent.click(screen.getByTestId("metadata-more-toggle"));
    for (const f of TEMPLATES.info.fields) expect(screen.queryByTestId(`metadata-${f.key}`), `info.${f.key}`).not.toBeNull();
    expect(TEMPLATES.info.fields.map((f) => f.key)).toEqual(["title", "description", "termsOfService", "contact", "license", "tags", "externalDocs"]);
    expect(screen.queryByTestId("metadata-defaultContentType")).not.toBeNull();
  });

  it("writes contact, license, terms of service and external docs into info, and removes them when emptied", () => {
    const { probe } = renderBuilder();
    fireEvent.click(screen.getByTestId("metadata-more-toggle"));
    type(box("metadata-termsOfService"), "https://example.com/terms");
    type(box("metadata-contact-email"), "support@example.com");
    type(box("metadata-license-name"), "Apache 2.0");
    type(box("metadata-externalDocs-url"), "https://example.com/docs");
    expect(probe.draft.doc.info).toEqual({
      title: "Orders", description: "Order events", termsOfService: "https://example.com/terms",
      contact: { email: "support@example.com" }, license: { name: "Apache 2.0" }, externalDocs: { url: "https://example.com/docs" },
    });
    expect(probe.draft.problems).toEqual([]);
    type(box("metadata-contact-email"), "");
    type(box("metadata-externalDocs-url"), "");
    type(box("metadata-termsOfService"), "");
    expect(probe.draft.doc.info).toEqual({ title: "Orders", description: "Order events", license: { name: "Apache 2.0" } });
  });

  it("adds a tag by typing its name", () => {
    const { probe } = renderBuilder();
    fireEvent.click(screen.getByTestId("metadata-more-toggle"));
    type(box("metadata-tags"), "orders");
    fireEvent.keyDown(box("metadata-tags"), { key: "Enter" });
    expect(probe.draft.doc.info.tags).toEqual([{ name: "orders" }]);
  });

  it("a document with only the title still parses (nothing the user never opened is required)", () => {
    const { probe } = renderBuilder({ doc: emptyEventDocument("Orders") });
    type(field("Title"), "Order events");
    expect(probe.draft.doc.info).toEqual({ title: "Order events" });
    expect(parseEventDocument(probe.draft.doc).success).toBe(true);
    expect(probe.draft.problems).toEqual([]);
  });

  it("shows a problem in a nested property under that property, not under the title", () => {
    const { probe } = renderBuilder();
    fireEvent.click(screen.getByTestId("metadata-more-toggle"));
    type(box("metadata-contact-email"), "not-an-email");
    const problem = probe.draft.problems.find((p) => p.pointer === "/info/contact/email");
    expect(problem).toBeDefined();
    expect(screen.getByTestId("metadata-contact-email-error").textContent).toBe(problem!.message);
    expect(screen.queryByTestId("metadata-title-error")).toBeNull();
  });

  it("shows the problems of a failed save next to their fields and opens 'More properties' for them", async () => {
    const saveDocument = vi.fn<SaveDocument>().mockResolvedValue({
      success: false, error: "1 problem(s) in the event document", code: "VALIDATION_ERROR",
      details: { problems: [{ pointer: "/info/termsOfService", message: "termsOfService must be a URL" }] },
    });
    renderBuilder({ saveDocument });
    type(field("Title"), "Orders v2");
    await act(async () => { fireEvent.click(button("builder-save")); });
    expect(screen.getByTestId("metadata-termsOfService-error").textContent).toBe("termsOfService must be a URL");
    expect(box("metadata-termsOfService").getAttribute("aria-invalid")).toBe("true");
  });

  it("shows a problem with the default content type under it", async () => {
    const saveDocument = vi.fn<SaveDocument>().mockResolvedValue({
      success: false, error: "1 problem(s) in the event document", code: "VALIDATION_ERROR",
      details: { problems: [{ pointer: "/defaultContentType", message: "defaultContentType must be a media type" }] },
    });
    renderBuilder({ saveDocument });
    type(field("Title"), "Orders v2");
    await act(async () => { fireEvent.click(button("builder-save")); });
    expect(screen.getByTestId("metadata-defaultContentType-error").textContent).toBe("defaultContentType must be a media type");
  });
});

describe("ServersSection", () => {
  const rowLabel = (key: string) => screen.getByTestId(`server-row-${key}`).getAttribute("title") ?? "";

  it("lists the servers by title (else host) with the protocol under it", () => {
    const doc = sampleDocument();
    doc.servers[1] = { ...doc.servers[1], title: "Dev cluster" };
    renderBuilder({ doc, section: "servers" });
    expect(rowLabel("kafka-prod")).toContain("prod.internal:9092");
    expect(rowLabel("kafka-prod")).toContain("kafka");
    expect(rowLabel("kafka-dev")).toContain("Dev cluster");
    expect(rowLabel("kafka-dev")).not.toContain("dev.internal:9092");
    // The key is not what the list shows.
    expect(rowLabel("kafka-prod")).not.toContain("kafka-prod");
  });

  it("shows the first server's form and selects another on click", () => {
    renderBuilder({ section: "servers" });
    expect(screen.getByTestId("server-row-kafka-prod").getAttribute("aria-current")).toBe("true");
    expect(box("server-host").value).toBe("prod.internal:9092");
    click("server-row-kafka-dev");
    expect(screen.getByTestId("server-row-kafka-dev").getAttribute("aria-current")).toBe("true");
    expect(screen.getByTestId("server-row-kafka-prod").hasAttribute("aria-current")).toBe(false);
    expect(box("server-host").value).toBe("dev.internal:9092");
  });

  it("opens the server named by the selected item and falls back to the first when it is gone", () => {
    renderBuilder({ section: "servers", item: "kafka-dev" });
    expect(box("server-host").value).toBe("dev.internal:9092");
    cleanup();
    renderBuilder({ section: "servers", item: "gone" });
    expect(box("server-host").value).toBe("prod.internal:9092");
  });

  it("has no Key field in the form: the identifier is generated and tucked away", () => {
    renderBuilder({ section: "servers" });
    expect(screen.queryByLabelText("Key")).toBeNull();
    const disclosure = screen.getByTestId("server-key-disclosure") as HTMLDetailsElement;
    expect(disclosure.open).toBe(false);
    expect(screen.getByTestId("server-key-value").textContent).toBe("kafka-prod");
    expect(screen.getByTestId("server-form").contains(disclosure)).toBe(true);
  });

  it("edits protocol, host, path and description of the selected server only", () => {
    const { probe } = renderBuilder({ section: "servers", item: "kafka-dev" });
    type(box("server-protocol"), "amqp");
    type(field("Host"), "amqp.dev:5672");
    type(field("Path"), "/vhost");
    type(field("Description"), "Dev broker");
    expect(probe.draft.doc.servers[1]).toEqual({ key: "kafka-dev", protocol: "amqp", host: "amqp.dev:5672", pathname: "/vhost", description: "Dev broker" });
    expect(probe.draft.doc.servers[0]).toEqual({ key: "kafka-prod", protocol: "kafka", host: "prod.internal:9092" });
    type(field("Path"), "");
    type(field("Description"), "");
    expect(probe.draft.doc.servers[1]).toEqual({ key: "kafka-dev", protocol: "amqp", host: "amqp.dev:5672" });
  });

  it("keeps protocol and host as empty strings when they are cleared, so the document keeps its shape", () => {
    const { probe } = renderBuilder({ section: "servers", item: "kafka-dev" });
    type(field("Host"), "");
    type(box("server-protocol"), "");
    expect(probe.draft.doc.servers[1]).toEqual({ key: "kafka-dev", protocol: "", host: "" });
    expect(screen.getByTestId("server-host-error").textContent).toBe("host is required");
  });

  it("edits title, protocol version and summary", () => {
    const { probe } = renderBuilder({ section: "servers", item: "kafka-dev" });
    type(field("Title"), "Dev cluster");
    type(field("Protocol version"), "3.7");
    fireEvent.click(screen.getByTestId("server-more-toggle"));
    type(field("Summary"), "The dev cluster");
    expect(probe.draft.doc.servers[1]).toMatchObject({ title: "Dev cluster", protocolVersion: "3.7", summary: "The dev cluster" });
    expect(probe.draft.problems).toEqual([]);
  });

  it("suggests the known protocols", () => {
    renderBuilder({ section: "servers" });
    const listId = box("server-protocol").getAttribute("list") as string;
    const options = Array.from(document.getElementById(listId)?.querySelectorAll("option") ?? []).map((o) => o.getAttribute("value"));
    expect(options).toEqual(expect.arrayContaining(["kafka", "amqp", "mqtt"]));
  });

  it("shows field errors from the parser next to the host and path", () => {
    renderBuilder({ section: "servers", item: "kafka-dev" });
    type(field("Host"), "has space");
    type(field("Path"), "no-slash");
    expect(screen.getByTestId("server-host-error").textContent).toBe(HOST_MESSAGE);
    expect(screen.getByTestId("server-pathname-error").textContent).toBe('pathname must start with "/"');
    expect(screen.getByTestId("server-row-kafka-dev").textContent).toContain("problem");
  });

  it("does not show the problems of another server", () => {
    const doc = sampleDocument();
    doc.servers[1] = { ...doc.servers[1], host: "" };
    renderBuilder({ doc, section: "servers" });
    expect(screen.queryByTestId("server-host-error")).toBeNull();
    click("server-row-kafka-dev");
    expect(screen.getByTestId("server-host-error").textContent).toBe("host is required");
  });

  describe("adding and generated keys", () => {
    it("Add server creates a blank server with a placeholder key, selects it, and keeps placeholders unique", () => {
      const { probe } = renderBuilder({ section: "servers" });
      click("server-add");
      expect(probe.draft.doc.servers.map((s) => s.key)).toEqual(["kafka-prod", "kafka-dev", "server"]);
      expect(probe.draft.doc.servers[2]).toEqual({ key: "server", protocol: "kafka", host: "" });
      expect(probe.item).toBe("server");
      expect(screen.getByTestId("server-key-value").textContent).toBe("server");
      expect(screen.getByTestId("server-host-error").textContent).toBe("host is required");
      click("server-add");
      expect(probe.draft.doc.servers.map((s) => s.key)).toEqual(["kafka-prod", "kafka-dev", "server", "server-2"]);
      expect(probe.item).toBe("server-2");
      expect(probe.draft.dirty).toBe(true);
    });

    it("a blank new server does not block saving", async () => {
      const { probe } = renderBuilder({ section: "servers" });
      click("server-add");
      expect(button("builder-save").disabled).toBe(false);
      await act(async () => { click("builder-save"); });
      expect(probe.saveDocument).toHaveBeenCalledTimes(1);
    });

    it("names the key from the host once the user leaves the field, and keeps the server selected", () => {
      const { probe } = renderBuilder({ section: "servers" });
      click("server-add");
      type(field("Host"), "broker.example.com:9092");
      // While typing the key does not move under the user's hands.
      expect(probe.draft.doc.servers[2].key).toBe("server");
      fireEvent.blur(field("Host"));
      expect(probe.draft.doc.servers[2].key).toBe("broker.example.com-9092");
      expect(probe.item).toBe("broker.example.com-9092");
      expect(screen.getByTestId("server-row-broker.example.com-9092").getAttribute("aria-current")).toBe("true");
      expect(screen.getByTestId("server-key-value").textContent).toBe("broker.example.com-9092");
      expect(box("server-host").value).toBe("broker.example.com:9092");
    });

    it("prefers the title over the host, whichever the user fills first", () => {
      const { probe } = renderBuilder({ section: "servers" });
      click("server-add");
      type(field("Host"), "broker.example.com:9092");
      type(field("Title"), "Production Kafka");
      fireEvent.blur(field("Title"));
      expect(probe.draft.doc.servers[2].key).toBe("Production-Kafka");
      click("server-add");
      type(field("Title"), "Staging Kafka");
      type(field("Host"), "staging.example.com:9092");
      fireEvent.blur(field("Host"));
      expect(probe.draft.doc.servers[3].key).toBe("Staging-Kafka");
    });

    it("waits while focus only moves between fields of the form, and names the key when focus leaves it", () => {
      const { probe } = renderBuilder({ section: "servers" });
      click("server-add");
      type(field("Host"), "broker.example.com:9092");
      fireEvent.blur(field("Host"), { relatedTarget: field("Title") });
      expect(probe.draft.doc.servers[2].key).toBe("server");
      fireEvent.blur(field("Title"), { relatedTarget: screen.getByTestId("server-more-toggle") });
      expect(probe.draft.doc.servers[2].key).toBe("server");
      fireEvent.blur(field("Title"), { relatedTarget: button("builder-save") });
      expect(probe.draft.doc.servers[2].key).toBe("broker.example.com-9092");
    });

    it("leaves the placeholder alone while there is nothing to name the server by", () => {
      const { probe } = renderBuilder({ section: "servers" });
      click("server-add");
      fireEvent.blur(field("Host"));
      type(field("Description"), "later");
      fireEvent.blur(field("Description"));
      expect(probe.draft.doc.servers[2].key).toBe("server");
    });

    it("renames only once: editing the host again never changes the generated key", () => {
      const { probe } = renderBuilder({ section: "servers" });
      click("server-add");
      type(field("Host"), "a.example.com:1");
      fireEvent.blur(field("Host"));
      type(field("Host"), "b.example.com:2");
      fireEvent.blur(field("Host"));
      type(field("Title"), "Prod");
      fireEvent.blur(field("Title"));
      expect(probe.draft.doc.servers[2].key).toBe("a.example.com-1");
      expect(probe.item).toBe("a.example.com-1");
    });

    it("never renames a key the document already had (editing protocol or host)", () => {
      const { probe } = renderBuilder({ section: "servers", item: "kafka-prod" });
      type(box("server-protocol"), "amqp");
      type(field("Host"), "other:5672");
      fireEvent.blur(field("Host"));
      expect(probe.draft.doc.servers[0].key).toBe("kafka-prod");
      expect(probe.draft.doc.channels[0].serverKeys).toEqual(["kafka-prod"]);
    });

    it("gives two servers with the same host distinct keys", () => {
      const { probe } = renderBuilder({ doc: emptyEventDocument("Orders"), section: "servers" });
      click("server-empty-add");
      type(field("Host"), "broker.example.com:9092");
      fireEvent.blur(field("Host"));
      click("server-add");
      type(field("Host"), "broker.example.com:9092");
      fireEvent.blur(field("Host"));
      expect(probe.draft.doc.servers.map((s) => s.key)).toEqual(["broker.example.com-9092", "broker.example.com-9092-2"]);
      expect(probe.item).toBe("broker.example.com-9092-2");
      expect(screen.getByTestId("server-row-broker.example.com-9092-2").getAttribute("aria-current")).toBe("true");
    });

    it("gives two servers with the same title distinct keys", () => {
      const { probe } = renderBuilder({ doc: emptyEventDocument("Orders"), section: "servers" });
      for (let i = 0; i < 2; i += 1) {
        click(i === 0 ? "server-empty-add" : "server-add");
        type(field("Title"), "Prod");
        fireEvent.blur(field("Title"));
      }
      expect(probe.draft.doc.servers.map((s) => s.key)).toEqual(["Prod", "Prod-2"]);
    });

    it("the automatic rename rewrites the channels that already point at the placeholder", () => {
      const doc = sampleDocument();
      doc.servers = [{ key: "server", protocol: "kafka", host: "" }, doc.servers[1]];
      doc.channels[0].serverKeys = ["server"];
      doc.channels[1].serverKeys = ["server", "kafka-dev"];
      const { probe } = renderBuilder({ doc, section: "servers" });
      type(field("Host"), "prod.internal:9092");
      fireEvent.blur(field("Host"));
      expect(probe.draft.doc.servers[0].key).toBe("prod.internal-9092");
      expect(probe.draft.doc.channels.map((c) => c.serverKeys)).toEqual([["prod.internal-9092"], ["prod.internal-9092", "kafka-dev"]]);
      expect(probe.draft.problems).toEqual([]);
    });

    it("blurring the Identifier input itself does not trigger the automatic rename over the user's choice", () => {
      const doc = sampleDocument();
      doc.servers = [{ key: "server", protocol: "kafka", host: "x.example.com:1" }, doc.servers[1]];
      doc.channels[0].serverKeys = [];
      doc.channels[1].serverKeys = [];
      const { probe } = renderBuilder({ doc, section: "servers" });
      type(box("server-key"), "my-kafka");
      fireEvent.blur(box("server-key"));
      expect(probe.draft.doc.servers[0].key).toBe("my-kafka");
      expect(probe.item).toBe("my-kafka");
    });
  });

  describe("the Identifier", () => {
    it("renaming it rewrites the channel references, keeps the server selected and rejects a taken key", () => {
      const { probe } = renderBuilder({ section: "servers", item: "kafka-prod" });
      type(box("server-key"), "kafka-dev");
      fireEvent.blur(box("server-key"));
      expect(screen.getByTestId("server-key-error").textContent).toBe('The key "kafka-dev" is already used.');
      expect(probe.draft.dirty).toBe(false);
      type(box("server-key"), "kafka-primary");
      fireEvent.blur(box("server-key"));
      expect(probe.draft.doc.servers[0].key).toBe("kafka-primary");
      expect(probe.draft.doc.channels.map((c) => c.serverKeys)).toEqual([["kafka-primary"], ["kafka-primary", "kafka-dev"]]);
      expect(probe.item).toBe("kafka-primary");
      expect(screen.getByTestId("server-row-kafka-primary").getAttribute("aria-current")).toBe("true");
      expect(probe.draft.problems).toEqual([]);
    });

    it("a manually chosen identifier is never replaced by a generated one", () => {
      const { probe } = renderBuilder({ section: "servers" });
      click("server-add");
      type(box("server-key"), "mine");
      fireEvent.blur(box("server-key"));
      type(field("Host"), "broker.example.com:9092");
      fireEvent.blur(field("Host"));
      expect(probe.draft.doc.servers[2].key).toBe("mine");
    });
  });

  it("shows an empty state with the primary action when there are no servers", () => {
    const { probe } = renderBuilder({ doc: emptyEventDocument("Orders"), section: "servers" });
    const empty = screen.getByTestId("server-empty");
    expect(empty.textContent).toContain("No servers yet");
    fireEvent.click(within(empty).getByRole("button", { name: "Add server" }));
    expect(probe.draft.doc.servers).toHaveLength(1);
    expect(screen.queryByTestId("server-empty")).toBeNull();
  });

  describe("removing", () => {
    it("removes a server nothing refers to without asking", () => {
      const confirm = vi.spyOn(window, "confirm").mockReturnValue(true);
      const { probe } = renderBuilder({ section: "servers" });
      click("server-add");
      click("server-remove");
      expect(confirm).not.toHaveBeenCalled();
      expect(probe.draft.doc.servers.map((s) => s.key)).toEqual(["kafka-prod", "kafka-dev"]);
      expect(probe.item).toBeNull();
      expect(box("server-host").value).toBe("prod.internal:9092");
    });

    it("asks before removing a server that channels use, then removes it from every channels[].serverKeys", () => {
      const confirm = vi.spyOn(window, "confirm").mockReturnValue(true);
      const { probe } = renderBuilder({ section: "servers", item: "kafka-prod" });
      click("server-remove");
      expect(confirm).toHaveBeenCalledTimes(1);
      expect(confirm.mock.calls[0][0]).toContain('"kafka-prod"');
      expect(confirm.mock.calls[0][0]).toContain("2 channels");
      expect(confirm.mock.calls[0][0]).toContain("orders");
      expect(confirm.mock.calls[0][0]).toContain("refunds");
      expect(probe.draft.doc.servers.map((s) => s.key)).toEqual(["kafka-dev"]);
      expect(probe.draft.doc.channels.map((c) => c.serverKeys)).toEqual([[], ["kafka-dev"]]);
      expect(probe.draft.problems).toEqual([]);
    });

    it("changes nothing when the confirmation is declined", () => {
      vi.spyOn(window, "confirm").mockReturnValue(false);
      const { probe } = renderBuilder({ section: "servers", item: "kafka-prod" });
      click("server-remove");
      expect(probe.draft.doc).toEqual(sampleDocument());
      expect(probe.draft.dirty).toBe(false);
    });

    it("leaves other servers' references alone when a different server is removed", () => {
      vi.spyOn(window, "confirm").mockReturnValue(true);
      const { probe } = renderBuilder({ section: "servers", item: "kafka-dev" });
      click("server-remove");
      expect(probe.draft.doc.servers.map((s) => s.key)).toEqual(["kafka-prod"]);
      expect(probe.draft.doc.channels.map((c) => c.serverKeys)).toEqual([["kafka-prod"], ["kafka-prod"]]);
    });
  });

  describe("variables, security and bindings (all the AsyncAPI server properties)", () => {
    it("adds a server variable by name and writes it as a map, removing the key when the last one goes", () => {
      const { probe } = renderBuilder({ section: "servers", item: "kafka-dev" });
      type(field("Host"), "{env}.kafka.example.com:9092");
      fireEvent.click(screen.getByTestId("server-more-toggle"));
      click("server-variables-add");
      type(box("server-variables-0-key"), "env");
      type(box("server-variables-0-default"), "prod");
      expect(probe.draft.doc.servers[1].variables).toEqual({ env: { default: "prod" } });
      expect(probe.draft.problems).toEqual([]);
      click("server-variables-0-remove");
      expect("variables" in probe.draft.doc.servers[1]).toBe(false);
    });

    it("reports a variable that the host never uses, under the variables", () => {
      const doc = sampleDocument();
      doc.servers[1] = { ...doc.servers[1], variables: { env: { default: "prod" } } };
      renderBuilder({ doc, section: "servers", item: "kafka-dev" });
      expect(screen.getByTestId("server-variables-0-error").textContent).toContain('Variable "env" does not appear as {env}');
      expect(screen.getByTestId("server-row-kafka-dev").textContent).toContain("problem");
    });

    it("lists the document's security schemes by key and writes the chosen ones to server.security", () => {
      const doc = sampleDocument();
      doc.components = { securitySchemes: { basic: { type: "userPassword" }, sasl: { type: "plain" } } };
      const { probe } = renderBuilder({ doc, section: "servers", item: "kafka-dev" });
      fireEvent.click(screen.getByTestId("server-more-toggle"));
      const group = screen.getByTestId("server-security");
      expect(Array.from(group.querySelectorAll("input[type=checkbox]")).map((i) => i.getAttribute("data-testid"))).toEqual([
        "server-security-option-basic", "server-security-option-sasl",
      ]);
      fireEvent.click(box("server-security-option-sasl"));
      expect(probe.draft.doc.servers[1].security).toEqual(["sasl"]);
      fireEvent.click(box("server-security-option-sasl"));
      expect("security" in probe.draft.doc.servers[1]).toBe(false);
    });

    it("says no security schemes are defined yet when the document has none", () => {
      renderBuilder({ section: "servers", item: "kafka-dev" });
      fireEvent.click(screen.getByTestId("server-more-toggle"));
      expect(screen.getByTestId("server-security-empty").textContent).toContain("No security schemes are defined yet");
    });

    it("edits bindings with the protocol's template, writes bindingVersion, and drops `bindings` when cleared", () => {
      const { probe } = renderBuilder({ section: "servers", item: "kafka-dev" });
      // The protocol of the server is preselected.
      expect((box("server-bindings-protocol") as unknown as HTMLSelectElement).value).toBe("kafka");
      click("server-bindings-add");
      type(box("server-bindings-kafka-schemaRegistryUrl"), "https://registry.example.com");
      expect(probe.draft.doc.servers[1].bindings).toEqual({
        kafka: { schemaRegistryUrl: "https://registry.example.com", bindingVersion: bindingVersion("kafka", "server") },
      });
      expect(probe.draft.problems).toEqual([]);
      type(box("server-bindings-kafka-schemaRegistryUrl"), "");
      expect("bindings" in probe.draft.doc.servers[1]).toBe(false);
    });

    it("keeps the bindings a server already has when something else is edited", () => {
      const doc = sampleDocument();
      doc.servers[1] = { ...doc.servers[1], bindings: { kafka: { schemaRegistryUrl: "https://r.example.com", bindingVersion: "0.5.0" } } };
      const { probe } = renderBuilder({ doc, section: "servers", item: "kafka-dev" });
      expect(box("server-bindings-kafka-schemaRegistryUrl").value).toBe("https://r.example.com");
      type(field("Title"), "Dev");
      expect(probe.draft.doc.servers[1].bindings).toEqual({ kafka: { schemaRegistryUrl: "https://r.example.com", bindingVersion: "0.5.0" } });
    });

    it("keeps properties the form has no field for (an infra-synced origin, an external reference)", () => {
      const doc = sampleDocument();
      doc.servers[1] = { ...doc.servers[1], origin: { provider: "infra", ref: "k-2", syncedAt: "2026-10-15T00:00:00Z" } };
      const { probe } = renderBuilder({ doc, section: "servers", item: "kafka-dev" });
      type(field("Title"), "Dev");
      expect(probe.draft.doc.servers[1].origin).toEqual({ provider: "infra", ref: "k-2", syncedAt: "2026-10-15T00:00:00Z" });
      expect(screen.queryByTestId("server-other")).toBeNull();
    });

    it("every property of the AsyncAPI server object is reachable once 'More properties' is open", () => {
      renderBuilder({ section: "servers" });
      fireEvent.click(screen.getByTestId("server-more-toggle"));
      const keys = TEMPLATES.server.fields.map((f) => f.key);
      expect(keys).toEqual(expect.arrayContaining(["host", "protocol", "protocolVersion", "pathname", "title", "summary", "description", "variables", "security", "tags", "externalDocs", "bindings"]));
      // `bindings` is the one property a protocol form draws instead of the generic template form.
      for (const key of keys) expect(screen.queryByTestId(`server-${key}`), `server.${key}`).not.toBeNull();
    });

    it("a server with only a protocol and a host still gives a valid document with no empty extras", () => {
      const { probe } = renderBuilder({ doc: emptyEventDocument("Orders"), section: "servers" });
      click("server-empty-add");
      type(field("Host"), "broker.example.com:9092");
      fireEvent.blur(field("Host"));
      expect(probe.draft.doc.servers).toEqual([{ key: "broker.example.com-9092", protocol: "kafka", host: "broker.example.com:9092" }]);
      expect(parseEventDocument(probe.draft.doc).success).toBe(true);
      expect(probe.draft.problems).toEqual([]);
    });
  });
});

describe("KeyInput", () => {
  function Harness({ onCommit, taken = ["other"], error, initial = "orders" }: { onCommit: (next: string) => void; taken?: string[]; error?: string; initial?: string }) {
    const [value, setValue] = useState(initial);
    return (
      <>
        <KeyInput id="the-key" label="Key" value={value} taken={taken} error={error} onCommit={(next) => { onCommit(next); setValue(next); }} />
        <button type="button" onClick={() => setValue("changed-outside")}>outside</button>
      </>
    );
  }
  const input = () => screen.getByLabelText("Key") as HTMLInputElement;

  it("commits a valid new key on blur", () => {
    const onCommit = vi.fn();
    render(<Harness onCommit={onCommit} />);
    type(input(), "orders-v2");
    expect(onCommit).not.toHaveBeenCalled();
    fireEvent.blur(input());
    expect(onCommit).toHaveBeenCalledWith("orders-v2");
    expect(screen.queryByTestId("the-key-error")).toBeNull();
  });

  it("commits on Enter without submitting an enclosing form", () => {
    const onCommit = vi.fn();
    const onSubmit = vi.fn((e: { preventDefault: () => void }) => e.preventDefault());
    render(<form onSubmit={onSubmit}><Harness onCommit={onCommit} /></form>);
    type(input(), "orders-v2");
    const notPrevented = fireEvent.keyDown(input(), { key: "Enter" });
    expect(onCommit).toHaveBeenCalledWith("orders-v2");
    expect(notPrevented).toBe(false);
  });

  it("rejects a key that is already taken, shows why, and does not commit", () => {
    const onCommit = vi.fn();
    render(<Harness onCommit={onCommit} taken={["other", "orders"]} />);
    type(input(), "other");
    expect(screen.getByTestId("the-key-error").textContent).toBe('The key "other" is already used.');
    expect(input().getAttribute("aria-invalid")).toBe("true");
    expect((input().getAttribute("aria-describedby") ?? "").split(" ")).toContain("the-key-error");
    fireEvent.blur(input());
    fireEvent.keyDown(input(), { key: "Enter" });
    expect(onCommit).not.toHaveBeenCalled();
    expect(input().value).toBe("other");
  });

  it("rejects a key containing a space and shows the rule", () => {
    const onCommit = vi.fn();
    render(<Harness onCommit={onCommit} />);
    type(input(), "has space");
    expect(screen.getByTestId("the-key-error").textContent).toBe('Use only letters, digits, ".", "_" and "-" (no spaces).');
    fireEvent.blur(input());
    expect(onCommit).not.toHaveBeenCalled();
  });

  it("rejects other characters, an empty key, an over-long key and a reserved name", () => {
    const onCommit = vi.fn();
    render(<Harness onCommit={onCommit} />);
    const error = () => screen.queryByTestId("the-key-error")?.textContent;
    type(input(), "a/b");
    expect(error()).toContain("Use only letters, digits");
    type(input(), "");
    expect(error()).toBe("A key is required.");
    type(input(), "x".repeat(65));
    expect(error()).toBe("A key can be at most 64 characters.");
    type(input(), "constructor");
    expect(error()).toBe('"constructor" is reserved. Choose another key.');
    // the AsyncAPI parser cannot read a key of this name (PARSER_UNSAFE_KEYS): refused at the field, case-sensitively
    type(input(), "hasOwnProperty");
    expect(error()).toBe('"hasOwnProperty" is a reserved name: AsyncAPI documents cannot contain it. Choose another key.');
    // `__proto__` is on the parser's list too (new wording); `constructor` is only a JS-prototype name (the old wording, above)
    type(input(), "__proto__");
    expect(error()).toBe('"__proto__" is a reserved name: AsyncAPI documents cannot contain it. Choose another key.');
    type(input(), "hasownproperty");
    expect(error()).toBeUndefined();
    type(input(), "x".repeat(64));
    expect(error()).toBeUndefined();
    fireEvent.blur(input());
    expect(onCommit).toHaveBeenCalledTimes(1);
  });

  it("does not commit an unchanged key and tolerates the key's own name in `taken`", () => {
    const onCommit = vi.fn();
    render(<Harness onCommit={onCommit} taken={["orders", "other"]} />);
    fireEvent.blur(input());
    fireEvent.keyDown(input(), { key: "Enter" });
    expect(onCommit).not.toHaveBeenCalled();
    expect(screen.queryByTestId("the-key-error")).toBeNull();
  });

  it("Escape puts the committed key back and clears the error", () => {
    render(<Harness onCommit={vi.fn()} />);
    type(input(), "bad key");
    expect(screen.queryByTestId("the-key-error")).not.toBeNull();
    fireEvent.keyDown(input(), { key: "Escape" });
    expect(input().value).toBe("orders");
    expect(screen.queryByTestId("the-key-error")).toBeNull();
  });

  it("follows the value when it changes from outside, and shows an error passed in by the parent", () => {
    render(<Harness onCommit={vi.fn()} error="Duplicate server key" />);
    expect(screen.getByTestId("the-key-error").textContent).toBe("Duplicate server key");
    fireEvent.click(screen.getByText("outside"));
    expect(input().value).toBe("changed-outside");
  });
});

describe("ServersSection: a new server starts focused", () => {
  it("puts the cursor in the host field after Add", () => {
    renderBuilder({ section: "servers" });
    click("server-add");
    expect(document.activeElement).toBe(field("Host"));
  });
});

describe("ServersSection: the item tab strip", () => {
  it("picks items from a tab strip with the add button pinned beside it, not in the header", () => {
    const { probe } = renderBuilder({ section: "servers" });
    const strip = screen.getByRole("tablist", { name: "Servers" });
    expect(within(strip).getAllByRole("tab").map((t) => t.getAttribute("data-testid"))).toEqual(["server-row-kafka-prod", "server-row-kafka-dev"]);
    expect(screen.getByTestId("server-row-kafka-prod").getAttribute("aria-current")).toBe("true");
    const add = screen.getByTestId("server-add");
    expect(strip.contains(add)).toBe(false);
    expect(screen.getAllByRole("button", { name: "Add server" })).toHaveLength(1);
    const before = probe.draft.doc.servers.length;
    fireEvent.click(add);
    expect(probe.draft.doc.servers).toHaveLength(before + 1);
    expect(probe.item).toBe(probe.draft.doc.servers[before].key);
  });

  it("keeps the section description in an info tip beside the heading", () => {
    renderBuilder({ section: "servers" });
    const tip = screen.getByTestId("servers-help");
    expect(tip.hasAttribute("hidden")).toBe(true);
    expect(tip.textContent).toContain("Where the brokers run");
    expect(screen.getByTestId("servers-help-button").getAttribute("aria-label")).toBe("About servers");
  });

  it("puts what the list row used to show under its name in the tab's title", () => {
    renderBuilder({ section: "servers" });
    expect(screen.getByTestId("server-row-kafka-prod").getAttribute("title")).toContain("kafka");
  });
});
