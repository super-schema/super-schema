// @vitest-environment jsdom
// IdentifierDisclosure: a collapsed "Identifier" under each item's form. It shows the generated key as monospace text, explains it,
// and (once opened) lets the user rename it; the rename goes through renameKey, so every reference follows.
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { useEffect, useState } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { IDENTIFIER_HELP, IdentifierDisclosure } from "@/features/events/builder/Identifier";
import { renameKey } from "@/lib/events/document/keys";
import { emptyEventDocument, type EventDocument } from "@/lib/events/document/types";

afterEach(cleanup);

const type = (el: HTMLElement, value: string) => fireEvent.change(el, { target: { value } });
const details = () => screen.getByTestId("server-key-disclosure") as HTMLDetailsElement;
const input = () => screen.getByLabelText("Identifier") as HTMLInputElement;

describe("IdentifierDisclosure", () => {
  it("is a collapsed <details> titled Identifier by default", () => {
    render(<IdentifierDisclosure id="server-key" value="kafka-prod" taken={[]} onRename={vi.fn()} />);
    expect(details().tagName).toBe("DETAILS");
    expect(details().open).toBe(false);
    expect(screen.getByTestId("server-key-toggle").tagName).toBe("SUMMARY");
    expect(screen.getByTestId("server-key-toggle").textContent).toContain("Identifier");
  });

  it("shows the generated key as monospace text even while collapsed", () => {
    render(<IdentifierDisclosure id="server-key" value="kafka-prod" taken={[]} onRename={vi.fn()} />);
    const value = screen.getByTestId("server-key-value");
    expect(value.textContent).toBe("kafka-prod");
    expect(value.tagName).toBe("CODE");
    expect(value.className).toContain("font-mono");
    expect(screen.getByTestId("server-key-toggle").contains(value)).toBe(true);
  });

  it("explains what the identifier is for and that it is generated", () => {
    render(<IdentifierDisclosure id="server-key" value="kafka-prod" taken={[]} onRename={vi.fn()} />);
    expect(IDENTIFIER_HELP).toBe("Used to refer to this item inside the document. Generated for you — rename only if you need a specific name.");
    expect(screen.getByTestId("server-key-help").textContent).toBe(IDENTIFIER_HELP);
    expect(details().contains(screen.getByTestId("server-key-help"))).toBe(true);
  });

  it("holds the rename input, with the key in it, inside the details (visible once it is opened)", () => {
    render(<IdentifierDisclosure id="server-key" value="kafka-prod" taken={[]} onRename={vi.fn()} />);
    expect(input().value).toBe("kafka-prod");
    expect(input().getAttribute("data-testid")).toBe("server-key");
    expect(details().contains(input())).toBe(true);
    details().open = true;
    expect(details().open).toBe(true);
  });

  it("uses the label it is given for the title and the input", () => {
    render(<IdentifierDisclosure id="op-key" value="send-orders" taken={[]} onRename={vi.fn()} label="Operation identifier" />);
    expect(screen.getByTestId("op-key-toggle").textContent).toContain("Operation identifier");
    expect(screen.getByLabelText("Operation identifier")).toBe(screen.getByTestId("op-key"));
  });

  it("commits a valid new key through onRename on blur", () => {
    const onRename = vi.fn();
    render(<IdentifierDisclosure id="server-key" value="kafka-prod" taken={["kafka-dev"]} onRename={onRename} />);
    type(input(), "kafka-primary");
    expect(onRename).not.toHaveBeenCalled();
    fireEvent.blur(input());
    expect(onRename).toHaveBeenCalledTimes(1);
    expect(onRename).toHaveBeenCalledWith("kafka-primary");
  });

  it("refuses a key another item holds, says why, and does not call onRename", () => {
    const onRename = vi.fn();
    render(<IdentifierDisclosure id="server-key" value="kafka-prod" taken={["kafka-dev"]} onRename={onRename} />);
    type(input(), "kafka-dev");
    fireEvent.blur(input());
    expect(screen.getByTestId("server-key-error").textContent).toBe('The key "kafka-dev" is already used.');
    expect(onRename).not.toHaveBeenCalled();
  });

  it("refuses a key with a space", () => {
    const onRename = vi.fn();
    render(<IdentifierDisclosure id="server-key" value="kafka-prod" taken={[]} onRename={onRename} />);
    type(input(), "two words");
    fireEvent.blur(input());
    expect(screen.getByTestId("server-key-error").textContent).toContain("no spaces");
    expect(onRename).not.toHaveBeenCalled();
  });

  it("a rename through renameKey rewrites the references and the disclosure follows the new key", () => {
    const doc: EventDocument = {
      ...emptyEventDocument("Orders"),
      servers: [{ key: "server", protocol: "kafka", host: "a:1" }, { key: "other", protocol: "kafka", host: "b:1" }],
      channels: [{ key: "orders", address: "orders", protocol: "kafka", serverKeys: ["server", "other"], format: "avro", messageKeys: [] }],
    };
    const seen = { doc };
    function Host() {
      const [current, setCurrent] = useState(doc);
      useEffect(() => { seen.doc = current; });
      return (
        <IdentifierDisclosure
          id="server-key" value={current.servers[0].key} taken={current.servers.slice(1).map((s) => s.key)}
          onRename={(next) => {
            const renamed = renameKey(current, "server", current.servers[0].key, next);
            if (renamed.success) setCurrent(renamed.data);
          }}
        />
      );
    }
    render(<Host />);
    type(input(), "kafka-primary");
    fireEvent.blur(input());
    expect(seen.doc.servers.map((s) => s.key)).toEqual(["kafka-primary", "other"]);
    expect(seen.doc.channels[0].serverKeys).toEqual(["kafka-primary", "other"]);
    expect(screen.getByTestId("server-key-value").textContent).toBe("kafka-primary");
    expect(input().value).toBe("kafka-primary");
  });

  it("opens itself and shows the problem the document reports for the key", () => {
    const { rerender } = render(<IdentifierDisclosure id="server-key" value="constructor" taken={[]} onRename={vi.fn()} />);
    expect(details().open).toBe(false);
    rerender(<IdentifierDisclosure id="server-key" value="constructor" taken={[]} onRename={vi.fn()} error="Key is reserved" />);
    expect(details().open).toBe(true);
    expect(screen.getByTestId("server-key-error").textContent).toBe("Key is reserved");
    expect(input().getAttribute("aria-invalid")).toBe("true");
  });

  it("follows a key that changes from outside (an automatic rename)", () => {
    const { rerender } = render(<IdentifierDisclosure id="server-key" value="server" taken={[]} onRename={vi.fn()} />);
    rerender(<IdentifierDisclosure id="server-key" value="broker.example.com-9092" taken={[]} onRename={vi.fn()} />);
    expect(screen.getByTestId("server-key-value").textContent).toBe("broker.example.com-9092");
    expect(input().value).toBe("broker.example.com-9092");
  });
});
