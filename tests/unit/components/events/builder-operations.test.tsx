// @vitest-environment jsdom
import { act, cleanup, fireEvent, screen, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { SECTION_COMPONENTS } from "@/features/events/builder/EventBuilder";
import { OperationsSection } from "@/features/events/builder/sections/OperationsSection";
import type { SaveDocument } from "@/features/events/builder/use-event-draft";
import { parseEventDocument } from "@/lib/events/document/parse";
import { emptyEventDocument, type EventDocument } from "@/lib/events/document/types";
import { bindingVersion, TEMPLATES } from "@/lib/events/templates";
import { maximalDocument } from "../../lib/events/document/fixtures/maximal-document";
import { PIN, renderBuilder, renderSection, sampleDocument } from "./builder-harness";

// Operations render no entity picker, but the builder tests below also open the Messages section.
const h = vi.hoisted(() => ({ listPinnableVersionsAction: vi.fn() }));
vi.mock("@/features/events/pin-actions", () => ({ listPinnableVersionsAction: h.listPinnableVersionsAction }));

beforeEach(() => {
  vi.clearAllMocks();
  h.listPinnableVersionsAction.mockResolvedValue({ success: true, data: [] });
});
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

const type = (el: HTMLElement, value: string) => fireEvent.change(el, { target: { value } });
const click = (testId: string) => fireEvent.click(screen.getByTestId(testId));
const field = (label: string) => screen.getByLabelText(label) as HTMLInputElement;
const box = (testId: string) => screen.getByTestId(testId) as HTMLInputElement;
const text = (testId: string) => screen.getByTestId(testId).textContent;
const missing = (testId: string) => screen.queryByTestId(testId) === null;
const optionValues = (select: HTMLElement) => Array.from(select.querySelectorAll("option")).map((o) => o.getAttribute("value"));

/** The accordion cards of the operation form. */
const CARDS = ["basics", "reply", "properties", "details", "bindings", "docs", "security"] as const;
type Card = (typeof CARDS)[number];
const isOpen = (card: Card) => screen.getByTestId(`operation-card-${card}-toggle`).getAttribute("aria-expanded") === "true";
/** Open a card, leaving it alone when it is open already. */
const openCard = (card: Card) => {
  if (!isOpen(card)) fireEvent.click(screen.getByTestId(`operation-card-${card}-toggle`));
};
const openAllCards = () => CARDS.forEach(openCard);
/** Keys of the checkboxes of a group, in order. */
const checklist = (groupId: string) =>
  Array.from(screen.getByTestId(groupId).querySelectorAll("input[type=checkbox]")).map((i) => (i.getAttribute("data-testid") ?? "").replace(`${groupId}-option-`, ""));

/**
 * orders = [OrderCreated, OrderUpdated], refunds = [RefundIssued], empty = []; publishOrder = send OrderCreated on orders.
 */
function richDoc(): EventDocument {
  const doc = sampleDocument();
  doc.messages.push({ key: "OrderUpdated", payload: PIN, traitKeys: [] }, { key: "RefundIssued", payload: PIN, traitKeys: [] });
  doc.channels[0].messageKeys = ["OrderCreated", "OrderUpdated"];
  doc.channels[1].messageKeys = ["RefundIssued"];
  doc.channels.push({ key: "empty", address: "empty.v1", protocol: "kafka", serverKeys: [], format: "avro", messageKeys: [] });
  return doc;
}

/** richDoc + a request/reply operation: send OrderCreated on orders, reply RefundIssued on refunds. */
function docWithReply(): EventDocument {
  const doc = richDoc();
  doc.operations.push({
    key: "askRefund", action: "send", channelKey: "orders", messageKeys: ["OrderUpdated"], traitKeys: [],
    reply: { channelKey: "refunds", messageKeys: ["RefundIssued"] },
  });
  return doc;
}

it("the fixtures are valid documents, so any problem below comes from the edit under test", () => {
  expect(parseEventDocument(richDoc()).success).toBe(true);
  expect(parseEventDocument(docWithReply()).success).toBe(true);
});

it("is registered as the operations section of the builder", () => {
  expect(SECTION_COMPONENTS.operations).toBe(OperationsSection);
});

describe("OperationsSection: needs a channel first", () => {
  it("shows 'Add a channel first' instead of an Add button when the document has no channel", () => {
    renderSection(OperationsSection, { doc: emptyEventDocument("Orders") });
    expect(text("operation-needs-channel")).toContain("Add a channel first");
    expect(missing("operation-add")).toBe(true);
    expect(missing("operation-empty")).toBe(true);
  });

  it("the button switches the builder to the Channels section", () => {
    const { probe } = renderBuilder({ doc: emptyEventDocument("Orders"), section: "operations", item: "stale" });
    click("operation-go-channels");
    expect(probe.section).toBe("channels");
    expect(probe.item).toBeNull();
    expect(screen.getByTestId("section-channels")).toBeDefined();
    expect(screen.getByTestId("outline-channels").getAttribute("aria-current")).toBe("true");
  });

  it("without a way to switch sections the hint stays and no dead button is rendered", () => {
    renderSection(OperationsSection, { doc: emptyEventDocument("Orders") });
    expect(missing("operation-go-channels")).toBe(true);
  });

  it("with a channel but no operation it shows the empty state with the primary action", () => {
    const doc = sampleDocument();
    doc.operations = [];
    const { probe } = renderSection(OperationsSection, { doc });
    const empty = screen.getByTestId("operation-empty");
    expect(empty.textContent).toContain("No operations yet");
    expect(missing("operation-add")).toBe(true);
    fireEvent.click(within(empty).getByRole("button", { name: "Add operation" }));
    expect(probe.draft.doc.operations).toHaveLength(1);
    expect(missing("operation-empty")).toBe(true);
  });

  it("an operation list whose channels were all removed still renders, without offering to add more", () => {
    const doc = sampleDocument();
    doc.channels = [];
    renderSection(OperationsSection, { doc });
    expect(screen.getByTestId("operation-row-publishOrder")).toBeDefined();
    expect(missing("operation-add")).toBe(true);
    expect(text("operation-needs-channel")).toContain("Add a channel first");
  });
});

describe("OperationsSection: list, selection and add", () => {
  it("lists the operations, shows the first one's form and selects another on click", () => {
    renderSection(OperationsSection, { doc: docWithReply() });
    expect(screen.getByTestId("operation-row-publishOrder").getAttribute("aria-current")).toBe("true");
    expect(text("operation-key-value")).toBe("publishOrder");
    click("operation-row-askRefund");
    expect(screen.getByTestId("operation-row-askRefund").getAttribute("aria-current")).toBe("true");
    expect(screen.getByTestId("operation-row-publishOrder").hasAttribute("aria-current")).toBe(false);
    expect(text("operation-key-value")).toBe("askRefund");
  });

  it("opens the operation named by the selected item and falls back to the first when it is gone", () => {
    renderSection(OperationsSection, { doc: docWithReply(), item: "askRefund" });
    expect(text("operation-key-value")).toBe("askRefund");
    cleanup();
    renderSection(OperationsSection, { doc: docWithReply(), item: "gone" });
    expect(text("operation-key-value")).toBe("publishOrder");
  });

  it("Add operation creates a send operation on the first channel with a unique key, and selects it", () => {
    const { probe } = renderSection(OperationsSection);
    click("operation-add");
    expect(probe.draft.doc.operations.map((o) => o.key)).toEqual(["publishOrder", "operation"]);
    expect(probe.draft.doc.operations[1]).toEqual({ key: "operation", action: "send", channelKey: "orders", messageKeys: [], traitKeys: [] });
    expect(probe.item).toBe("operation");
    expect(text("operation-key-value")).toBe("operation");
    expect(probe.draft.problems).toEqual([]);
    click("operation-add");
    expect(probe.draft.doc.operations.map((o) => o.key)).toEqual(["publishOrder", "operation", "operation-2"]);
    expect(probe.item).toBe("operation-2");
    expect(probe.draft.dirty).toBe(true);
  });

  it("shows what each operation does and on which channel in the list", () => {
    renderSection(OperationsSection, { doc: docWithReply() });
    expect(screen.getByTestId("operation-row-publishOrder").textContent).toContain("orders");
    expect(screen.getByTestId("operation-row-publishOrder").textContent).toContain("Sends");
    const doc = sampleDocument();
    doc.operations[0] = { ...doc.operations[0], action: "receive" };
    cleanup();
    renderSection(OperationsSection, { doc });
    expect(screen.getByTestId("operation-row-publishOrder").textContent).toContain("Receives");
  });
});

describe("OperationsSection: action", () => {
  it("renders two radio cards explaining the direction and selects the operation's action", () => {
    renderSection(OperationsSection);
    expect(box("operation-action-send").type).toBe("radio");
    expect(box("operation-action-receive").type).toBe("radio");
    expect(box("operation-action-send").checked).toBe(true);
    expect(box("operation-action-receive").checked).toBe(false);
    expect(box("operation-action-send").closest("label")?.textContent).toContain("This service publishes");
    expect(box("operation-action-receive").closest("label")?.textContent).toContain("This service consumes");
  });

  it("choosing the other card changes the action of the selected operation only", () => {
    const { probe } = renderSection(OperationsSection, { doc: docWithReply() });
    click("operation-action-receive");
    expect(probe.draft.doc.operations[0].action).toBe("receive");
    expect(probe.draft.doc.operations[1].action).toBe("send");
    expect(box("operation-action-receive").checked).toBe(true);
    expect(box("operation-action-send").checked).toBe(false);
    expect(probe.draft.problems).toEqual([]);
  });

  it("an unknown action in the document is reported at the cards and leaves both unselected", () => {
    const doc = sampleDocument();
    doc.operations[0] = { ...doc.operations[0], action: "publish" as never };
    renderSection(OperationsSection, { doc });
    expect(box("operation-action-send").checked).toBe(false);
    expect(box("operation-action-receive").checked).toBe(false);
    expect(text("operation-action-error")).toBe("action must be one of send, receive");
    expect((screen.getByTestId("operation-action").getAttribute("aria-describedby") ?? "").split(" ")).toContain("operation-action-error");
  });
});

describe("OperationsSection: channel and messages (a channel with no messages blocks nothing)", () => {
  it("the channel select lists the document's channels and nothing else", () => {
    const doc = richDoc();
    doc.externalRefs = [{ key: "remote", eventVersionId: "v1", kind: "channel", itemKey: "x" }];
    renderSection(OperationsSection, { doc });
    expect(optionValues(field("Channel"))).toEqual(["orders", "refunds", "empty"]);
    expect(field("Channel").value).toBe("orders");
  });

  it("the message checklist lists only the messages of the operation's channel", () => {
    renderSection(OperationsSection, { doc: richDoc() });
    expect(checklist("operation-messages")).toEqual(["OrderCreated", "OrderUpdated"]);
    expect(box("operation-messages-option-OrderCreated").checked).toBe(true);
    expect(box("operation-messages-option-OrderUpdated").checked).toBe(false);
    expect(missing("operation-messages-option-RefundIssued")).toBe(true);
  });

  it("checking and unchecking a message edits operations[].messageKeys", () => {
    const { probe } = renderSection(OperationsSection, { doc: richDoc() });
    fireEvent.click(box("operation-messages-option-OrderUpdated"));
    expect(probe.draft.doc.operations[0].messageKeys).toEqual(["OrderCreated", "OrderUpdated"]);
    fireEvent.click(box("operation-messages-option-OrderCreated"));
    expect(probe.draft.doc.operations[0].messageKeys).toEqual(["OrderUpdated"]);
    expect(probe.draft.problems).toEqual([]);
  });

  it("changing the channel drops the messages that are not on the new channel and says so", () => {
    const doc = richDoc();
    doc.operations[0] = { ...doc.operations[0], messageKeys: ["OrderCreated", "OrderUpdated"] };
    const { probe } = renderSection(OperationsSection, { doc });
    type(field("Channel"), "refunds");
    expect(probe.draft.doc.operations[0].channelKey).toBe("refunds");
    expect(probe.draft.doc.operations[0].messageKeys).toEqual([]);
    const notice = text("operation-channel-notice") ?? "";
    expect(notice).toContain("OrderCreated");
    expect(notice).toContain("OrderUpdated");
    expect(notice).toContain('"refunds"');
    expect(checklist("operation-messages")).toEqual(["RefundIssued"]);
    expect(probe.draft.problems).toEqual([]);
  });

  it("keeps the messages that are also allowed on the new channel and mentions only the dropped ones", () => {
    const doc = richDoc();
    doc.channels[1].messageKeys = ["RefundIssued", "OrderUpdated"];
    doc.operations[0] = { ...doc.operations[0], messageKeys: ["OrderCreated", "OrderUpdated"] };
    const { probe } = renderSection(OperationsSection, { doc });
    type(field("Channel"), "refunds");
    expect(probe.draft.doc.operations[0].messageKeys).toEqual(["OrderUpdated"]);
    const notice = text("operation-channel-notice") ?? "";
    expect(notice).toContain("OrderCreated");
    expect(notice).not.toContain("OrderUpdated");
    expect(probe.draft.problems).toEqual([]);
  });

  it("shows no notice when the channel changes and no message has to go", () => {
    const doc = richDoc();
    doc.operations[0] = { ...doc.operations[0], messageKeys: [] };
    const { probe } = renderSection(OperationsSection, { doc });
    type(field("Channel"), "refunds");
    expect(probe.draft.doc.operations[0].channelKey).toBe("refunds");
    expect(missing("operation-channel-notice")).toBe(true);
  });

  it("the notice goes away when another message is checked or the channel changes again without drops", () => {
    const { probe } = renderSection(OperationsSection, { doc: richDoc() });
    type(field("Channel"), "refunds");
    expect(missing("operation-channel-notice")).toBe(false);
    fireEvent.click(box("operation-messages-option-RefundIssued"));
    expect(missing("operation-channel-notice")).toBe(true);
    type(field("Channel"), "orders");
    expect(probe.draft.doc.operations[0].messageKeys).toEqual([]);
    expect(text("operation-channel-notice")).toContain("RefundIssued");
    type(field("Channel"), "empty");
    expect(missing("operation-channel-notice")).toBe(true);
  });

  it("a channel without messages shows a hint, blocks nothing, and the operation still saves", async () => {
    const { probe } = renderBuilder({ doc: richDoc(), section: "operations" });
    type(field("Channel"), "empty");
    expect(probe.draft.doc.operations[0]).toMatchObject({ channelKey: "empty", messageKeys: [] });
    expect(text("operation-messages-empty")).toContain("no messages");
    expect(probe.draft.problems).toEqual([]);
    expect(parseEventDocument(probe.draft.doc).success).toBe(true);
    expect(box("builder-save").disabled).toBe(false);
    await act(async () => { click("builder-save"); });
    expect(probe.saveDocument).toHaveBeenCalledTimes(1);
    expect(probe.saveDocument.mock.calls[0][2]).toMatchObject({ operations: [{ key: "publishOrder", channelKey: "empty", messageKeys: [] }] });
  });

  it("a message the operation holds that its channel no longer allows is shown as such, with its error, and can be unchecked", () => {
    const doc = richDoc();
    doc.operations[0] = { ...doc.operations[0], messageKeys: ["OrderCreated", "RefundIssued"] };
    const { probe } = renderSection(OperationsSection, { doc });
    const stray = box("operation-messages-option-RefundIssued");
    expect(stray.checked).toBe(true);
    expect(stray.closest("label")?.textContent).toContain("not on this channel");
    expect(text("operation-messages-error")).toBe('Message "RefundIssued" is not allowed on channel "orders"');
    fireEvent.click(stray);
    expect(probe.draft.doc.operations[0].messageKeys).toEqual(["OrderCreated"]);
    expect(probe.draft.problems).toEqual([]);
    expect(missing("operation-messages-error")).toBe(true);
  });

  it("an operation on a channel that does not exist is shown and reported, and can be pointed at a real one", () => {
    const doc = sampleDocument();
    doc.operations[0] = { ...doc.operations[0], channelKey: "ghost", messageKeys: [] };
    const { probe } = renderSection(OperationsSection, { doc });
    expect(field("Channel").value).toBe("ghost");
    expect(optionValues(field("Channel"))).toContain("ghost");
    expect(text("operation-channel-error")).toBe('Unknown channel "ghost"');
    expect(field("Channel").getAttribute("aria-invalid")).toBe("true");
    type(field("Channel"), "orders");
    expect(probe.draft.problems).toEqual([]);
    expect(optionValues(field("Channel"))).not.toContain("ghost");
  });
});

describe("OperationsSection: reply", () => {
  it("is off for an operation without a reply, and its card starts collapsed", () => {
    renderSection(OperationsSection);
    expect(isOpen("reply")).toBe(false);
    openCard("reply");
    expect(box("operation-reply-toggle").checked).toBe(false);
    expect(missing("operation-reply-channel")).toBe(true);
    expect(missing("operation-reply-messages")).toBe(true);
  });

  it("starts open for an operation that has a reply", () => {
    renderSection(OperationsSection, { doc: docWithReply(), item: "askRefund" });
    expect(isOpen("reply")).toBe(true);
    expect(box("operation-reply-toggle").checked).toBe(true);
  });

  it("turning it on adds a reply on another channel when there is one, with no messages yet", () => {
    const { probe } = renderSection(OperationsSection, { doc: richDoc() });
    openCard("reply");
    fireEvent.click(box("operation-reply-toggle"));
    expect(probe.draft.doc.operations[0].reply).toEqual({ channelKey: "refunds", messageKeys: [] });
    expect(field("Reply channel").value).toBe("refunds");
    expect(checklist("operation-reply-messages")).toEqual(["RefundIssued"]);
    expect(probe.draft.problems).toEqual([]);
  });

  it("falls back to the operation's own channel when it is the only one", () => {
    const doc = sampleDocument();
    doc.channels = [doc.channels[0]];
    const { probe } = renderSection(OperationsSection, { doc });
    openCard("reply");
    fireEvent.click(box("operation-reply-toggle"));
    expect(probe.draft.doc.operations[0].reply).toEqual({ channelKey: "orders", messageKeys: [] });
    expect(probe.draft.problems).toEqual([]);
  });

  it("limits the reply messages to the reply channel's messages and toggles reply.messageKeys", () => {
    const { probe } = renderSection(OperationsSection, { doc: docWithReply(), item: "askRefund" });
    expect(box("operation-reply-toggle").checked).toBe(true);
    expect(optionValues(field("Reply channel"))).toEqual(["orders", "refunds", "empty"]);
    expect(checklist("operation-reply-messages")).toEqual(["RefundIssued"]);
    expect(box("operation-reply-messages-option-RefundIssued").checked).toBe(true);
    fireEvent.click(box("operation-reply-messages-option-RefundIssued"));
    expect(probe.draft.doc.operations[1].reply).toEqual({ channelKey: "refunds", messageKeys: [] });
    fireEvent.click(box("operation-reply-messages-option-RefundIssued"));
    expect(probe.draft.doc.operations[1].reply).toEqual({ channelKey: "refunds", messageKeys: ["RefundIssued"] });
    expect(probe.draft.problems).toEqual([]);
  });

  it("changing the reply channel drops reply messages that are not on it and says so", () => {
    const { probe } = renderSection(OperationsSection, { doc: docWithReply(), item: "askRefund" });
    type(field("Reply channel"), "orders");
    expect(probe.draft.doc.operations[1].reply).toEqual({ channelKey: "orders", messageKeys: [] });
    expect(text("operation-reply-notice")).toContain("RefundIssued");
    expect(text("operation-reply-notice")).toContain('"orders"');
    expect(checklist("operation-reply-messages")).toEqual(["OrderCreated", "OrderUpdated"]);
    expect(probe.draft.problems).toEqual([]);
    // The request side is untouched by a reply-channel change.
    expect(probe.draft.doc.operations[1]).toMatchObject({ channelKey: "orders", messageKeys: ["OrderUpdated"] });
    expect(missing("operation-channel-notice")).toBe(true);
  });

  it("changing the operation's channel does not touch its reply", () => {
    const { probe } = renderSection(OperationsSection, { doc: docWithReply(), item: "askRefund" });
    type(field("Channel"), "refunds");
    expect(probe.draft.doc.operations[1].reply).toEqual({ channelKey: "refunds", messageKeys: ["RefundIssued"] });
    expect(probe.draft.doc.operations[1].messageKeys).toEqual([]);
  });

  it("turning it off removes the reply entirely, and the card stays open for the next try", () => {
    const { probe } = renderSection(OperationsSection, { doc: docWithReply(), item: "askRefund" });
    fireEvent.click(box("operation-reply-toggle"));
    expect("reply" in probe.draft.doc.operations[1]).toBe(false);
    expect(missing("operation-reply-channel")).toBe(true);
    expect(isOpen("reply")).toBe(true);
    expect(probe.draft.problems).toEqual([]);
  });

  it("an unknown reply channel and a foreign reply message are shown at their fields", () => {
    const doc = docWithReply();
    doc.operations[1] = { ...doc.operations[1], reply: { channelKey: "refunds", messageKeys: ["RefundIssued", "OrderCreated"] } };
    renderSection(OperationsSection, { doc, item: "askRefund" });
    expect(text("operation-reply-messages-error")).toBe('Message "OrderCreated" is not allowed on channel "refunds"');
    expect(box("operation-reply-messages-option-OrderCreated").closest("label")?.textContent).toContain("not on this channel");
    cleanup();
    const broken = docWithReply();
    broken.operations[1] = { ...broken.operations[1], reply: { channelKey: "ghost", messageKeys: [] } };
    renderSection(OperationsSection, { doc: broken, item: "askRefund" });
    expect(text("operation-reply-channel-error")).toBe('Unknown channel "ghost"');
    expect(field("Reply channel").getAttribute("aria-invalid")).toBe("true");
  });
});

describe("OperationsSection: identifier, documentation and removal", () => {
  it("has no Key field in the form: the identifier is generated and tucked into a collapsed disclosure", () => {
    renderSection(OperationsSection);
    expect(screen.queryByLabelText("Key")).toBeNull();
    expect((screen.getByTestId("operation-key-disclosure") as HTMLDetailsElement).open).toBe(false);
    expect(text("operation-key-value")).toBe("publishOrder");
    expect(screen.getByTestId("operation-form").contains(screen.getByTestId("operation-key-disclosure"))).toBe(true);
  });

  it("renaming the identifier goes through renameKey, keeps the operation selected and rejects a taken key", () => {
    const { probe } = renderSection(OperationsSection, { doc: docWithReply() });
    type(box("operation-key"), "askRefund");
    fireEvent.blur(box("operation-key"));
    expect(text("operation-key-error")).toBe('The key "askRefund" is already used.');
    expect(probe.draft.dirty).toBe(false);
    type(box("operation-key"), "emitOrder");
    fireEvent.blur(box("operation-key"));
    expect(probe.draft.doc.operations.map((o) => o.key)).toEqual(["emitOrder", "askRefund"]);
    expect(probe.item).toBe("emitOrder");
    expect(screen.getByTestId("operation-row-emitOrder").getAttribute("aria-current")).toBe("true");
    expect(probe.draft.problems).toEqual([]);
  });

  it("editing the channel, action, title or messages never rewrites a key the document already had", () => {
    const { probe } = renderSection(OperationsSection, { doc: richDoc() });
    click("operation-action-receive");
    type(field("Channel"), "refunds");
    fireEvent.blur(field("Channel"));
    type(field("Title"), "Publish");
    fireEvent.blur(field("Title"));
    expect(probe.draft.doc.operations[0].key).toBe("publishOrder");
    expect(probe.item).toBeNull();
  });

  it("opens the identifier and shows the problem the document reports for the key", async () => {
    const saveDocument = vi.fn<SaveDocument>().mockResolvedValue({
      success: false, error: "1 problem(s) in the event document", code: "VALIDATION_ERROR",
      details: { problems: [{ pointer: "/operations/0/key", message: 'Key "constructor" is reserved — choose another key' }] },
    });
    renderBuilder({ saveDocument, section: "operations" });
    type(field("Summary"), "Changed");
    await act(async () => { click("builder-save"); });
    expect(text("operation-key-error")).toBe('Key "constructor" is reserved — choose another key');
    expect((screen.getByTestId("operation-key-disclosure") as HTMLDetailsElement).open).toBe(true);
  });

  it("edits summary and description and removes them when blanked", () => {
    const { probe } = renderSection(OperationsSection);
    type(field("Summary"), "Publish an order");
    type(field("Description"), "Emitted after checkout");
    expect(probe.draft.doc.operations[0]).toMatchObject({ summary: "Publish an order", description: "Emitted after checkout" });
    type(field("Summary"), "");
    type(field("Description"), "");
    expect("summary" in probe.draft.doc.operations[0]).toBe(false);
    expect("description" in probe.draft.doc.operations[0]).toBe(false);
  });

  it("keeps the trait references and bindings the operation already has when something else is edited", () => {
    const doc = sampleDocument();
    doc.traits = [{ key: "retry", kind: "OPERATION", spec: {} }];
    doc.operations[0] = { ...doc.operations[0], traitKeys: ["retry"], bindings: { kafka: { groupId: { type: "string" }, bindingVersion: "0.5.0" } } };
    const { probe } = renderSection(OperationsSection, { doc });
    type(field("Summary"), "x");
    click("operation-action-receive");
    expect(probe.draft.doc.operations[0]).toMatchObject({ traitKeys: ["retry"], bindings: { kafka: { groupId: { type: "string" }, bindingVersion: "0.5.0" } } });
    expect(probe.draft.problems).toEqual([]);
  });

  it("removes the selected operation without asking and selects the first remaining one", () => {
    const confirm = vi.spyOn(window, "confirm").mockReturnValue(true);
    const { probe } = renderSection(OperationsSection, { doc: docWithReply(), item: "askRefund" });
    click("operation-remove");
    expect(confirm).not.toHaveBeenCalled();
    expect(probe.draft.doc.operations.map((o) => o.key)).toEqual(["publishOrder"]);
    expect(probe.item).toBeNull();
    expect(text("operation-key-value")).toBe("publishOrder");
    expect(probe.draft.problems).toEqual([]);
  });

  it("removing the last operation shows the empty state again", () => {
    const { probe } = renderSection(OperationsSection);
    click("operation-remove");
    expect(probe.draft.doc.operations).toEqual([]);
    expect(screen.getByTestId("operation-empty")).toBeDefined();
  });
});

describe("OperationsSection: pointer errors land under the right field", () => {
  it("shows the problems of a failed save at their fields, linked for assistive technology", async () => {
    const saveDocument = vi.fn<SaveDocument>().mockResolvedValue({
      success: false, error: "4 problem(s) in the event document", code: "VALIDATION_ERROR",
      details: { problems: [
        { pointer: "/operations/0/messageKeys/0", message: 'Message "OrderCreated" is not allowed on channel "orders"' },
        { pointer: "/operations/0/channelKey", message: "channel is not available" },
        { pointer: "/operations/0/reply/channelKey", message: "reply channel is not available" },
        { pointer: "/operations/0/summary", message: "summary is too long" },
      ] },
    });
    const { probe } = renderBuilder({ saveDocument, section: "operations", doc: docWithReply() });
    type(field("Summary"), "Changed");
    await act(async () => { click("builder-save"); });
    expect(text("operation-messages-error")).toBe('Message "OrderCreated" is not allowed on channel "orders"');
    expect((screen.getByTestId("operation-messages").getAttribute("aria-describedby") ?? "").split(" ")).toContain("operation-messages-error");
    expect(text("operation-channel-error")).toBe("channel is not available");
    expect(field("Channel").getAttribute("aria-invalid")).toBe("true");
    expect(text("operation-summary-error")).toBe("summary is too long");
    expect(field("Summary").value).toBe("Changed");
    expect(probe.draft.dirty).toBe(true);
    // The reply's own field only appears for an operation that has a reply.
    click("operation-row-askRefund");
    expect(missing("operation-reply-channel-error")).toBe(true);
  });

  it("shows the reply problems of the operation that has a reply", async () => {
    const saveDocument = vi.fn<SaveDocument>().mockResolvedValue({
      success: false, error: "2 problem(s) in the event document", code: "VALIDATION_ERROR",
      details: { problems: [
        { pointer: "/operations/1/reply/channelKey", message: "reply channel is not available" },
        { pointer: "/operations/1/reply/messageKeys/0", message: "reply message is not available" },
      ] },
    });
    renderBuilder({ saveDocument, section: "operations", item: "askRefund", doc: docWithReply() });
    type(field("Summary"), "Changed");
    await act(async () => { click("builder-save"); });
    expect(text("operation-reply-channel-error")).toBe("reply channel is not available");
    expect(text("operation-reply-messages-error")).toBe("reply message is not available");
  });

  it("does not show the problems of another operation", () => {
    const doc = docWithReply();
    doc.operations[1] = { ...doc.operations[1], channelKey: "ghost" };
    renderSection(OperationsSection, { doc });
    expect(missing("operation-channel-error")).toBe(true);
    click("operation-row-askRefund");
    expect(text("operation-channel-error")).toBe('Unknown channel "ghost"');
  });
});

describe("Operations stay consistent with the other sections (review focus: references and channel/operation consistency)", () => {
  it("removing a message in Messages empties it from the operation's checklist and leaves the document valid", async () => {
    vi.spyOn(window, "confirm").mockReturnValue(true);
    const { probe } = renderBuilder({ doc: richDoc(), section: "messages", item: "OrderCreated" });
    await screen.findByLabelText("Payload entity");
    click("message-remove");
    click("outline-operations");
    expect(checklist("operation-messages")).toEqual(["OrderUpdated"]);
    expect(probe.draft.doc.operations[0].messageKeys).toEqual([]);
    expect(probe.draft.problems).toEqual([]);
  });

  it("allowing another message in Channels makes it appear in the operation's checklist", () => {
    const { probe } = renderBuilder({ doc: richDoc(), section: "channels", item: "refunds" });
    fireEvent.click(box("channel-messages-option-OrderCreated"));
    click("outline-operations");
    type(field("Channel"), "refunds");
    expect(checklist("operation-messages")).toEqual(["RefundIssued", "OrderCreated"]);
    expect(probe.draft.problems).toEqual([]);
  });

  it("a channel cannot disallow a message an operation uses, so the Operations section never shows a stray message after the user's own edits", () => {
    const { probe } = renderBuilder({ doc: richDoc(), section: "channels", item: "orders" });
    fireEvent.click(box("channel-messages-option-OrderCreated"));
    expect(text("channel-messages-blocked")).toContain("publishOrder");
    click("outline-operations");
    expect(box("operation-messages-option-OrderCreated").checked).toBe(true);
    expect(missing("operation-messages-error")).toBe(true);
    expect(probe.draft.problems).toEqual([]);
  });

  it("removing a channel in Channels removes its operations from the Operations list", () => {
    vi.spyOn(window, "confirm").mockReturnValue(true);
    const { probe } = renderBuilder({ doc: docWithReply(), section: "channels", item: "orders" });
    click("channel-remove");
    click("outline-operations");
    // Both operations sat on "orders": they are gone with it, and the remaining channels are offered to a new one.
    expect(text("operation-empty")).toContain("No operations yet");
    expect(probe.draft.doc.operations).toEqual([]);
    expect(probe.draft.problems).toEqual([]);
  });
});

describe("OperationsSection: generated keys", () => {
  it("Add operation starts with a placeholder key, selects it, and keeps placeholders unique", () => {
    const { probe } = renderSection(OperationsSection);
    click("operation-add");
    click("operation-add");
    expect(probe.draft.doc.operations.map((o) => o.key)).toEqual(["publishOrder", "operation", "operation-2"]);
    expect(probe.item).toBe("operation-2");
  });

  it("names the key from the title once the user leaves the field, and keeps the operation selected", () => {
    const { probe } = renderSection(OperationsSection);
    click("operation-add");
    type(field("Title"), "Place order");
    expect(probe.draft.doc.operations[1].key).toBe("operation");
    fireEvent.blur(field("Title"));
    expect(probe.draft.doc.operations[1].key).toBe("Place-order");
    expect(probe.item).toBe("Place-order");
    expect(screen.getByTestId("operation-row-Place-order").getAttribute("aria-current")).toBe("true");
    expect(text("operation-key-value")).toBe("Place-order");
    expect(probe.draft.problems).toEqual([]);
  });

  it("waits while focus moves between fields, so a title typed after choosing the action still names the key", () => {
    const { probe } = renderSection(OperationsSection, { doc: richDoc() });
    click("operation-add");
    click("operation-action-receive");
    fireEvent.blur(box("operation-action-receive"), { relatedTarget: field("Title") });
    expect(probe.draft.doc.operations[1].key).toBe("operation");
    type(field("Title"), "Process order");
    fireEvent.blur(field("Title"));
    expect(probe.draft.doc.operations[1].key).toBe("Process-order");
  });

  it("without a title it names the key from the action and the channel", () => {
    const { probe } = renderSection(OperationsSection);
    click("operation-add");
    fireEvent.blur(field("Summary"));
    expect(probe.draft.doc.operations[1].key).toBe("send-orders");
    expect(probe.item).toBe("send-orders");
  });

  it("renames only once: later edits of the title, action or channel do not change the generated key", () => {
    const { probe } = renderSection(OperationsSection, { doc: richDoc() });
    click("operation-add");
    type(field("Title"), "Place order");
    fireEvent.blur(field("Title"));
    type(field("Title"), "Place an order");
    fireEvent.blur(field("Title"));
    click("operation-action-receive");
    type(field("Channel"), "refunds");
    fireEvent.blur(field("Channel"));
    expect(probe.draft.doc.operations[1].key).toBe("Place-order");
    expect(probe.item).toBe("Place-order");
  });

  it("a manually chosen identifier is never replaced by a generated one", () => {
    const { probe } = renderSection(OperationsSection);
    click("operation-add");
    type(box("operation-key"), "emit-order");
    fireEvent.blur(box("operation-key"));
    expect(probe.draft.doc.operations[1].key).toBe("emit-order");
    expect(probe.item).toBe("emit-order");
    type(field("Title"), "Place order");
    fireEvent.blur(field("Title"));
    expect(probe.draft.doc.operations[1].key).toBe("emit-order");
  });

  it("two operations with the same title or the same action and channel get distinct keys", () => {
    const { probe } = renderSection(OperationsSection);
    click("operation-add");
    type(field("Title"), "Place order");
    fireEvent.blur(field("Title"));
    click("operation-add");
    type(field("Title"), "Place order");
    fireEvent.blur(field("Title"));
    click("operation-add");
    fireEvent.blur(field("Summary"));
    click("operation-add");
    fireEvent.blur(field("Summary"));
    expect(probe.draft.doc.operations.map((o) => o.key)).toEqual(["publishOrder", "Place-order", "Place-order-2", "send-orders", "send-orders-2"]);
    expect(probe.draft.problems).toEqual([]);
  });

  it("the automatic rename of one operation leaves the other operations and their references alone", () => {
    const { probe } = renderSection(OperationsSection, { doc: docWithReply() });
    click("operation-add");
    type(field("Title"), "Third");
    fireEvent.blur(field("Title"));
    expect(probe.draft.doc.operations.map((o) => o.key)).toEqual(["publishOrder", "askRefund", "Third"]);
    expect(probe.draft.doc.operations[1].reply).toEqual({ channelKey: "refunds", messageKeys: ["RefundIssued"] });
  });
});

describe("OperationsSection: every AsyncAPI operation property", () => {
  it("is reachable: each property of the operation template has an element, including inside the collapsed cards", () => {
    renderSection(OperationsSection);
    openAllCards();
    const keys = TEMPLATES.operation.fields.map((f) => f.key);
    expect(keys).toEqual(["action", "channel", "title", "summary", "description", "messages", "reply", "traits", "security", "tags", "externalDocs", "bindings"]);
    // action, channel, messages, reply, traits and bindings are drawn by hand (they only offer valid combinations); the rest by the template form.
    const testIdOf: Record<string, string> = { reply: "operation-reply-toggle", traits: "operation-props" };
    for (const key of keys) expect(screen.queryByTestId(testIdOf[key] ?? `operation-${key}`), `operation.${key}`).not.toBeNull();
  });

  it("keeps Basics, Operation properties (Trait) and Details open and Reply, Bindings, Docs & tags and Security collapsed", () => {
    renderSection(OperationsSection);
    for (const card of ["basics", "properties", "details"] as const) expect(isOpen(card), card).toBe(true);
    for (const card of ["reply", "bindings", "docs", "security"] as const) expect(isOpen(card), card).toBe(false);
    for (const key of ["security", "tags", "externalDocs", "bindings"]) expect(missing(`operation-${key}`), key).toBe(true);
    for (const key of ["title", "summary", "description"]) expect(missing(`operation-${key}`)).toBe(false);
    // The template form's own 'More properties' toggle is gone: the cards are the grouping.
    expect(missing("operation-more-toggle")).toBe(true);
  });

  it("titles the cards Basics, Reply, Operation properties (Trait), Details, Bindings, Docs & tags, Security", () => {
    renderSection(OperationsSection);
    const titles = within(screen.getByTestId("operation-form")).getAllByRole("heading", { level: 3 }).map((h) => h.textContent?.replace(/\d+\s*set$/, "").trim());
    expect(titles).toEqual(["Basics", "Reply", "Operation properties (Trait)", "Details", "Bindings", "Docs & tags", "Security"]);
  });

  it("shows how many fields are set on a card, and nothing on a card with nothing set", () => {
    const doc = sampleDocument();
    doc.components = { securitySchemes: { basic: { type: "userPassword" } } };
    doc.operations[0] = {
      ...doc.operations[0], title: "Publish", summary: "S", security: ["basic"], tags: [{ name: "a" }, { name: "b" }], externalDocs: { url: "https://example.com" },
      bindings: { kafka: { bindingVersion: "0.5.0" } }, traitKeys: [],
    };
    renderSection(OperationsSection, { doc });
    const count = (card: Card) => screen.queryByTestId(`operation-card-${card}-count`)?.textContent ?? null;
    expect(count("details")).toBe("2");
    expect(count("docs")).toBe("3");
    expect(count("security")).toBe("1");
    expect(count("bindings")).toBe("1");
    expect(count("properties")).toBeNull();
    expect(count("basics")).toBeNull();
  });

  it("keeps a card open or closed while switching to another operation", () => {
    renderSection(OperationsSection, { doc: docWithReply() });
    openCard("docs");
    fireEvent.click(screen.getByTestId("operation-card-details-toggle"));
    click("operation-row-askRefund");
    expect(isOpen("docs")).toBe(true);
    expect(isOpen("details")).toBe(false);
    // Reply has no choice of its own: it follows the operation.
    expect(isOpen("reply")).toBe(true);
    click("operation-row-publishOrder");
    expect(isOpen("docs")).toBe(true);
    expect(isOpen("reply")).toBe(false);
  });

  it("opens the card that holds a problem when the document reports one", () => {
    const doc = sampleDocument();
    doc.operations[0] = { ...doc.operations[0], externalDocs: { url: "nope" } };
    renderSection(OperationsSection, { doc });
    expect(isOpen("docs")).toBe(true);
    expect(text("operation-externalDocs-url-error")).toBeTruthy();
  });

  it("edits the title and removes it when blanked", () => {
    const { probe } = renderSection(OperationsSection);
    type(field("Title"), "Publish an order");
    expect(probe.draft.doc.operations[0].title).toBe("Publish an order");
    type(field("Title"), "");
    expect("title" in probe.draft.doc.operations[0]).toBe(false);
  });

  it("writes external documentation and tags, and removes them when emptied", () => {
    const { probe } = renderSection(OperationsSection);
    openCard("docs");
    type(box("operation-externalDocs-url"), "https://example.com/docs");
    type(box("operation-tags"), "orders");
    fireEvent.keyDown(box("operation-tags"), { key: "Enter" });
    expect(probe.draft.doc.operations[0]).toMatchObject({ externalDocs: { url: "https://example.com/docs" }, tags: [{ name: "orders" }] });
    expect(probe.draft.problems).toEqual([]);
    type(box("operation-externalDocs-url"), "");
    fireEvent.click(screen.getByTestId("operation-tags-chip-0-remove"));
    expect("externalDocs" in probe.draft.doc.operations[0]).toBe(false);
    expect("tags" in probe.draft.doc.operations[0]).toBe(false);
  });

  it("security lists the keys of components.securitySchemes and writes the chosen ones", () => {
    const doc = sampleDocument();
    doc.components = { securitySchemes: { basic: { type: "userPassword" }, sasl: { type: "plain" } } };
    const { probe } = renderSection(OperationsSection, { doc });
    openCard("security");
    const group = screen.getByTestId("operation-security");
    expect(Array.from(group.querySelectorAll("input[type=checkbox]")).map((i) => i.getAttribute("data-testid"))).toEqual([
      "operation-security-option-basic", "operation-security-option-sasl",
    ]);
    fireEvent.click(box("operation-security-option-basic"));
    expect(probe.draft.doc.operations[0].security).toEqual(["basic"]);
    fireEvent.click(box("operation-security-option-basic"));
    expect("security" in probe.draft.doc.operations[0]).toBe(false);
    expect(probe.draft.problems).toEqual([]);
  });

  it("the traits multi-reference is gone: the Operation properties card draws the applied sets and keeps the operation's traitKeys", () => {
    const doc = sampleDocument();
    doc.traits = [{ key: "retry", kind: "OPERATION", spec: { title: "Retry" } }];
    doc.operations[0] = { ...doc.operations[0], traitKeys: ["retry"] };
    const { probe } = renderSection(OperationsSection, { doc });
    expect(missing("operation-traits")).toBe(true);
    expect(screen.queryAllByTestId(/^operation-traits-option-/)).toHaveLength(0);
    expect(screen.getByTestId("operation-prop-row-retry")).toBeDefined();
    type(field("Title"), "Publish");
    expect(probe.draft.doc.operations[0].traitKeys).toEqual(["retry"]);
  });

  it("says no operation properties are applied yet instead of showing an empty list", () => {
    renderSection(OperationsSection);
    expect(text("operation-prop-empty")).toContain("No operation properties on this operation yet");
  });

  it("shows the optional-field help as an info tooltip", () => {
    renderSection(OperationsSection);
    const button = screen.getByTestId("operation-summary-hint-button");
    expect(button.getAttribute("aria-label")).toBe("About Summary");
    expect(button.getAttribute("aria-describedby")).toBe("operation-summary-hint");
  });

  describe("the reply address", () => {
    it("is a template form under the reply, written to reply.address and removed when emptied", () => {
      const { probe } = renderSection(OperationsSection, { doc: richDoc() });
      openCard("reply");
      fireEvent.click(box("operation-reply-toggle"));
      type(box("operation-reply-address-location"), "$message.header#/replyTo");
      type(box("operation-reply-address-description"), "Where the reply goes");
      expect(probe.draft.doc.operations[0].reply).toEqual({
        channelKey: "refunds", messageKeys: [], address: { location: "$message.header#/replyTo", description: "Where the reply goes" },
      });
      expect(probe.draft.problems).toEqual([]);
      type(box("operation-reply-address-location"), "");
      type(box("operation-reply-address-description"), "");
      expect(probe.draft.doc.operations[0].reply).toEqual({ channelKey: "refunds", messageKeys: [] });
    });

    it("survives a change of the reply channel and of the reply messages", () => {
      const doc = docWithReply();
      doc.operations[1] = { ...doc.operations[1], reply: { ...doc.operations[1].reply, address: { location: "$message.header#/replyTo" } } };
      const { probe } = renderSection(OperationsSection, { doc, item: "askRefund" });
      expect(box("operation-reply-address-location").value).toBe("$message.header#/replyTo");
      type(field("Reply channel"), "orders");
      fireEvent.click(box("operation-reply-messages-option-OrderCreated"));
      expect(probe.draft.doc.operations[1].reply).toEqual({
        channelKey: "orders", messageKeys: ["OrderCreated"], address: { location: "$message.header#/replyTo" },
      });
    });

    it("is not shown without a reply", () => {
      renderSection(OperationsSection);
      openCard("reply");
      expect(missing("operation-reply-address-location")).toBe(true);
    });

    it("shows the problem of an address location that is not a runtime expression under the field", () => {
      const { probe } = renderSection(OperationsSection, { doc: richDoc() });
      openCard("reply");
      fireEvent.click(box("operation-reply-toggle"));
      type(box("operation-reply-address-location"), "replyTo");
      const problem = probe.draft.problems.find((p) => p.pointer === "/operations/0/reply/address/location");
      expect(problem).toBeDefined();
      expect(text("operation-reply-address-location-error")).toBe(problem!.message);
      expect(box("operation-reply-address-location").getAttribute("aria-invalid")).toBe("true");
    });
  });

  describe("bindings", () => {
    it("preselects the protocol of the operation's channel, writes the template's fields with bindingVersion and drops `bindings` when cleared", () => {
      const { probe } = renderSection(OperationsSection);
      openCard("bindings");
      expect((screen.getByTestId("operation-bindings-protocol") as unknown as HTMLSelectElement).value).toBe("kafka");
      click("operation-bindings-add");
      type(box("operation-bindings-kafka-groupId"), '{"type":"string","enum":["checkout"]}');
      expect(probe.draft.doc.operations[0].bindings).toEqual({
        kafka: { groupId: { type: "string", enum: ["checkout"] }, bindingVersion: bindingVersion("kafka", "operation") },
      });
      expect(probe.draft.problems).toEqual([]);
      type(box("operation-bindings-kafka-groupId"), "");
      expect("bindings" in probe.draft.doc.operations[0]).toBe(false);
    });
  });

  it("an operation that uses every property keeps all of them when one is edited", () => {
    const doc = maximalDocument();
    expect(parseEventDocument(doc).success).toBe(true);
    const before = structuredClone(doc.operations[0]);
    const { probe } = renderSection(OperationsSection, { doc });
    expect(probe.draft.problems).toEqual([]);
    type(field("Title"), "Create an order");
    expect(probe.draft.doc.operations[0]).toEqual({ ...before, title: "Create an order" });
    expect(probe.draft.problems).toEqual([]);
  });

  it("a new operation with only the basics still gives a valid document with no empty extras", () => {
    const { probe } = renderSection(OperationsSection);
    click("operation-add");
    fireEvent.blur(field("Summary"));
    expect(probe.draft.doc.operations[1]).toEqual({ key: "send-orders", action: "send", channelKey: "orders", messageKeys: [], traitKeys: [] });
    expect(parseEventDocument(probe.draft.doc).success).toBe(true);
    expect(probe.draft.problems).toEqual([]);
  });

  it("shows the problems of a failed save under the property they point at, opening the card that holds them", async () => {
    const saveDocument = vi.fn<SaveDocument>().mockResolvedValue({
      success: false, error: "3 problem(s) in the event document", code: "VALIDATION_ERROR",
      details: { problems: [
        { pointer: "/operations/0/title", message: "title is too long" },
        { pointer: "/operations/0/externalDocs/url", message: "url must be an absolute URL" },
        { pointer: "/operations/0/tags/0/name", message: "tag name is required" },
      ] },
    });
    renderBuilder({ saveDocument, section: "operations" });
    type(field("Summary"), "Changed");
    await act(async () => { click("builder-save"); });
    expect(text("operation-title-error")).toBe("title is too long");
    expect(text("operation-externalDocs-url-error")).toBe("url must be an absolute URL");
    expect(box("operation-externalDocs-url").getAttribute("aria-invalid")).toBe("true");
    expect(missing("operation-summary-error")).toBe(true);
  });
});
