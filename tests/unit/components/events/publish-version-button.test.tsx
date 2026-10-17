// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => ({ refresh: vi.fn(), success: vi.fn() }));
vi.mock("next/navigation", () => ({ useRouter: () => ({ refresh: h.refresh }) }));
vi.mock("sonner", () => ({ toast: { success: h.success, error: vi.fn() } }));
vi.mock("@/app/(dashboard)/schemas/[domainSlug]/[productSlug]/[entityId]/components/PublishEntityDialog", () => ({
  PublishEntityDialog: (p: {
    open: boolean; description?: string; loadError: string | null; publishError: string | null; isPublishing: boolean;
    preview: { blockers: Array<{ message: string }> } | null; onConfirm: (i: { bump?: "MAJOR" | "MINOR" }) => void;
    onOpenChange: (open: boolean) => void;
  }) =>
    p.open ? (
      <div data-testid="dialog" data-publishing={String(p.isPublishing)}>
        <p>{p.description}</p>
        {p.loadError && <p role="alert">{p.loadError}</p>}
        {p.publishError && <p role="alert">{p.publishError}</p>}
        {p.preview && <button disabled={p.isPublishing} onClick={() => p.onConfirm({ bump: "MAJOR" })}>confirm</button>}
        {/* The real dialog refuses to close while publishing; mirror that so a stuck flag is observable. */}
        <button onClick={() => !p.isPublishing && p.onOpenChange(false)}>close</button>
      </div>
    ) : null,
}));

import { PublishVersionButton } from "@/features/events/shared/PublishVersionButton";
import { GENERIC_ACTION_ERROR } from "@/types/action-result";

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});
const preview = { isFirstPublish: true, latestLabel: null, suggestedBump: null, candidateLabels: null, initialLabel: "1.0", reasons: [], blockers: [] };
const okPreview = async () => ({ success: true as const, data: preview });

