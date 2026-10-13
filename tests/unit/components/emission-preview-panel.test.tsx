/**
 * @vitest-environment jsdom
 */
import { describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import { EmissionPreviewPanel } from "@/components/custom/EmissionPreviewPanel/EmissionPreviewPanel";
import type { EmissionResult } from "@/lib/emission/emission.types";

vi.mock("sonner", () => ({
  toast: {
    success: vi.fn(),
    error: vi.fn(),
  },
}));

describe("EmissionPreviewPanel", () => {
  it("passes structured mapping context when a warning is opened", () => {
    const onWarningClick = vi.fn();
    const result: EmissionResult = {
      typespec: "model Customer {}",
      targets: {
        bigquery: {
          name: "bigquery",
          targetFormat: "bigquery",
          output: "CREATE TABLE customer (metadata JSON);",
          isValid: true,
          validationStatus: "WARNING",
          warnings: [
            {
              message: "map mapped to JSON (lossy — Map stored as JSON — no typed key-value access)",
              fieldName: "metadata",
              sourceType: "map",
              targetFormat: "bigquery",
              mappedType: "JSON",
              lossDescription: "Map stored as JSON — no typed key-value access",
            },
          ],
          errors: [],
        },
      },
      success: true,
      summary: {
        totalTargets: 1,
        validCount: 0,
        warningCount: 1,
        invalidCount: 0,
      },
    };

    render(
      <EmissionPreviewPanel
        result={result}
        open
        onClose={vi.fn()}
        onWarningClick={onWarningClick}
      />
    );

    fireEvent.click(screen.getByRole("button", { name: /metadata:/i }));

    expect(onWarningClick).toHaveBeenCalledWith({
      sourceType: "map",
      targetFormat: "bigquery",
      currentMappedType: "JSON",
      lossDescription: "Map stored as JSON — no typed key-value access",
      fieldName: "metadata",
    });
  });

  it("renders non-mapping warnings as plain text", () => {
    const onWarningClick = vi.fn();
    const result: EmissionResult = {
      typespec: "model Customer {}",
      targets: {
        bigquery: {
          name: "bigquery",
          targetFormat: "bigquery",
          output: "CREATE TABLE customer (id STRING);",
          isValid: true,
          validationStatus: "WARNING",
          warnings: [
            {
              message: "Partition decorator ignored",
              fieldName: "createdAt",
            },
          ],
          errors: [],
        },
      },
      success: true,
      summary: {
        totalTargets: 1,
        validCount: 0,
        warningCount: 1,
        invalidCount: 0,
      },
    };

    render(
      <EmissionPreviewPanel
        result={result}
        open
        onClose={vi.fn()}
        onWarningClick={onWarningClick}
      />
    );

    expect(screen.queryByRole("button", { name: /createdAt:/i })).toBeNull();
    expect(screen.getByText(/createdAt: Partition decorator ignored/)).toBeDefined();
    expect(onWarningClick).not.toHaveBeenCalled();
  });
});
