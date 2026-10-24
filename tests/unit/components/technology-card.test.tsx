/**
 * TechnologyCard button-label regression tests.
 *
 * @vitest-environment jsdom
 */

import { describe, it, expect, vi, afterEach, beforeEach } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";

const {
  generateSchemaActionMock,
  publishSchemaActionMock,
  deploySchemaActionMock,
  getSchemaTargetFieldMappingsActionMock,
  saveSchemaFieldTypeOverrideActionMock,
} = vi.hoisted(() => ({
  generateSchemaActionMock: vi.fn(),
  publishSchemaActionMock: vi.fn(),
  deploySchemaActionMock: vi.fn(),
  getSchemaTargetFieldMappingsActionMock: vi.fn(),
  saveSchemaFieldTypeOverrideActionMock: vi.fn(),
}));

vi.mock("@/app/(dashboard)/schemas/[domainSlug]/[productSlug]/[entityId]/actions", () => ({
  generateSchemaAction: generateSchemaActionMock,
  publishSchemaAction: publishSchemaActionMock,
  deploySchemaAction: deploySchemaActionMock,
  getSchemaTargetFieldMappingsAction: getSchemaTargetFieldMappingsActionMock,
  saveSchemaFieldTypeOverrideAction: saveSchemaFieldTypeOverrideActionMock,
}));

vi.mock("sonner", () => ({
  toast: {
    success: vi.fn(),
    error: vi.fn(),
  },
}));

vi.mock(
  "@/app/(dashboard)/schemas/[domainSlug]/[productSlug]/[entityId]/components/SchemaVersionList",
  () => ({
    StatusBadge: ({ status }: { status: string }) => <span>{status}</span>,
    SchemaVersionList: () => <div data-testid="schema-version-list" />,
  })
);

vi.mock(
  "@/app/(dashboard)/schemas/[domainSlug]/[productSlug]/[entityId]/components/SchemaCodePreview",
  () => ({
    SchemaCodePreview: ({ code }: { code: string }) => <pre>{code}</pre>,
  })
);

import { toast } from "sonner";
import { TechnologyCard } from "@/app/(dashboard)/schemas/[domainSlug]/[productSlug]/[entityId]/components/TechnologyCard";

afterEach(() => {
  vi.clearAllMocks();
  cleanup();
});

beforeEach(() => {
  getSchemaTargetFieldMappingsActionMock.mockResolvedValue({
    success: true,
    supported: true,
    reason: null,
    typeCatalog: {
      key: "bigquery",
      displayName: "BigQuery DDL",
      docsUrl: "https://cloud.google.com/bigquery/docs/reference/standard-sql/data-types",
      docsSource: "Google Cloud BigQuery GoogleSQL data types",
      supportsGeneratedOverrides: true,
      options: [
        {
          value: "STRING",
          label: "STRING",
          description: "Variable-length text",
          group: "Scalars",
        },
        {
          value: "STRING(36)",
          label: "STRING(36)",
          description: "Bounded text for identifiers",
          group: "Scalars",
        },
      ],
    },
    mappings: [
      {
        fieldId: "field-1",
        fieldName: "id",
        sourceType: "string",
        defaultMappedType: "STRING",
        effectiveMappedType: "STRING",
        overrideSource: undefined,
        isOverride: false,
        isStale: false,
      },
    ],
  });
  saveSchemaFieldTypeOverrideActionMock.mockResolvedValue({
    success: true,
    schemaVersion: { version: 2 },
  });
});

const baseVersion = {
  version: 1,
  status: "draft" as const,
  output: "CREATE TABLE customer (...)",
  generatedAt: "2026-04-07T10:00:00.000Z",
  entityVersion: 2,
};

const baseProps = {
  targetInfo: {
    key: "bigquery",
    displayName: "BigQuery DDL",
    icon: <span>icon</span>,
    supportsFieldOverrides: true,
  },
  versions: [baseVersion],
  entityId: "entity-1",
  fieldsCount: 2,
  onVersionsChange: vi.fn(),
};

