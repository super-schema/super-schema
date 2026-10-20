/**
 * ImportDialog — what the user is told when an import RENAMED something because the name is reserved (a parser-unsafe key, see
 * `PARSER_UNSAFE_KEYS`). The renames are NOTES delivered with the import's other messages: they must never be picked as "the blocking
 * error" when nothing was created, and when the import aborted the abort reason is what the toast says.
 *
 * @vitest-environment jsdom
 */

import type { ReactNode } from "react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { toast } from "sonner";
import { PARSER_UNSAFE_KEYS } from "@/lib/event-specs/own-property";
import { reservedNameMessage, reservedNameRenamedMessage } from "@/lib/reserved-field-names";
import type { TypeSpecImportResult } from "@/lib/importers/typespec.importer";

const { createDomainAssetsFromImportActionMock, importTypeSpecDocumentActionMock } = vi.hoisted(() => ({
  createDomainAssetsFromImportActionMock: vi.fn(),
  importTypeSpecDocumentActionMock: vi.fn(),
}));

vi.mock("@/components/ui/badge", () => ({
  Badge: ({ children, className }: { children: ReactNode; className?: string }) => <span className={className}>{children}</span>,
}));
vi.mock("@/components/ui/button", () => ({
  Button: ({ children, onClick, disabled, className, type }: { children: ReactNode; onClick?: () => void; disabled?: boolean; className?: string; type?: "button" | "submit" | "reset" }) => (
    <button type={type} onClick={onClick} disabled={disabled} className={className}>{children}</button>
  ),
}));
vi.mock("sonner", () => ({ toast: { success: vi.fn(), warning: vi.fn(), error: vi.fn() } }));
vi.mock("@/app/(dashboard)/schemas/[domainSlug]/typespec-import-actions", () => ({ importTypeSpecDocumentAction: importTypeSpecDocumentActionMock }));
vi.mock("@/app/(dashboard)/schemas/[domainSlug]/openapi-import-actions", () => ({ importOpenApiDocumentAction: vi.fn() }));
vi.mock("@/app/(dashboard)/schemas/[domainSlug]/actions", () => ({ createDomainAssetsFromImportAction: createDomainAssetsFromImportActionMock }));

import { ImportDialog } from "@/components/custom/ImportDialog";

const [UNSAFE] = [...PARSER_UNSAFE_KEYS];
const RENAMED = `${UNSAFE}_1`;
const ENTITY_NOTE = reservedNameRenamedMessage("entity", UNSAFE, RENAMED);
const MODEL_NOTE = reservedNameRenamedMessage("model", UNSAFE, RENAMED);
const nothingCreated = { modelsCreated: 0, entitiesCreated: 0, enumsCreated: 0, scalarsCreated: 0, unionsCreated: 0, servicesCreated: 0, decoratorsCreated: 0, entityIds: [], modelIds: [] };

function fixtureResult(): TypeSpecImportResult {
  return {
    models: [{
      name: UNSAFE, description: "", sourceFormat: "typespec", originalContent: "", referencedModelNames: [], referencedByModelNames: [], recommendedAsEntity: true,
      fields: [{ name: "id", type: "string", nullable: false, confidence: "high", originalType: "string", isKey: true }],
    }],
    sharedEnums: [], customScalars: [], unions: [], aliases: [], decoratorDefinitions: [], services: [], namespace: "MyApp", warnings: [],
  };
}

async function importIt() {
  importTypeSpecDocumentActionMock.mockResolvedValue({ success: true, data: fixtureResult() });
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const { container } = render(
    <QueryClientProvider client={queryClient}>
      <ImportDialog isOpen onClose={vi.fn()} domains={[{ id: "domain-1", name: "Domain" }]} />
    </QueryClientProvider>,
  );
  fireEvent.click(screen.getByRole("button", { name: "Upload File" }));
  const input = container.querySelector('[data-testid="drop-zone-single"] input[type="file"]') as HTMLInputElement;
  fireEvent.change(input, { target: { files: [new File(["model X { id: string; }"], "x.tsp", { type: "text/plain" })] } });
  await waitFor(() => expect(screen.getByTestId("typespec-import-review")).toBeDefined());
  fireEvent.click(screen.getByRole("button", { name: /Import \d+ Asset\(s\)/ }));
  await waitFor(() => expect(createDomainAssetsFromImportActionMock).toHaveBeenCalledTimes(1));
}

afterEach(() => {
  vi.clearAllMocks();
  cleanup();
});

describe("ImportDialog: rename notes are not errors", () => {
  it("re-importing a file whose entity has a reserved name (the renamed one already exists): no error toast, the usual 'already exists' warning, and the dialog moves on", async () => {
    const exists = `Entity "${RENAMED}" already exists — skipped`;
    createDomainAssetsFromImportActionMock.mockResolvedValue({ ...nothingCreated, errors: [ENTITY_NOTE, exists] });

    await importIt();

    await waitFor(() => expect(toast.warning).toHaveBeenCalledWith(exists));
    expect(toast.error).not.toHaveBeenCalled();
    // the note is still shown, as a warning among the others
    expect(toast.warning).toHaveBeenCalledWith(ENTITY_NOTE);
  });

  it("an import that ABORTED shows the abort reason, not the rename note that came before it (either order)", async () => {
    const abort = reservedNameMessage(UNSAFE) as string;
    for (const errors of [[abort, MODEL_NOTE], [MODEL_NOTE, abort]]) {
      createDomainAssetsFromImportActionMock.mockReset();
      vi.mocked(toast.error).mockClear();
      createDomainAssetsFromImportActionMock.mockResolvedValue({ ...nothingCreated, errors });
      cleanup();

      await importIt();

      await waitFor(() => expect(toast.error).toHaveBeenCalledTimes(1));
      expect(toast.error).toHaveBeenCalledWith(abort);
    }
  });

  it("an ordinary blocking error is still the error toast", async () => {
    createDomainAssetsFromImportActionMock.mockResolvedValue({ ...nothingCreated, errors: [ENTITY_NOTE, "Product does not belong to this domain"] });

    await importIt();

    await waitFor(() => expect(toast.error).toHaveBeenCalledWith("Product does not belong to this domain"));
  });
});
