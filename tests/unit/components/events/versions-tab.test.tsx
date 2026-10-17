// @vitest-environment jsdom
import { useState } from "react";
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => ({ list: vi.fn(), read: vi.fn(), toastSuccess: vi.fn(), toastError: vi.fn() }));
vi.mock("sonner", () => ({ toast: { success: h.toastSuccess, error: h.toastError } }));
vi.mock("@/app/(dashboard)/schemas/[domainSlug]/[productSlug]/event-actions", () => ({
  listEventVersionsAction: h.list, readEventVersionAction: h.read,
}));

import { VersionsTab } from "@/features/events/event-page/VersionsTab";
import type { EventVersionSummary } from "@/lib/events/types";

const summary = (label: string, sequence: number, over: Partial<EventVersionSummary> = {}): EventVersionSummary => {
  const [major, minor] = label.split(".").map(Number);
  return {
    id: `v-${label}`, major, minor, label, sequence, changeKind: minor === 0 && major > 1 ? "MAJOR" : sequence === 1 ? "INITIAL" : "MINOR",
    changeSummary: null, publishedByName: "Ada", publishedAt: "2026-10-16T10:00:00.000Z", ...over,
  };
};
const V10 = summary("1.0", 1);
const V11 = summary("1.1", 2, { changeSummary: "Added a refund channel" });
const CODE = (label: string) => ({ yaml: `asyncapi: 3.0.0\ninfo:\n  version: ${label}\n`, json: `{"info":{"version":"${label}"}}` });

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((r) => { resolve = r; });
  return { promise, resolve };
}

/** The page owns the selected version (it writes ?version=); this stands in for it. */
function Harness({ latestLabel = "1.1", initialVersion = null, onVersion }: { latestLabel?: string | null; initialVersion?: string | null; onVersion?: (v: string | null) => void }) {
  const [version, setVersion] = useState<string | null>(initialVersion);
  return (
    <VersionsTab
      eventId="ev1" productId="p1" latestLabel={latestLabel} version={version}
      onVersionChange={(next) => { setVersion(next); onVersion?.(next); }}
    />
  );
}
const renderTab = (props: Parameters<typeof Harness>[0] = {}) => render(<Harness {...props} />);
const rows = () => within(screen.getByTestId("event-version-list")).getAllByRole("listitem");
const view = (label: string) => screen.getByRole("button", { name: `View v${label}` });
const codeText = () => (screen.getByTestId("event-version-code-text") as HTMLTextAreaElement).value;

beforeEach(() => {
  vi.clearAllMocks();
  h.list.mockResolvedValue({ success: true, data: [V11, V10] });
  h.read.mockImplementation(async (_e: string, _p: string, label: string) => ({ success: true, data: CODE(label) }));
});
afterEach(cleanup);

