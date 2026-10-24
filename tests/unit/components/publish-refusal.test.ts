import { describe, it, expect, vi } from "vitest";
import {
  publishRefusalToast,
  PUBLISH_REFUSAL_DURATION_MS,
  REGENERATE_AND_PUBLISH_LABEL,
} from "@/app/(dashboard)/schemas/[domainSlug]/[productSlug]/[entityId]/components/publish-refusal";

describe("publishRefusalToast", () => {
  it("a plain refusal is just its message: no button", () => {
    const retry = vi.fn();
    expect(publishRefusalToast({ error: "Version 3 not found" }, retry)).toEqual({ message: "Version 3 not found" });
    expect(retry).not.toHaveBeenCalled();
  });

  it("a preview refusal keeps the server's message and adds a button that regenerates from the published versions", () => {
    const retry = vi.fn();
    const toast = publishRefusalToast({ error: "This schema version was generated from the saved draft of A / B / C", needsPublishedRegeneration: true }, retry);
    expect(toast.message).toBe("This schema version was generated from the saved draft of A / B / C");
    expect(toast.options).toMatchObject({ duration: PUBLISH_REFUSAL_DURATION_MS, action: { label: REGENERATE_AND_PUBLISH_LABEL } });
    expect(retry).not.toHaveBeenCalled();
    toast.options?.action.onClick();
    expect(retry).toHaveBeenCalledTimes(1);
  });

  it("needsPublishedRegeneration: false is a plain refusal", () => {
    expect(publishRefusalToast({ error: "x", needsPublishedRegeneration: false }, vi.fn()).options).toBeUndefined();
  });
});
