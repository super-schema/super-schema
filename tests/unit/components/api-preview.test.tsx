/**
 * @vitest-environment jsdom
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";

const actions = vi.hoisted(() => ({ previewEntityOpenApiAction: vi.fn() }));
vi.mock("@/app/(dashboard)/schemas/[domainSlug]/[productSlug]/[entityId]/api-preview-actions", () => actions);

import { ApiPreview } from "@/app/(dashboard)/schemas/[domainSlug]/[productSlug]/[entityId]/components/ApiPreview";

afterEach(cleanup);
beforeEach(() => vi.clearAllMocks());

const YAML = `openapi: 3.0.0
info:
  title: Order
  version: 0.0.0
paths:
  /orders/{id}:
    get:
      operationId: getOrder
      summary: Fetch one
      parameters:
        - name: id
          in: path
          required: true
          schema:
            type: string
            format: uuid
      responses:
        '200':
          description: ok
          content:
            application/json:
              schema:
                $ref: '#/components/schemas/Order'
components:
  schemas:
    Order:
      type: object
      required: [id]
      properties:
        id:
          type: string
          format: uuid
        total:
          type: number
`;

describe("ApiPreview", () => {
  it("lists the emitted operations with example payloads, and the YAML on its tab", async () => {
    actions.previewEntityOpenApiAction.mockResolvedValue({ success: true, yaml: YAML, path: "openapi.yaml", validationStatus: "WARNING", warnings: ["a warning"], errors: [] });
    render(<ApiPreview entityId="e1" />);
    const card = await screen.findByTestId("api-preview-operation");
    expect(actions.previewEntityOpenApiAction).toHaveBeenCalledWith("e1");
    expect(card.textContent).toContain("GET");
    expect(card.textContent).toContain("/orders/{id}");
    expect(card.textContent).toContain("string (uuid)");
    expect(card.querySelector("pre")?.textContent).toMatch(/"id": "[0-9a-f-]{36}"/);
    expect(screen.getByTestId("api-preview-warnings").textContent).toContain("a warning");

    fireEvent.click(screen.getByRole("tab", { name: "OpenAPI YAML" }));
    expect(screen.getByTestId("schema-code-preview").textContent).toContain("operationId: getOrder");
  });

  it("shows the emitter errors", async () => {
    actions.previewEntityOpenApiAction.mockResolvedValue({ success: true, yaml: "", path: "", validationStatus: "INVALID", warnings: [], errors: ["Unknown identifier Foo"] });
    render(<ApiPreview entityId="e1" />);
    expect((await screen.findByTestId("api-preview-errors")).textContent).toContain("Unknown identifier Foo");
  });

  it("shows a refusal and reloads on Refresh", async () => {
    actions.previewEntityOpenApiAction.mockResolvedValueOnce({ error: "Entity not found", code: "NOT_FOUND" });
    actions.previewEntityOpenApiAction.mockResolvedValueOnce({ success: true, yaml: YAML, path: "openapi.yaml", validationStatus: "VALID", warnings: [], errors: [] });
    render(<ApiPreview entityId="e1" />);
    expect((await screen.findByTestId("api-preview-errors")).textContent).toContain("Entity not found");
    fireEvent.click(screen.getByTestId("api-preview-refresh"));
    await screen.findByTestId("api-preview-operation");
    await waitFor(() => expect(actions.previewEntityOpenApiAction).toHaveBeenCalledTimes(2));
  });
});