describe("VersionsTab: the list", () => {
  it("shows a loading state first, then asks for the event's versions once", async () => {
    const pending = deferred<unknown>();
    h.list.mockReturnValue(pending.promise);
    renderTab();
    expect(screen.getByTestId("event-versions-loading").textContent).toContain("Loading published versions");
    expect(h.list).toHaveBeenCalledTimes(1);
    expect(h.list).toHaveBeenCalledWith("ev1", "p1");
    await act(async () => { pending.resolve({ success: true, data: [V10] }); });
    expect(screen.queryByTestId("event-versions-loading")).toBeNull();
    expect(rows()).toHaveLength(1);
  });

  it("lists the versions newest first, each with its change kind, summary and publisher", async () => {
    renderTab();
    await screen.findByTestId("event-version-list");
    expect(rows().map((r) => r.textContent)).toEqual([
      expect.stringContaining("v1.1"), expect.stringContaining("v1.0"),
    ]);
    expect(rows()[0].textContent).toContain("MINOR");
    expect(rows()[0].textContent).toContain("Added a refund channel");
    expect(rows()[0].textContent).toContain("Ada");
    expect(rows()[1].textContent).toContain("INITIAL");
  });

  it("puts the newest first even when the action answers in another order", async () => {
    h.list.mockResolvedValue({ success: true, data: [V10, summary("2.0", 3), V11] });
    renderTab();
    await screen.findByTestId("event-version-list");
    expect(rows().map((r) => /v\d+\.\d+/.exec(r.textContent ?? "")?.[0])).toEqual(["v2.0", "v1.1", "v1.0"]);
  });

  it("says so for an event that was never published", async () => {
    h.list.mockResolvedValue({ success: true, data: [] });
    renderTab({ latestLabel: null });
    expect((await screen.findByTestId("event-version-list-empty")).textContent).toBe("Not published yet.");
    expect(screen.queryByTestId("event-version-code")).toBeNull();
  });

  it("shows the action's error instead of an empty list", async () => {
    h.list.mockResolvedValue({ success: false, error: 'Event "ev1" not found', code: "NOT_FOUND" });
    renderTab();
    const alert = await screen.findByTestId("event-versions-error");
    expect(alert.getAttribute("role")).toBe("alert");
    expect(alert.textContent).toContain('Event "ev1" not found');
    expect(screen.queryByTestId("event-version-list-empty")).toBeNull();
  });

  describe("Retry after a failed load", () => {
    const retry = () => screen.getByTestId("event-versions-retry");

    it("sits next to the error, as a button", async () => {
      h.list.mockResolvedValue({ success: false, error: "Try later" });
      renderTab();
      const alert = await screen.findByTestId("event-versions-error");
      expect(within(alert).getByRole("button", { name: "Retry" })).toBe(retry());
    });

    it("asks again: a success replaces the error with the list, a second failure shows the error again", async () => {
      h.list.mockResolvedValueOnce({ success: false, error: "Try later" });
      renderTab();
      await screen.findByTestId("event-versions-error");
      expect(h.list).toHaveBeenCalledTimes(1);

      // Retry -> failure again: the error is back (and so is Retry), with the new answer's text.
      const second = deferred<unknown>();
      h.list.mockReturnValueOnce(second.promise);
      fireEvent.click(retry());
      expect(screen.getByTestId("event-versions-loading")).toBeDefined(); // the old error is gone while it asks
      expect(screen.queryByTestId("event-versions-error")).toBeNull();
      await act(async () => { second.resolve({ success: false, error: "Still down" }); });
      expect(screen.getByTestId("event-versions-error").textContent).toContain("Still down");
      expect(h.list).toHaveBeenCalledTimes(2);

      // Retry -> success: the list replaces the error.
      h.list.mockResolvedValueOnce({ success: true, data: [V11, V10] });
      fireEvent.click(retry());
      await screen.findByTestId("event-version-list");
      expect(screen.queryByTestId("event-versions-error")).toBeNull();
      expect(rows()).toHaveLength(2);
      expect(h.list).toHaveBeenCalledTimes(3);
      expect(h.list).toHaveBeenLastCalledWith("ev1", "p1");
    });

    it("works after a rejected action too, and never prints the cause", async () => {
      h.list.mockRejectedValueOnce(new Error("connect ECONNREFUSED 10.0.0.5:5432"));
      renderTab();
      await screen.findByTestId("event-versions-error");
      h.list.mockRejectedValueOnce(new Error("connect ECONNREFUSED 10.0.0.5:5432"));
      fireEvent.click(retry());
      await waitFor(() => expect(h.list).toHaveBeenCalledTimes(2));
      expect((await screen.findByTestId("event-versions-error")).textContent).toContain("Something went wrong");
      expect(screen.getByTestId("event-versions-error").textContent).not.toContain("ECONNREFUSED");
      h.list.mockResolvedValueOnce({ success: true, data: [V10] });
      fireEvent.click(retry());
      await screen.findByTestId("event-version-list");
      expect(rows()).toHaveLength(1);
    });

    it("is not shown while the list loads or once it is shown", async () => {
      const pending = deferred<unknown>();
      h.list.mockReturnValue(pending.promise);
      renderTab();
      expect(screen.queryByTestId("event-versions-retry")).toBeNull();
      await act(async () => { pending.resolve({ success: true, data: [V11, V10] }); });
      expect(screen.queryByTestId("event-versions-retry")).toBeNull();
    });
  });

  it("never prints the cause of a rejected action or raw database text", async () => {
    h.list.mockRejectedValue(new Error("connect ECONNREFUSED 10.0.0.5:5432"));
    renderTab();
    expect((await screen.findByTestId("event-versions-error")).textContent).toContain("Something went wrong");
    expect(screen.getByTestId("event-versions-error").textContent).not.toContain("ECONNREFUSED");
    cleanup();
    h.list.mockResolvedValue({ success: false, error: 'relation "event_spec_versions" does not exist', code: "DB_ERROR" });
    renderTab();
    expect((await screen.findByTestId("event-versions-error")).textContent).not.toContain("event_spec_versions");
  });

  it("reloads the list when the event's latest version changes (a publish from the page)", async () => {
    const { rerender } = render(<VersionsTab eventId="ev1" productId="p1" latestLabel="1.0" version={null} onVersionChange={() => undefined} />);
    await screen.findByTestId("event-version-list");
    expect(rows()).toHaveLength(2); // the first answer (V11, V10) is on screen
    h.list.mockResolvedValue({ success: true, data: [summary("1.2", 3), V11, V10] });
    rerender(<VersionsTab eventId="ev1" productId="p1" latestLabel="1.2" version={null} onVersionChange={() => undefined} />);
    await waitFor(() => expect(rows()).toHaveLength(3));
    expect(h.list).toHaveBeenCalledTimes(2);
    expect(rows()[0].textContent).toContain("v1.2");
  });

  it("does not ask again when it re-renders with the same event and latest version", async () => {
    const { rerender } = render(<VersionsTab eventId="ev1" productId="p1" latestLabel="1.1" version={null} onVersionChange={() => undefined} />);
    await screen.findByTestId("event-version-list");
    rerender(<VersionsTab eventId="ev1" productId="p1" latestLabel="1.1" version={null} onVersionChange={() => undefined} />);
    expect(h.list).toHaveBeenCalledTimes(1);
  });

  it("ignores a list that arrives after the tab was left", async () => {
    const pending = deferred<unknown>();
    h.list.mockReturnValue(pending.promise);
    const { unmount } = renderTab();
    unmount();
    await act(async () => { pending.resolve({ success: true, data: [V10] }); });
    expect(screen.queryByTestId("event-version-list")).toBeNull();
  });
});

