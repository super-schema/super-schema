// @vitest-environment jsdom
import { useState } from "react";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { FormCard, useCardState } from "@/features/events/builder/sections/FormCard";

afterEach(cleanup);

/** Two cards behind the real hook; `errored` and `defaults` are set from outside like a section does. */
function Host({ defaults, errored }: { defaults: Record<string, boolean>; errored: string[] }) {
  const cards = useCardState(defaults, new Set(errored));
  return (
    <div>
      {["a", "b"].map((id) => (
        <FormCard key={id} testId={`card-${id}`} title={`Card ${id}`} count={id === "a" ? 3 : 0} open={cards.isOpen(id)} onOpenChange={(o) => cards.setOpen(id, o)}>
          <p data-testid={`body-${id}`}>body {id}</p>
        </FormCard>
      ))}
    </div>
  );
}
const expanded = (id: string) => screen.getByTestId(`card-${id}-toggle`).getAttribute("aria-expanded");

describe("FormCard", () => {
  it("renders the title as a heading button with aria-expanded and aria-controls, and no body while closed", () => {
    render(<FormCard testId="c" title="Details" open={false} onOpenChange={() => undefined}><p>inside</p></FormCard>);
    const toggle = screen.getByTestId("c-toggle");
    expect(screen.getByRole("heading", { level: 3 }).textContent).toBe("Details");
    expect(toggle.tagName).toBe("BUTTON");
    expect(toggle.getAttribute("aria-expanded")).toBe("false");
    expect(screen.queryByTestId("c-body")).toBeNull();
  });

  it("shows the body as a labelled region when open, linked from aria-controls", () => {
    render(<FormCard testId="c" title="Details" open onOpenChange={() => undefined}><p>inside</p></FormCard>);
    const body = screen.getByTestId("c-body");
    expect(body.getAttribute("role")).toBe("region");
    expect(screen.getByTestId("c-toggle").getAttribute("aria-controls")).toBe(body.id);
    expect(body.getAttribute("aria-labelledby")).toBe(screen.getByRole("heading", { level: 3 }).id);
    expect(body.textContent).toBe("inside");
  });

  it("asks to open or close when the heading is pressed", () => {
    const calls: boolean[] = [];
    const { rerender } = render(<FormCard testId="c" title="T" open={false} onOpenChange={(o) => calls.push(o)}><p>x</p></FormCard>);
    fireEvent.click(screen.getByTestId("c-toggle"));
    rerender(<FormCard testId="c" title="T" open onOpenChange={(o) => calls.push(o)}><p>x</p></FormCard>);
    fireEvent.click(screen.getByTestId("c-toggle"));
    expect(calls).toEqual([true, false]);
  });

  it("shows a count badge only for a count above zero, readable by a screen reader through the button", () => {
    const { rerender } = render(<FormCard testId="c" title="Examples" count={2} open={false} onOpenChange={() => undefined}><p>x</p></FormCard>);
    expect(screen.getByTestId("c-count").textContent).toBe("2");
    expect(screen.getByTestId("c-toggle").textContent).toContain("2 set");
    rerender(<FormCard testId="c" title="Examples" count={0} open={false} onOpenChange={() => undefined}><p>x</p></FormCard>);
    expect(screen.queryByTestId("c-count")).toBeNull();
    rerender(<FormCard testId="c" title="Examples" open={false} onOpenChange={() => undefined}><p>x</p></FormCard>);
    expect(screen.queryByTestId("c-count")).toBeNull();
  });
});

describe("useCardState", () => {
  it("follows the defaults until the user chooses", () => {
    render(<Host defaults={{ a: true, b: false }} errored={[]} />);
    expect(expanded("a")).toBe("true");
    expect(expanded("b")).toBe("false");
    expect(screen.queryByTestId("body-b")).toBeNull();
  });

  it("keeps the user's choice when the defaults change (another item with other defaults)", () => {
    const { rerender } = render(<Host defaults={{ a: true, b: false }} errored={[]} />);
    fireEvent.click(screen.getByTestId("card-a-toggle"));
    rerender(<Host defaults={{ a: true, b: true }} errored={[]} />);
    expect(expanded("a")).toBe("false");
    expect(expanded("b")).toBe("true");
  });

  it("opens a card that newly holds a problem, even one the user closed", () => {
    const { rerender } = render(<Host defaults={{ a: true, b: false }} errored={[]} />);
    fireEvent.click(screen.getByTestId("card-a-toggle"));
    expect(expanded("a")).toBe("false");
    rerender(<Host defaults={{ a: true, b: false }} errored={["a", "b"]} />);
    expect(expanded("a")).toBe("true");
    expect(expanded("b")).toBe("true");
  });

  it("opens a card with a problem on the first render", () => {
    render(<Host defaults={{ a: false, b: false }} errored={["b"]} />);
    expect(expanded("b")).toBe("true");
    expect(expanded("a")).toBe("false");
  });

  it("lets the user close a card that keeps its problem, and does not reopen it until the problem comes back", () => {
    const { rerender } = render(<Host defaults={{ a: false, b: false }} errored={["a"]} />);
    expect(expanded("a")).toBe("true");
    fireEvent.click(screen.getByTestId("card-a-toggle"));
    expect(expanded("a")).toBe("false");
    rerender(<Host defaults={{ a: false, b: false }} errored={["a", "b"]} />);
    expect(expanded("a")).toBe("false");
    expect(expanded("b")).toBe("true");
    rerender(<Host defaults={{ a: false, b: false }} errored={[]} />);
    rerender(<Host defaults={{ a: false, b: false }} errored={["a"]} />);
    expect(expanded("a")).toBe("true");
  });

  it("holds its state outside the cards, so unmounting and remounting them keeps the choice", () => {
    function Section() {
      const cards = useCardState({ a: false }, new Set());
      const [shown, setShown] = useState(true);
      return (
        <div>
          <button data-testid="toggle-form" onClick={() => setShown((s) => !s)}>form</button>
          {shown && <FormCard testId="card-a" title="A" open={cards.isOpen("a")} onOpenChange={(o) => cards.setOpen("a", o)}><p>x</p></FormCard>}
        </div>
      );
    }
    render(<Section />);
    fireEvent.click(screen.getByTestId("card-a-toggle"));
    act(() => { fireEvent.click(screen.getByTestId("toggle-form")); });
    act(() => { fireEvent.click(screen.getByTestId("toggle-form")); });
    expect(expanded("a")).toBe("true");
  });
});