describe("PublishVersionButton", () => {
  it("loads the preview, publishes the chosen bump, toasts and refreshes", async () => {
    const publish = vi.fn(async () => ({ success: true as const, data: { label: "2.0" } }));
    const onPublished = vi.fn();
    render(
      <PublishVersionButton subjectName="OrderCreated" description="Freezes the message" loadPreview={okPreview} publish={publish} onPublished={onPublished} />
    );
    fireEvent.click(screen.getByTestId("publish-version-button"));
    expect(await screen.findByText("Freezes the message")).toBeDefined();
    fireEvent.click(await screen.findByText("confirm"));
    await waitFor(() => expect(onPublished).toHaveBeenCalledWith("2.0"));
    expect(publish).toHaveBeenCalledWith({ bump: "MAJOR" });
    expect(h.success).toHaveBeenCalledWith("Published OrderCreated v2.0");
    expect(h.refresh).toHaveBeenCalled();
    expect(screen.queryByTestId("dialog")).toBeNull();
  });

  it("shows a load error result inside the dialog", async () => {
    render(
      <PublishVersionButton subjectName="x" description="d" loadPreview={async () => ({ success: false, error: "boom" })} publish={vi.fn()} />
    );
    fireEvent.click(screen.getByTestId("publish-version-button"));
    expect((await screen.findByRole("alert")).textContent).toBe("boom");
  });

  it("shows a publish error result, keeps the dialog open and the controls usable", async () => {
    const publish = vi.fn(async () => ({ success: false as const, error: "Bump too low", code: "BUMP_TOO_LOW" }));
    render(<PublishVersionButton subjectName="x" description="d" loadPreview={okPreview} publish={publish} />);
    fireEvent.click(screen.getByTestId("publish-version-button"));
    fireEvent.click(await screen.findByText("confirm"));
    expect((await screen.findByRole("alert")).textContent).toBe("Bump too low");
    expect(screen.getByTestId("dialog").getAttribute("data-publishing")).toBe("false");
    expect(h.success).not.toHaveBeenCalled();
    expect(h.refresh).not.toHaveBeenCalled();
  });

  it("adds the service's suggested fix to a failed publish and to a failed preview", async () => {
    const publish = vi.fn(async () => ({ success: false as const, error: "The event changed while publishing.", code: "CONFLICT", suggestedFix: "Reload the event and publish again." }));
    render(<PublishVersionButton subjectName="x" description="d" loadPreview={okPreview} publish={publish} />);
    fireEvent.click(screen.getByTestId("publish-version-button"));
    fireEvent.click(await screen.findByText("confirm"));
    expect((await screen.findByRole("alert")).textContent).toBe("The event changed while publishing. Reload the event and publish again.");
    cleanup();
    render(
      <PublishVersionButton
        subjectName="x" description="d" publish={vi.fn()}
        loadPreview={async () => ({ success: false, error: "Not found.", code: "NOT_FOUND", suggestedFix: "Reload the page." })}
      />
    );
    fireEvent.click(screen.getByTestId("publish-version-button"));
    expect((await screen.findByRole("alert")).textContent).toBe("Not found. Reload the page.");
  });

  it("never shows a database failure's text (an opaque code becomes the generic message)", async () => {
    const publish = vi.fn(async () => ({ success: false as const, error: 'relation "event_spec_versions" does not exist', code: "DB_ERROR" }));
    render(<PublishVersionButton subjectName="x" description="d" loadPreview={okPreview} publish={publish} />);
    fireEvent.click(screen.getByTestId("publish-version-button"));
    fireEvent.click(await screen.findByText("confirm"));
    expect((await screen.findByRole("alert")).textContent).not.toContain("event_spec_versions");
  });

  it("passes a title to the button (the reason it is disabled) and honours disabled", () => {
    render(<PublishVersionButton subjectName="x" description="d" loadPreview={okPreview} publish={vi.fn()} disabled title="Save your changes first" />);
    const button = screen.getByTestId("publish-version-button") as HTMLButtonElement;
    expect(button.disabled).toBe(true);
    expect(button.getAttribute("title")).toBe("Save your changes first");
  });

  // A native-disabled button takes no pointer events and no focus, so its own `title` is never shown: the reason must also be reachable
  // through the wrapper (hover), as visible text, and as the button's accessible description (screen readers).
  it("shows why it is disabled where a disabled button cannot: a hover title on a wrapper, visible text and aria-describedby", () => {
    render(<PublishVersionButton subjectName="x" description="d" loadPreview={okPreview} publish={vi.fn()} disabled title="Save your changes first" />);
    const button = screen.getByTestId("publish-version-button");
    const hint = screen.getByText("Save your changes first");
    expect(hint.id).not.toBe("");
    expect(button.getAttribute("aria-describedby")).toBe(hint.id);
    expect(button.parentElement?.getAttribute("title")).toBe("Save your changes first"); // the wrapper receives the hover the button does not
    expect(button.parentElement?.contains(hint)).toBe(true);
    expect(button.getAttribute("title")).toBe("Save your changes first"); // kept on the button too
  });

  it("has no hint text, no wrapper title and no description when there is no reason", () => {
    render(<PublishVersionButton subjectName="x" description="d" loadPreview={okPreview} publish={vi.fn()} />);
    const button = screen.getByTestId("publish-version-button");
    expect(button.getAttribute("aria-describedby")).toBeNull();
    expect(button.getAttribute("title")).toBeNull();
    expect(button.parentElement?.getAttribute("title")).toBeNull();
    expect(button.parentElement?.textContent).toBe("Publish");
  });

  it("keeps the very same button element while the hint comes and goes, so focus and the open dialog are never lost to a remount", () => {
    const { rerender } = render(<PublishVersionButton subjectName="x" description="d" loadPreview={okPreview} publish={vi.fn()} />);
    const before = screen.getByTestId("publish-version-button");
    rerender(<PublishVersionButton subjectName="x" description="d" loadPreview={okPreview} publish={vi.fn()} disabled title="Saving your changes…" />);
    expect(screen.getByTestId("publish-version-button")).toBe(before);
    expect(screen.getByText("Saving your changes…")).toBeDefined();
    rerender(<PublishVersionButton subjectName="x" description="d" loadPreview={okPreview} publish={vi.fn()} />);
    expect(screen.getByTestId("publish-version-button")).toBe(before);
    expect(screen.queryByText("Saving your changes…")).toBeNull();
  });

  it("a rejecting loadPreview surfaces an error instead of spinning forever", async () => {
    render(
      <PublishVersionButton
        subjectName="x"
        description="d"
        loadPreview={async () => {
          throw new Error("network down");
        }}
        publish={vi.fn()}
      />
    );
    fireEvent.click(screen.getByTestId("publish-version-button"));
    expect((await screen.findByRole("alert")).textContent).toBe(GENERIC_ACTION_ERROR); // never the cause: a rejected action may carry anything
    // The dialog can still be dismissed and reopened.
    fireEvent.click(screen.getByText("close"));
    expect(screen.queryByTestId("dialog")).toBeNull();
    fireEvent.click(screen.getByTestId("publish-version-button"));
    expect(await screen.findByRole("alert")).toBeDefined();
  });

  it("a rejecting publish surfaces an error, resets the publishing flag and leaves the dialog dismissible", async () => {
    const publish = vi.fn(async () => {
      throw new Error("server action failed");
    });
    const onPublished = vi.fn();
    render(<PublishVersionButton subjectName="x" description="d" loadPreview={okPreview} publish={publish} onPublished={onPublished} />);
    fireEvent.click(screen.getByTestId("publish-version-button"));
    fireEvent.click(await screen.findByText("confirm"));
    expect((await screen.findByRole("alert")).textContent).toBe(GENERIC_ACTION_ERROR);
    expect(screen.getByRole("alert").textContent).not.toContain("server action failed");
    await waitFor(() => expect(screen.getByTestId("dialog").getAttribute("data-publishing")).toBe("false"));
    expect(h.success).not.toHaveBeenCalled();
    expect(h.refresh).not.toHaveBeenCalled();
    expect(onPublished).not.toHaveBeenCalled();
    // `isPublishing` is released, so the dialog closes and the confirm button is enabled again.
    expect((screen.getByText("confirm") as HTMLButtonElement).disabled).toBe(false);
    fireEvent.click(screen.getByText("close"));
    expect(screen.queryByTestId("dialog")).toBeNull();
  });

  it("never shows the text of a rejection, an Error or not", async () => {
    render(
      <PublishVersionButton
        subjectName="x"
        description="d"
        loadPreview={okPreview}
        publish={async () => Promise.reject("string reason")}
      />
    );
    fireEvent.click(screen.getByTestId("publish-version-button"));
    fireEvent.click(await screen.findByText("confirm"));
    expect((await screen.findByRole("alert")).textContent).toBe(GENERIC_ACTION_ERROR);
  });
});
