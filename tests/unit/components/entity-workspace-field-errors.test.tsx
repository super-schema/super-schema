/**
 * A refused field name reaches the user: the entity workspace shows the server's message as a toast when the field editor's add or
 * rename is refused (a name the AsyncAPI parser cannot read, `PARSER_UNSAFE_KEYS`). The field editor itself is a stand-in that calls the
 * workspace's callbacks.
 *
 * @vitest-environment jsdom
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { toast } from "sonner";
import {
  EntityWorkspace,
  type EntityWorkspaceProps,
} from "@/app/(dashboard)/schemas/[domainSlug]/[productSlug]/[entityId]/entity-workspace";

const MESSAGE = '"hasOwnProperty" is a reserved name: AsyncAPI documents cannot contain it. Choose another field name.';
const mocks = vi.hoisted(() => ({ addField: vi.fn(), updateField: vi.fn() }));

vi.mock("next/navigation", () => ({
  useSearchParams: () => new URLSearchParams(),
  useRouter: () => ({ push: vi.fn(), replace: vi.fn(), refresh: vi.fn() }),
}));
vi.mock("@/hooks/useDomainsTree", () => ({ useInvalidateDomainsTree: () => vi.fn() }));
vi.mock("@/lib/recent-entities", () => ({ trackRecentEntity: vi.fn() }));
vi.mock("sonner", () => ({ toast: { error: vi.fn(), success: vi.fn() } }));
vi.mock("@/app/(dashboard)/schemas/[domainSlug]/[productSlug]/[entityId]/actions", () => ({
  addFieldAction: mocks.addField,
  updateFieldAction: mocks.updateField,
}));
vi.mock("@/app/(dashboard)/schemas/[domainSlug]/[productSlug]/[entityId]/version-actions", () => ({
  getPublishPreviewAction: vi.fn(),
  publishEntityAction: vi.fn(),
  listEntityVersionsAction: vi.fn(),
}));
vi.mock("@/app/(dashboard)/schemas/usage-actions", () => ({ listUsagesAction: vi.fn().mockResolvedValue({ success: true, data: { rows: [], truncated: false } }) }));
vi.mock("@/app/(dashboard)/schemas/[domainSlug]/actions", () => ({ deleteEntityAction: vi.fn() }));
vi.mock("@/app/(dashboard)/schemas/[domainSlug]/[productSlug]/[entityId]/field-editor", () => ({
  FieldEditor: (p: { onAddField: (n: string, t: string) => Promise<unknown>; onUpdateField: (id: string, d: Record<string, unknown>) => Promise<void> }) => (
    <div>
      <button onClick={() => void p.onAddField("hasOwnProperty", "string")}>add</button>
      <button onClick={() => void p.onUpdateField("fld-1", { name: "hasOwnProperty" })}>rename</button>
    </div>
  ),
}));
vi.mock("@/app/(dashboard)/schemas/[domainSlug]/[productSlug]/[entityId]/components/SchemasTab", () => ({ SchemasTab: () => null }));
vi.mock("@/app/(dashboard)/schemas/[domainSlug]/[productSlug]/[entityId]/components/EntityDeploymentsTab", () => ({ EntityDeploymentsTab: () => null }));
vi.mock("@/app/(dashboard)/schemas/[domainSlug]/[productSlug]/[entityId]/components/TypeSpecSourceTab", () => ({ TypeSpecSourceTab: () => null }));
vi.mock("@/app/(dashboard)/schemas/[domainSlug]/[productSlug]/[entityId]/components/RightPanelRouter", () => ({ RightPanelRouter: () => null }));
vi.mock("@/app/(dashboard)/schemas/[domainSlug]/[productSlug]/[entityId]/components/InlineEntityMeta", () => ({ InlineEntityMeta: () => null }));
vi.mock("@/app/(dashboard)/schemas/[domainSlug]/[productSlug]/[entityId]/components/AlertsTab", () => ({ AlertsTab: () => null }));
vi.mock("@/app/(dashboard)/schemas/[domainSlug]/[productSlug]/[entityId]/components/ApiTab", () => ({ ApiTab: () => null }));
vi.mock("@/components/custom/DiffViewer", () => ({ DiffViewer: () => null }));
vi.mock("@/components/custom/TypeMappingOverrideDialog", () => ({ TypeMappingOverrideDialog: () => null }));
vi.mock("@/components/custom/ChangeHistoryView", () => ({ ChangeHistoryView: () => null }));
vi.mock("@/features/governance/RetentionPolicyEditor/RetentionPolicyEditor", () => ({ RetentionPolicyEditor: () => null }));

beforeEach(() => vi.clearAllMocks());
afterEach(cleanup);

const props: EntityWorkspaceProps = {
  level: "PRODUCT",
  entity: {
    id: "ent-1", name: "Customer", slug: "customer", description: "", status: "DRAFT", version: 1, metadata: null,
    domainId: "dom-1", domainName: "Payments", domainSlug: "payments", productSlug: "checkout", productName: "Checkout",
  },
  domainPolicy: null,
  fields: [],
  apiServiceId: null,
  apiOperations: [],
} as EntityWorkspaceProps;

describe("EntityWorkspace: a refused field name is shown to the user", () => {
  it("adding a field named hasOwnProperty shows the server's message", async () => {
    mocks.addField.mockResolvedValue({ error: MESSAGE, code: "VALIDATION_ERROR" });
    render(<EntityWorkspace {...props} />);
    fireEvent.click(screen.getByText("add"));
    await waitFor(() => expect(mocks.addField).toHaveBeenCalledWith("ent-1", "hasOwnProperty", "string", undefined));
    await waitFor(() => expect(toast.error).toHaveBeenCalledWith(MESSAGE));
  });

  it("renaming a field to hasOwnProperty shows the server's message", async () => {
    mocks.updateField.mockResolvedValue({ error: MESSAGE, code: "VALIDATION_ERROR" });
    render(<EntityWorkspace {...props} />);
    fireEvent.click(screen.getByText("rename"));
    await waitFor(() => expect(mocks.updateField).toHaveBeenCalledWith("fld-1", { name: "hasOwnProperty" }));
    await waitFor(() => expect(toast.error).toHaveBeenCalledWith(MESSAGE));
  });
});
