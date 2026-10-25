/**
 * @vitest-environment jsdom
 */
/**
 * `generate()` asks for a primary key through one dialog. A second `generate()` that asks while the first question is open used to overwrite
 * the settle callback of the first, so the first promise never settled (its spinner never stopped). The question it replaces now ends as
 * declined (the first `generate()` resolves null, like a cancel), and the newer question owns the dialog.
 */
import { useEffect } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";

const ACTIONS = "@/app/(dashboard)/schemas/[domainSlug]/[productSlug]/[entityId]/actions";
vi.mock("@/app/(dashboard)/schemas/[domainSlug]/[productSlug]/[entityId]/actions", () => ({
  generateSchemaAction: vi.fn(),
  setEntityPrimaryKeyAction: vi.fn(),
  setFieldReferenceAction: vi.fn(),
}));

import { useGenerateWithInputs } from "@/app/(dashboard)/schemas/[domainSlug]/[productSlug]/[entityId]/components/useGenerateWithInputs";

const actions = await import(ACTIONS);
const generateSchema = actions.generateSchemaAction as unknown as ReturnType<typeof vi.fn>;
const setPrimaryKey = actions.setEntityPrimaryKeyAction as unknown as ReturnType<typeof vi.fn>;

const NEEDS_KEY = {
  needsInput: [{ code: "primary-key", message: "Evt has no primary key.", candidates: ["id", "code"], suggested: ["id"] }],
};
const GENERATED = { output: "ddl", warnings: [] };

type Api = ReturnType<typeof useGenerateWithInputs>;
const holder: { api?: Api } = {};
const getApi = (): Api => holder.api as Api;
function Harness() {
  const hook = useGenerateWithInputs("ent-1");
  useEffect(() => {
    holder.api = hook;
  });
  return <>{hook.dialog}</>;
}

/** Settles to the value, or to "pending" if the promise has not settled by the next macrotask turns. */
async function settled<T>(promise: Promise<T>): Promise<T | "pending"> {
  return Promise.race([promise, new Promise<"pending">((resolve) => setTimeout(() => resolve("pending"), 50))]);
}

describe("two generate() calls that both ask for a primary key", () => {
  beforeEach(() => vi.resetAllMocks());
  afterEach(() => cleanup());

  it("the first one settles (declined) when the second asks; the second is answered normally", async () => {
    generateSchema.mockResolvedValueOnce(NEEDS_KEY).mockResolvedValueOnce(NEEDS_KEY).mockResolvedValueOnce(GENERATED);
    setPrimaryKey.mockResolvedValue({ success: true, primaryKey: ["id"] });
    render(<Harness />);

    let first!: Promise<unknown>;
    let second!: Promise<unknown>;
    await act(async () => {
      first = getApi().generate("postgresql");
    });
    expect(await screen.findByText("Evt has no primary key.")).toBeDefined();
    await act(async () => {
      second = getApi().generate("bigquery");
    });

    // before the dialog is answered: the first question was replaced, so its promise is done (not waiting for an answer that cannot come)
    expect(await settled(first)).toBeNull();
    expect(await settled(second)).toBe("pending");

    // the dialog now belongs to the second: answering it saves the key and generation runs again
    fireEvent.click(await screen.findByRole("button", { name: /Save key and generate/ }));
    await waitFor(() => expect(setPrimaryKey).toHaveBeenCalledWith("ent-1", ["id"]));
    expect(await settled(second)).toEqual(GENERATED);
  });

  it("a single question is still answered, and a cancel still declines (no regression)", async () => {
    generateSchema.mockResolvedValue(NEEDS_KEY);
    render(<Harness />);
    let pending!: Promise<unknown>;
    await act(async () => {
      pending = getApi().generate("postgresql");
    });
    fireEvent.click(await screen.findByRole("button", { name: "Cancel" }));
    expect(await settled(pending)).toBeNull();
  });
});
