/**
 * @vitest-environment jsdom
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, render } from "@testing-library/react";
import { ImportUploader } from "@/components/custom/EntityCreationWizard/ImportUploader";

afterEach(cleanup);

describe("ImportUploader (Story 15.6)", () => {
  it("accepts .json, .yaml and .yml files alongside the schema extensions", () => {
    const { container } = render(<ImportUploader onSubmit={vi.fn()} onBack={vi.fn()} />);
    const input = container.querySelector('input[type="file"]') as HTMLInputElement;
    const accepted = input.accept.split(",");
    for (const ext of [".avsc", ".proto", ".tsp", ".sql", ".json", ".yaml", ".yml"]) {
      expect(accepted).toContain(ext);
    }
  });
});
