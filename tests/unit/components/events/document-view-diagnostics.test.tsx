// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
vi.mock("sonner", () => ({ toast: { success: vi.fn(), error: vi.fn() } }));
import { DocumentView } from "@/features/events/event-specs/DocumentView";
import { DiagnosticsList } from "@/features/events/event-specs/DiagnosticsList";

afterEach(() => cleanup());
const emission = {
  specId: "s1", specName: "checkout-service", version: "2.0", published: true,
  document: { asyncapi: "3.0.0" }, json: '{\n  "asyncapi": "3.0.0"\n}\n', yaml: "asyncapi: 3.0.0\n", diagnostics: [], unpublishedMessages: [],
};

describe("DocumentView", () => {
  it("toggles YAML / JSON, copies and downloads with the version in the file name", () => {
    const writeText = vi.fn();
    Object.assign(navigator, { clipboard: { writeText } });
    const createObjectURL = vi.fn(() => "blob:x");
    Object.assign(URL, { createObjectURL, revokeObjectURL: vi.fn() });
    const click = vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(() => {});
    render(<DocumentView emission={emission} loading={false} error={null} onRetry={vi.fn()} />);
    expect(screen.getByTestId("document-text").textContent).toContain("asyncapi: 3.0.0");
    fireEvent.click(screen.getByRole("button", { name: "JSON" }));
    expect(screen.getByTestId("document-text").textContent).toContain('"asyncapi": "3.0.0"');
    fireEvent.click(screen.getByTestId("document-copy"));
    expect(writeText).toHaveBeenCalledWith(emission.json);
    fireEvent.click(screen.getByTestId("document-download"));
    expect(createObjectURL).toHaveBeenCalled();
    expect(click).toHaveBeenCalled();
    expect((click.mock.contexts[0] as HTMLAnchorElement).download).toBe("checkout-service-2.0.asyncapi.json");
    click.mockRestore();
  });

  it("points at the REST endpoint for the shown version and format", () => {
    const { rerender } = render(<DocumentView emission={emission} loading={false} error={null} onRetry={vi.fn()} />);
    expect(screen.getByTestId("document-rest-link").getAttribute("href")).toBe("/api/v1/event-specs/s1?version=2.0&format=yaml");
    fireEvent.click(screen.getByRole("button", { name: "JSON" }));
    expect(screen.getByTestId("document-rest-link").getAttribute("href")).toBe("/api/v1/event-specs/s1?version=2.0&format=json");
    rerender(<DocumentView emission={{ ...emission, version: "draft", published: false }} loading={false} error={null} onRetry={vi.fn()} />);
    expect(screen.getByTestId("document-rest-link").getAttribute("href")).toBe("/api/v1/event-specs/s1?version=draft&format=json");
  });

  it("keeps the file name header-safe for odd spec names", () => {
    Object.assign(URL, { createObjectURL: vi.fn(() => "blob:x"), revokeObjectURL: vi.fn() });
    const click = vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(() => {});
    render(<DocumentView emission={{ ...emission, specName: 'we ird/"name"' }} loading={false} error={null} onRetry={vi.fn()} />);
    fireEvent.click(screen.getByTestId("document-download"));
    expect((click.mock.contexts[0] as HTMLAnchorElement).download).toBe("we-ird-name-2.0.asyncapi.yaml");
    click.mockRestore();
  });

  it("points to Diagnostics when there is no document", () => {
    render(<DocumentView emission={{ ...emission, document: null, json: null, yaml: null }} loading={false} error={null} onRetry={vi.fn()} />);
    expect(screen.getByText(/No document — see the Diagnostics tab/)).toBeDefined();
  });

  it("shows a loading note, and an error with a working Retry", () => {
    const onRetry = vi.fn();
    const { rerender } = render(<DocumentView emission={null} loading error={null} onRetry={onRetry} />);
    expect(screen.getByText(/Rendering payloads and validating/)).toBeDefined();
    rerender(<DocumentView emission={null} loading={false} error="Event spec not found" onRetry={onRetry} />);
    expect(screen.getByRole("alert").textContent).toContain("Event spec not found");
    fireEvent.click(screen.getByRole("button", { name: "Retry" }));
    expect(onRetry).toHaveBeenCalledTimes(1);
  });
});

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