describe("TechnologyCard", () => {
  it("shows Update Schema when the entity changed since the latest generation", () => {
    render(
      <TechnologyCard
        {...baseProps}
        entityVersion={3}
      />
    );

    const btns = screen.getAllByTestId("generate-bigquery");
    expect(btns.some((b) => b.textContent?.includes("Update Schema"))).toBe(true);
  });

  it("shows Regenerate when the latest schema already matches the entity version", async () => {
    generateSchemaActionMock.mockResolvedValue({
      success: true,
      schemaVersion: {
        version: 2,
      },
    });

    render(
      <TechnologyCard
        {...baseProps}
        entityVersion={2}
      />
    );

    const btns = screen.getAllByTestId("generate-bigquery");
    const button = btns.find((b) => b.textContent?.includes("Regenerate")) ?? btns[0];
    expect(button.textContent).toContain("Regenerate");

    fireEvent.click(button);

    await waitFor(() => {
      expect(generateSchemaActionMock).toHaveBeenCalledWith("entity-1", "bigquery");
    });
  });

  it("saves a field-level target type override from the inspector", async () => {
    render(
      <TechnologyCard
        {...baseProps}
        entityVersion={2}
      />
    );

    const select = await screen.findByTestId("type-override-select-field-1");
    fireEvent.change(select, { target: { value: "STRING(36)" } });

    await waitFor(() => {
      expect(saveSchemaFieldTypeOverrideActionMock).toHaveBeenCalledWith({
        entityId: "entity-1",
        target: "bigquery",
        fieldId: "field-1",
        mappedType: "STRING(36)",
      });
    });
  });
  it("surfaces mapping health and opens an example-driven risk detail panel", async () => {
    getSchemaTargetFieldMappingsActionMock.mockResolvedValue({
      success: true,
      supported: true,
      reason: null,
      typeCatalog: {
        key: "openapi",
        displayName: "OpenAPI (Super Schema)",
        docsUrl: "https://spec.openapis.org/oas/v3.0.0.html",
        docsSource: "OpenAPI Specification data type formats",
        supportsGeneratedOverrides: true,
        options: [
          {
            value: "number/double",
            label: "number/double",
            description: "Double precision floating point",
            group: "Numeric formats",
          },
          {
            value: "string",
            label: "string",
            description: "Plain string",
            group: "Core",
          },
        ],
      },
      mappings: [
        {
          fieldId: "field-amount",
          fieldName: "amount",
          sourceType: "decimal",
          precision: 19,
          scale: 4,
          defaultMappedType: "number/double",
          effectiveMappedType: "number/double",
          overrideSource: undefined,
          isOverride: false,
          isStale: false,
          isLossy: true,
          lossDescription:
            "Decimal precision reduced to float64 — values beyond 15 significant digits will be rounded",
        },
      ],
    });

    render(
      <TechnologyCard
        {...baseProps}
        targetInfo={{
          key: "openapi",
          displayName: "OpenAPI",
          icon: <span>api</span>,
          supportsFieldOverrides: true,
        }}
        entityVersion={2}
      />
    );

    expect(await screen.findByText("Mapping health")).toBeDefined();
    expect(screen.getByText("1 risky")).toBeDefined();

    fireEvent.click(screen.getByRole("button", { name: /review amount mapping/i }));

    expect(screen.getByText("Example values")).toBeDefined();
    expect(screen.getByText(/123456789012345\.6789/)).toBeDefined();
    expect(screen.getByText(/Financial totals/)).toBeDefined();
  });
});

describe("TechnologyCard publish refusal (Task 8)", () => {
  const PREVIEW_REFUSAL = {
    error: "This schema version was generated from the saved draft of Sales / Orders / Customer, so it is a preview and cannot be published.",
    code: "PREVIEW_NOT_PUBLISHABLE",
    needsPublishedRegeneration: true,
  };

  it("a plain refusal is the error toast only, with no way out attached", async () => {
    publishSchemaActionMock.mockResolvedValue({ error: "Version 1 not found" });
    render(<TechnologyCard {...baseProps} entityVersion={2} />);

    fireEvent.click(await screen.findByRole("button", { name: /mark deployed/i }));

    await waitFor(() => expect(toast.error).toHaveBeenCalledWith("Version 1 not found"));
    expect(publishSchemaActionMock).toHaveBeenCalledTimes(1);
    expect(publishSchemaActionMock).toHaveBeenCalledWith("entity-1", "bigquery", 1);
  });

  it("a preview refusal shows the message with a button that regenerates from the published versions and publishes", async () => {
    publishSchemaActionMock.mockResolvedValueOnce(PREVIEW_REFUSAL).mockResolvedValueOnce({ success: true });
    const onVersionsChange = vi.fn();
    render(<TechnologyCard {...baseProps} onVersionsChange={onVersionsChange} entityVersion={2} />);

    fireEvent.click(await screen.findByRole("button", { name: /mark deployed/i }));

    await waitFor(() => expect(toast.error).toHaveBeenCalledTimes(1));
    const [message, options] = vi.mocked(toast.error).mock.calls[0] as unknown as [string, { action: { label: string; onClick: () => void } }];
    expect(message).toBe(PREVIEW_REFUSAL.error);
    expect(options.action.label).toBe("Regenerate from published and publish");
    expect(publishSchemaActionMock).toHaveBeenCalledTimes(1); // nothing regenerated until the user asks

    options.action.onClick();

    await waitFor(() => expect(publishSchemaActionMock).toHaveBeenCalledTimes(2));
    expect(publishSchemaActionMock).toHaveBeenLastCalledWith("entity-1", "bigquery", 1, { regenerateFromPublished: true });
    await waitFor(() => expect(toast.success).toHaveBeenCalledWith(expect.stringMatching(/published versions/)));
    expect(onVersionsChange).toHaveBeenCalled();
  });

  it("when regenerating fails (an entity was never published) its own message is shown, plainly", async () => {
    publishSchemaActionMock
      .mockResolvedValueOnce(PREVIEW_REFUSAL)
      .mockResolvedValueOnce({ error: "Sales / Orders / Customer has never been published, so a published schema cannot use it.", code: "NEVER_PUBLISHED" });
    render(<TechnologyCard {...baseProps} entityVersion={2} />);

    fireEvent.click(await screen.findByRole("button", { name: /mark deployed/i }));
    await waitFor(() => expect(toast.error).toHaveBeenCalledTimes(1));
    (vi.mocked(toast.error).mock.calls[0] as unknown as [string, { action: { onClick: () => void } }])[1].action.onClick();

    await waitFor(() => expect(toast.error).toHaveBeenCalledTimes(2));
    expect(toast.error).toHaveBeenLastCalledWith("Sales / Orders / Customer has never been published, so a published schema cannot use it.");
  });
});
