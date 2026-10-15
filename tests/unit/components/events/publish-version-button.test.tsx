// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => ({ refresh: vi.fn(), success: vi.fn() }));
vi.mock("next/navigation", () => ({ useRouter: () => ({ refresh: h.refresh }) }));
vi.mock("sonner", () => ({ toast: { success: h.success, error: vi.fn() } }));
vi.mock("@/app/(dashboard)/schemas/[domainSlug]/[productSlug]/[entityId]/components/PublishEntityDialog", () => ({
  PublishEntityDialog: (p: {
    open: boolean; description?: string; loadError: string | null; publishError: string | null;
    preview: { blockers: Array<{ message: string }> } | null; onConfirm: (i: { bump?: "MAJOR" | "MINOR" }) => void;
  }) =>
    p.open ? (
      <div data-testid="dialog">
        <p>{p.description}</p>
        {p.loadError && <p role="alert">{p.loadError}</p>}
        {p.publishError && <p role="alert">{p.publishError}</p>}
        {p.preview && <button onClick={() => p.onConfirm({ bump: "MAJOR" })}>confirm</button>}
      </div>
    ) : null,
}));

import { PublishVersionButton } from "@/features/events/shared/PublishVersionButton";

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});
const preview = { isFirstPublish: true, latestLabel: null, suggestedBump: null, candidateLabels: null, initialLabel: "1.0", reasons: [], blockers: [] };

describe("PublishVersionButton", () => {
  it("loads the preview, publishes the chosen bump, toasts and refreshes", async () => {
    const publish = vi.fn(async () => ({ success: true as const, data: { label: "2.0" } }));
    const onPublished = vi.fn();
    render(
      <PublishVersionButton subjectName="OrderCreated" description="Freezes the message" loadPreview={async () => ({ success: true, data: preview })} publish={publish} onPublished={onPublished} />
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

  it("shows load and publish errors inside the dialog", async () => {
    render(
      <PublishVersionButton subjectName="x" description="d" loadPreview={async () => ({ success: false, error: "boom" })} publish={vi.fn()} />
    );
    fireEvent.click(screen.getByTestId("publish-version-button"));
    expect((await screen.findByRole("alert")).textContent).toBe("boom");
  });
});
