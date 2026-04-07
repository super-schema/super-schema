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

vi.mock("@/app/(dashboard)/schemas/[domainSlug]/[entityId]/actions", () => ({
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
  "@/app/(dashboard)/schemas/[domainSlug]/[entityId]/components/SchemaVersionList",
  () => ({
    StatusBadge: ({ status }: { status: string }) => <span>{status}</span>,
    SchemaVersionList: () => <div data-testid="schema-version-list" />,
  })
);

vi.mock(
  "@/app/(dashboard)/schemas/[domainSlug]/[entityId]/components/SchemaCodePreview",
  () => ({
    SchemaCodePreview: ({ code }: { code: string }) => <pre>{code}</pre>,
  })
);

import { TechnologyCard } from "@/app/(dashboard)/schemas/[domainSlug]/[entityId]/components/TechnologyCard";

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
});
