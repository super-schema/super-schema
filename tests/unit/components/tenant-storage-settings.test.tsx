// @vitest-environment jsdom
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import "@testing-library/jest-dom/vitest";
const h = vi.hoisted(() => ({
  refresh: vi.fn(),
  save: vi.fn(),
  mode: vi.fn(),
  create: vi.fn(),
  app: vi.fn(),
  bootstrap: vi.fn(),
  sync: vi.fn(),
}));
vi.mock("next/navigation", () => ({ useRouter: () => ({ refresh: vi.fn() }) }));
vi.mock("sonner", () => ({ toast: { success: vi.fn(), message: vi.fn() } }));
vi.mock("@/app/(dashboard)/admin/settings/storage/actions", () => ({
  tenantStorageSettingsAction: h.refresh,
  saveTenantStorageProfileAction: h.save,
  setTenantStorageAction: h.mode,
  createTenantStorageAction: h.create,
  saveTenantStorageAppAction: h.app,
  bootstrapTenantStorageAction: h.bootstrap,
  syncTenantStorageAction: h.sync,
}));
import { TenantStorageSettings } from "@/components/custom/tenant-storage/TenantStorageSettings";
import { storageFixture } from "../../fixtures/tenant-storage-preview/fixture";
beforeEach(() => {
  vi.clearAllMocks();
  h.refresh.mockResolvedValue({ data: storageFixture() });
  h.save.mockResolvedValue({ data: true });
  h.mode.mockResolvedValue({ data: true });
  h.create.mockResolvedValue({ data: { tenantId: "new" } });
});
afterEach(cleanup);

it("selects a backend without changing persisted storage until the explicit action", async () => {
  render(<TenantStorageSettings initial={storageFixture()} />);
  fireEvent.click(screen.getByRole("button", { name: /^GitHub/ }));
  expect(h.mode).not.toHaveBeenCalled();
  expect(screen.getByLabelText("Repository root")).toHaveValue(
    "contracts/platform",
  );
  fireEvent.click(screen.getByRole("button", { name: "Use GitHub storage" }));
  await waitFor(() => expect(h.mode).toHaveBeenCalledWith("git", 1));
});
it("preserves an empty repository root and multiple review owners when verifying", async () => {
  render(<TenantStorageSettings initial={storageFixture("git")} />);
  fireEvent.change(screen.getByLabelText("Repository root"), {
    target: { value: "" },
  });
  fireEvent.change(screen.getByLabelText("Review owners"), {
    target: { value: "@one/team, @two" },
  });
  fireEvent.click(
    screen.getByRole("button", { name: "Verify & save repository" }),
  );
  await waitFor(() =>
    expect(h.save).toHaveBeenCalledWith(
      expect.objectContaining({
        binding: expect.objectContaining({ basePath: "" }),
        owners: ["@one/team", "@two"],
      }),
    ),
  );
});
it("keeps a failed repository setup editable and shows the server error", async () => {
  h.save.mockResolvedValue({
    error: "This repository folder is reserved by another tenant.",
  });
  render(<TenantStorageSettings initial={storageFixture("git")} />);
  fireEvent.change(screen.getByLabelText("Repository root"), {
    target: { value: "contracts/custom" },
  });
  fireEvent.click(
    screen.getByRole("button", { name: "Verify & save repository" }),
  );
  expect(await screen.findByRole("alert")).toHaveTextContent(
    "reserved by another tenant",
  );
  expect(screen.getByLabelText("Repository root")).toHaveValue(
    "contracts/custom",
  );
  expect(h.refresh).not.toHaveBeenCalled();
});
it("hides platform actions from tenant administrators and blocks reversing a tenant with Git history", () => {
  render(
    <TenantStorageSettings
      initial={{
        ...storageFixture("git"),
        canCreateTenant: false,
        canManageApp: false,
      }}
    />,
  );
  expect(
    screen.queryByRole("button", { name: "New tenant" }),
  ).not.toBeInTheDocument();
  expect(screen.queryByLabelText("Client secret")).not.toBeInTheDocument();
  fireEvent.click(screen.getByRole("button", { name: /^PostgreSQL/ }));
  expect(
    screen.getByRole("button", { name: "Use database storage" }),
  ).toBeDisabled();
  expect(
    screen.getByText(/requires an explicit content migration/),
  ).toBeInTheDocument();
});
it("onboards a private database tenant without requiring a GitHub App or repository", async () => {
  render(
    <TenantStorageSettings initial={{ ...storageFixture(), app: null }} />,
  );
  fireEvent.click(screen.getByRole("button", { name: "New tenant" }));
  const dialog = within(await screen.findByRole("dialog"));
  fireEvent.change(dialog.getByLabelText("Tenant name"), {
    target: { value: "Private schemas" },
  });
  fireEvent.click(dialog.getByRole("button", { name: "Create tenant" }));
  await waitFor(() =>
    expect(h.create).toHaveBeenCalledWith({
      name: "Private schemas",
      description: "",
      storage: "database",
      domainName: "General",
      productName: "Workspace",
    }),
  );
});
it("onboards a Git tenant with the customized root and environment mappings", async () => {
  render(<TenantStorageSettings initial={storageFixture()} />);
  fireEvent.click(screen.getByRole("button", { name: "New tenant" }));
  const dialog = within(await screen.findByRole("dialog"));
  fireEvent.change(dialog.getByLabelText("Tenant name"), {
    target: { value: "Git schemas" },
  });
  fireEvent.click(dialog.getByRole("button", { name: /^GitHub/ }));
  expect(dialog.getByLabelText("Repository root")).toHaveValue(
    "superschema/git-schemas",
  );
  fireEvent.change(dialog.getByLabelText("Repository root"), {
    target: { value: "catalog" },
  });
  fireEvent.change(dialog.getByLabelText("Tenant name"), {
    target: { value: "Git schemas renamed" },
  });
  fireEvent.change(dialog.getByLabelText("Repository URL"), {
    target: { value: "https://github.com/example/catalog" },
  });
  fireEvent.change(dialog.getByLabelText("Installation ID"), {
    target: { value: "12" },
  });
  fireEvent.change(dialog.getByLabelText("Branch 2"), {
    target: { value: "release/staging" },
  });
  fireEvent.click(dialog.getByRole("button", { name: "Create tenant" }));
  await waitFor(() =>
    expect(h.create).toHaveBeenCalledWith(
      expect.objectContaining({
        storage: "git",
        git: expect.objectContaining({
          binding: expect.objectContaining({ basePath: "catalog" }),
          stages: expect.arrayContaining([
            expect.objectContaining({ branch: "release/staging" }),
          ]),
        }),
      }),
    ),
  );
});
