// @vitest-environment jsdom
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { DiagnosticsList } from "@/features/events/event-specs/DiagnosticsList";

afterEach(() => cleanup());

describe("DiagnosticsList", () => {
  it("lists diagnostics by severity with pointers, plus unpublished messages", () => {
    render(
      <DiagnosticsList
        diagnostics={[
          { severity: "error", code: "PAYLOAD_ARTIFACT_MISSING", message: "No payload schema rendered as avro", pointer: "/components/messages/OrderCreated/payload" },
          { severity: "warning", code: "SCHEMA_KEYWORD_DROPPED", message: "dropped", pointer: "" },
        ]}
        unpublishedMessages={[{ id: "m1", name: "OrderCreated" }]}
      />
    );
    expect(screen.getByText("1 error · 1 warning")).toBeDefined();
    expect(screen.getByText("/components/messages/OrderCreated/payload")).toBeDefined();
    expect(screen.getByText(/OrderCreated is an unpublished draft/)).toBeDefined();
  });

  it("shows errors before warnings before info, whatever the input order", () => {
    render(
      <DiagnosticsList
        diagnostics={[
          { severity: "info", code: "I", message: "fyi", pointer: "" },
          { severity: "warning", code: "W", message: "careful", pointer: "" },
          { severity: "error", code: "E", message: "broken", pointer: "" },
        ]}
        unpublishedMessages={[]}
      />
    );
    expect(screen.getAllByRole("listitem").map((li) => li.textContent?.match(/^(error|warning|info)/)?.[1])).toEqual(["error", "warning", "info"]);
    expect(screen.getByText("1 error · 1 warning · 1 info")).toBeDefined();
  });

  it("celebrates a clean document", () => {
    render(<DiagnosticsList diagnostics={[]} unpublishedMessages={[]} />);
    expect(screen.getByText(/validates with @asyncapi\/parser/)).toBeDefined();
  });
});
