// @vitest-environment jsdom
// The editable node of JsonEditor is reachable by id, accessible name and test id in BOTH states (textarea fallback, CodeMirror ready),
// which is what the e2e helpers rely on to fill and read it.
import "./codemirror-jsdom";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { JsonEditor } from "@/features/events/builder/template/controls/JsonEditor";

afterEach(cleanup);

const element = () => (
  <JsonEditor id="workbench-paste-textarea" ariaLabel="Paste your schema content" value="{}" onChange={() => undefined} language="json" />
);

describe("JsonEditor editable node", () => {
  it("fallback state: the textarea has the id, the test id and the accessible name", () => {
    render(element());
    const area = screen.getByTestId("workbench-paste-textarea");
    expect(area.tagName).toBe("TEXTAREA");
    expect(area.id).toBe("workbench-paste-textarea");
    expect(area.getAttribute("aria-label")).toBe("Paste your schema content");
  });

  it("ready state: the content element has the id, the accessible name and the -content test id; the host keeps the old test id", async () => {
    const { container } = render(element());
    await waitFor(() => expect(container.querySelector(".cm-editor")).not.toBeNull());
    const content = screen.getByTestId("workbench-paste-textarea-content");
    expect(content.getAttribute("contenteditable")).toBe("true");
    expect(content.id).toBe("workbench-paste-textarea");
    expect(content.getAttribute("aria-label")).toBe("Paste your schema content");
    expect(screen.getByTestId("workbench-paste-textarea").tagName).toBe("DIV"); // the host, as before
    expect(container.querySelector("#workbench-paste-textarea")).toBe(content); // so `#id` is the editable node in both states
  });
});