describe("VersionsTab: viewing a stored version", () => {
  it("has a View button on every row and shows no code until one is pressed", async () => {
    renderTab();
    await screen.findByTestId("event-version-list");
    expect(view("1.1")).toBeDefined();
    expect(view("1.0")).toBeDefined();
    expect(screen.queryByTestId("event-version-code")).toBeNull();
    expect(h.read).not.toHaveBeenCalled();
  });

  it("View loads the stored code through readEventVersionAction and shows it read-only, as YAML first", async () => {
    const onVersion = vi.fn();
    renderTab({ onVersion });
    await screen.findByTestId("event-version-list");
    fireEvent.click(view("1.1"));
    expect(onVersion).toHaveBeenCalledWith("1.1");
    await waitFor(() => expect(codeText()).toBe(CODE("1.1").yaml));
    expect(h.read).toHaveBeenCalledWith("ev1", "p1", "1.1");
    expect(screen.getByTestId("event-version-code").textContent).toContain("v1.1");
    expect((screen.getByTestId("event-version-code-text") as HTMLTextAreaElement).readOnly).toBe(true);
    expect(view("1.1").getAttribute("aria-pressed")).toBe("true");
    expect(view("1.0").getAttribute("aria-pressed")).toBe("false");
  });

  it("switches between YAML and JSON", async () => {
    renderTab();
    await screen.findByTestId("event-version-list");
    fireEvent.click(view("1.0"));
    await waitFor(() => expect(codeText()).toBe(CODE("1.0").yaml));
    expect(screen.getByTestId("version-code-format-yaml").getAttribute("aria-pressed")).toBe("true");
    fireEvent.click(screen.getByTestId("version-code-format-json"));
    expect(codeText()).toBe(CODE("1.0").json);
    expect(screen.getByTestId("version-code-format-json").getAttribute("aria-pressed")).toBe("true");
    expect(screen.getByTestId("version-code-format-yaml").getAttribute("aria-pressed")).toBe("false");
    fireEvent.click(screen.getByTestId("version-code-format-yaml"));
    expect(codeText()).toBe(CODE("1.0").yaml);
  });

  it("copies the code in the chosen format and says so", async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, "clipboard", { value: { writeText }, configurable: true });
    renderTab();
    await screen.findByTestId("event-version-list");
    fireEvent.click(view("1.1"));
    await waitFor(() => expect(codeText()).toBe(CODE("1.1").yaml));
    fireEvent.click(screen.getByTestId("version-code-copy"));
    await waitFor(() => expect(writeText).toHaveBeenCalledWith(CODE("1.1").yaml));
    expect(h.toastSuccess).toHaveBeenCalledWith("YAML copied");
    fireEvent.click(screen.getByTestId("version-code-format-json"));
    fireEvent.click(screen.getByTestId("version-code-copy"));
    await waitFor(() => expect(writeText).toHaveBeenLastCalledWith(CODE("1.1").json));
    expect(h.toastSuccess).toHaveBeenLastCalledWith("JSON copied");
  });

  it("tells the user when the clipboard is not available", async () => {
    Object.defineProperty(navigator, "clipboard", { value: undefined, configurable: true });
    renderTab();
    await screen.findByTestId("event-version-list");
    fireEvent.click(view("1.1"));
    await waitFor(() => expect(codeText()).toBe(CODE("1.1").yaml));
    fireEvent.click(screen.getByTestId("version-code-copy"));
    await waitFor(() => expect(h.toastError).toHaveBeenCalledWith("Could not copy the code"));
  });

  it("selecting another version replaces the code", async () => {
    renderTab();
    await screen.findByTestId("event-version-list");
    fireEvent.click(view("1.1"));
    await waitFor(() => expect(codeText()).toBe(CODE("1.1").yaml));
    fireEvent.click(view("1.0"));
    await waitFor(() => expect(codeText()).toBe(CODE("1.0").yaml));
    expect(screen.getByTestId("event-version-code").textContent).toContain("v1.0");
    expect(screen.getAllByTestId("event-version-code")).toHaveLength(1);
    expect(view("1.0").getAttribute("aria-pressed")).toBe("true");
    expect(view("1.1").getAttribute("aria-pressed")).toBe("false");
  });

  it("shows the newest selection when an older, slower answer arrives last", async () => {
    const slow = deferred<unknown>();
    h.read.mockImplementation((_e: string, _p: string, label: string) => (label === "1.1" ? slow.promise : Promise.resolve({ success: true, data: CODE(label) })));
    renderTab();
    await screen.findByTestId("event-version-list");
    fireEvent.click(view("1.1"));
    fireEvent.click(view("1.0"));
    await waitFor(() => expect(codeText()).toBe(CODE("1.0").yaml));
    await act(async () => { slow.resolve({ success: true, data: CODE("1.1") }); });
    expect(codeText()).toBe(CODE("1.0").yaml);
  });

  it("a failed load shows the error, keeps the list, and the other version still opens", async () => {
    h.read.mockImplementation(async (_e: string, _p: string, label: string) =>
      label === "1.1" ? { success: false, error: "Stored document of version 1.1 is invalid", code: "DATA_CORRUPT" } : { success: true, data: CODE(label) });
    renderTab();
    await screen.findByTestId("event-version-list");
    fireEvent.click(view("1.1"));
    const error = await screen.findByTestId("event-version-code-error");
    expect(error.getAttribute("role")).toBe("alert");
    expect(error.textContent).toContain("Stored document of version 1.1 is invalid");
    expect(screen.queryByTestId("event-version-code-text")).toBeNull();
    // The list is still there and usable.
    expect(rows()).toHaveLength(2);
    fireEvent.click(view("1.0"));
    await waitFor(() => expect(codeText()).toBe(CODE("1.0").yaml));
    expect(screen.queryByTestId("event-version-code-error")).toBeNull();
  });

  it("offers a retry for a failed load", async () => {
    h.read.mockResolvedValueOnce({ success: false, error: "Try later", code: "INTERNAL_ERROR" });
    renderTab();
    await screen.findByTestId("event-version-list");
    fireEvent.click(view("1.1"));
    await screen.findByTestId("event-version-code-error");
    fireEvent.click(screen.getByTestId("event-version-code-retry"));
    await waitFor(() => expect(codeText()).toBe(CODE("1.1").yaml));
    expect(h.read).toHaveBeenCalledTimes(2);
  });

  it("never prints the cause of a rejected load", async () => {
    h.read.mockRejectedValue(new Error("connect ECONNREFUSED 10.0.0.5:5432"));
    renderTab();
    await screen.findByTestId("event-version-list");
    fireEvent.click(view("1.1"));
    const error = await screen.findByTestId("event-version-code-error");
    expect(error.textContent).toContain("Something went wrong");
    expect(error.textContent).not.toContain("ECONNREFUSED");
  });

  it("opens the version the page was loaded with (?version=) without a click", async () => {
    renderTab({ initialVersion: "1.0" });
    await waitFor(() => expect(codeText()).toBe(CODE("1.0").yaml));
    expect(h.read).toHaveBeenCalledWith("ev1", "p1", "1.0");
    await screen.findByTestId("event-version-list");
    expect(view("1.0").getAttribute("aria-pressed")).toBe("true");
  });

  it("shows the action's error for a ?version= that does not exist, with the list intact", async () => {
    h.read.mockResolvedValue({ success: false, error: 'Version 9.9 of event "ev1" not found', code: "NOT_FOUND", suggestedFix: "List the published versions and pick one." });
    renderTab({ initialVersion: "9.9" });
    const error = await screen.findByTestId("event-version-code-error");
    expect(error.textContent).toContain('Version 9.9 of event "ev1" not found');
    await screen.findByTestId("event-version-list");
    expect(rows()).toHaveLength(2);
  });
});
