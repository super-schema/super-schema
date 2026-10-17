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
    expect((await screen.findByRole("alert")).textContent).toBe("Could not load the publish preview: network down");
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
    expect((await screen.findByRole("alert")).textContent).toBe("Publishing failed: server action failed");
    await waitFor(() => expect(screen.getByTestId("dialog").getAttribute("data-publishing")).toBe("false"));
    expect(h.success).not.toHaveBeenCalled();
    expect(h.refresh).not.toHaveBeenCalled();
    expect(onPublished).not.toHaveBeenCalled();
    // `isPublishing` is released, so the dialog closes and the confirm button is enabled again.
    expect((screen.getByText("confirm") as HTMLButtonElement).disabled).toBe(false);
    fireEvent.click(screen.getByText("close"));
    expect(screen.queryByTestId("dialog")).toBeNull();
  });

  it("falls back to a generic message for a non-Error rejection", async () => {
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
    expect((await screen.findByRole("alert")).textContent).toBe("Publishing failed: Unexpected error");
  });
});
