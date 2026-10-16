// @vitest-environment jsdom
import { cleanup, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => ({ preview: vi.fn() }));
vi.mock("@/app/(dashboard)/schemas/[domainSlug]/[productSlug]/event-actions", () => ({ previewEventDocumentAction: h.preview }));

import { useEventCode, type UseEventCodeArgs } from "@/features/events/event-page/use-event-code";
import { BUNDLED_TRAITS } from "@/lib/events/bundled-traits";
import { instantLibraryTraits, PLACEHOLDER_LIBRARY_TRAIT_KEY } from "@/lib/events/document/instant-asyncapi";
import { emptyEventDocument, type EventDocument } from "@/lib/events/document/types";

/** The Code panel's instant build shows the real properties of a built-in library trait as soon as the page hands it the definitions. */
const PIN = { entityId: "ent-1", entityVersionId: "ver-1" };
const CLOUDEVENTS = BUNDLED_TRAITS.find((t) => t.name === "CloudEvents")!;

const doc = (): EventDocument => ({
  ...emptyEventDocument("Orders"),
  servers: [{ key: "kafka", protocol: "kafka", host: "h:9092" }],
  channels: [{ key: "orders", address: "orders.v1", protocol: "kafka", serverKeys: ["kafka"], format: "avro", messageKeys: ["OrderCreated"] }],
  messages: [{ key: "OrderCreated", payload: PIN, traitKeys: ["CloudEvents"] }],
  traits: [{ key: "CloudEvents", kind: "MESSAGE", libraryTraitId: "lib-ce" }],
  operations: [{ key: "publishOrder", action: "send", channelKey: "orders", messageKeys: ["OrderCreated"], traitKeys: [] }],
});
const LIBRARY = instantLibraryTraits([{ id: "lib-ce", name: "CloudEvents", kind: "MESSAGE", spec: CLOUDEVENTS.spec }]);

type Props = Partial<UseEventCodeArgs>;
const setup = (initial: Props) => renderHook((p: Props) => useEventCode({
  eventId: "ev1", productId: "p1", productSlug: "checkout", doc: doc(), blocked: false,
  entityLabels: new Map([["ent-1", "Order"]]), versionLabels: new Map([["ver-1", "1.0"]]), ...p,
}), { initialProps: initial });

beforeEach(() => {
  vi.useFakeTimers();
  h.preview.mockReset();
  h.preview.mockResolvedValue({ success: false, error: "not needed", code: "X" });
});
afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

describe("useEventCode: library trait definitions", () => {
  it("emits the real CloudEvents properties on the first render when the definitions are given", () => {
    const doc1 = doc();
    const { result } = setup({ doc: doc1, libraryTraits: LIBRARY });
    expect(result.current.yaml).toContain("specversion:");
    expect(result.current.yaml).toContain("uri-reference");
    expect(result.current.yaml).not.toContain(PLACEHOLDER_LIBRARY_TRAIT_KEY);
    expect((result.current.instant.document?.components as { messageTraits: Record<string, { headers: unknown }> }).messageTraits.CloudEvents.headers).toEqual(CLOUDEVENTS.spec.headers);
  });

  it("keeps the stub when no definitions are given (the previous behaviour)", () => {
    const { result } = setup({});
    expect(result.current.yaml).toContain(PLACEHOLDER_LIBRARY_TRAIT_KEY);
    expect(result.current.yaml).not.toContain("specversion:");
  });

  it("switches from the stub to the real properties when the definitions arrive", () => {
    const fixed = doc();
    const { result, rerender } = setup({ doc: fixed });
    expect(result.current.yaml).toContain(PLACEHOLDER_LIBRARY_TRAIT_KEY);
    rerender({ doc: fixed, libraryTraits: LIBRARY });
    expect(result.current.yaml).toContain("specversion:");
    expect(result.current.yaml).not.toContain(PLACEHOLDER_LIBRARY_TRAIT_KEY);
  });
});
