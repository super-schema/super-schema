import { describe, it, expect, vi } from "vitest";
import {
  metadataChangesDraft,
  entityUpdateTouchesDraft,
  markEntityDraftChanged,
  markEntityFieldsEdited,
  isSourceStale,
  MARK_FIELDS_EDITED_SQL,
  CLEAR_SOURCE_STALE_SQL,
  WRITE_BACK_SOURCE_SQL,
} from "@/lib/entity-versioning/draft-state";
import { describeDraftState, toDraftVersionState } from "@/lib/entity-versioning/draft-label";

describe("metadataChangesDraft", () => {
  it("treats tag, owner, relationship and retention edits as draft changes", () => {
    expect(metadataChangesDraft({ tags: ["a"] }, { tags: ["a", "b"] })).toBe(true);
    expect(metadataChangesDraft({}, { owner: "team-x" })).toBe(true);
    expect(
      metadataChangesDraft({ relationships: [] }, { relationships: [{ targetEntityId: "c", fieldId: "f", cardinality: "many-to-one" }] })
    ).toBe(true);
    expect(metadataChangesDraft({}, { retentionPolicy: { period: "P1Y" } })).toBe(true);
  });

  it("ignores system bookkeeping and lifecycle keys", () => {
    expect(metadataChangesDraft({ tags: ["a"] }, { tags: ["a"], schemaVersions: { avro: [] } })).toBe(false);
    expect(
      metadataChangesDraft(
        {},
        {
          schemaTargetTypeOverrides: {},
          semanticVersion: { major: 2, minor: 0 },
          versionHistory: [],
          typespecMigration: { status: "FLAGGED" },
          deprecation: { deprecated: true },
          sourceStale: true,
        }
      )
    ).toBe(false);
  });

  it("treats null, undefined and {} as the same empty metadata", () => {
    expect(metadataChangesDraft(null, {})).toBe(false);
    expect(metadataChangesDraft(undefined, null)).toBe(false);
  });
});

describe("entityUpdateTouchesDraft", () => {
  const before = { name: "Order", description: "", metadata: { tags: [] } };

  it("is false for a status-only update", () => {
    expect(entityUpdateTouchesDraft(before, { status: "ACTIVE" })).toBe(false);
  });

  it("is false when name and description are resent unchanged", () => {
    expect(entityUpdateTouchesDraft(before, { name: "Order", description: "" })).toBe(false);
  });

  it("is true for a rename, a description edit, or a draft metadata edit", () => {
    expect(entityUpdateTouchesDraft(before, { name: "PurchaseOrder" })).toBe(true);
    expect(entityUpdateTouchesDraft(before, { description: "Orders placed online" })).toBe(true);
    expect(entityUpdateTouchesDraft(before, { metadata: { tags: ["sales"] } })).toBe(true);
  });

  it("is false when only lifecycle metadata changes", () => {
    expect(entityUpdateTouchesDraft(before, { status: "DEPRECATED", metadata: { tags: [], deprecation: { deprecated: true } } })).toBe(false);
  });
});

describe("markEntityDraftChanged", () => {
  it("sets hasUnpublishedChanges on the entity row", async () => {
    const update = vi.fn().mockResolvedValue({ id: "e1" });
    await markEntityDraftChanged({ entity: { update } } as never, "e1");
    expect(update).toHaveBeenCalledWith({ where: { id: "e1" }, data: { hasUnpublishedChanges: true }, select: { id: true } });
  });
});

describe("source staleness (R42)", () => {
  it("isSourceStale is true only for metadata.sourceStale === true", () => {
    expect(isSourceStale({ sourceStale: true })).toBe(true);
    expect(isSourceStale({ sourceStale: false })).toBe(false);
    expect(isSourceStale({ sourceStale: "yes" })).toBe(false);
    expect(isSourceStale({})).toBe(false);
    expect(isSourceStale(null)).toBe(false);
    expect(isSourceStale(undefined)).toBe(false);
  });

  it("markEntityFieldsEdited flags the draft and the source stale in one statement", async () => {
    const run = vi.fn().mockResolvedValue(1);
    await markEntityFieldsEdited({ $executeRawUnsafe: run } as never, "e1");
    expect(run).toHaveBeenCalledTimes(1);
    expect(run).toHaveBeenCalledWith(MARK_FIELDS_EDITED_SQL, "e1");
    expect(MARK_FIELDS_EDITED_SQL).toContain(`"hasUnpublishedChanges" = true`);
    expect(MARK_FIELDS_EDITED_SQL).toContain("sourceStale");
  });

  it("the clear and write-back statements remove sourceStale (write-back also the 12.7 flag)", () => {
    expect(CLEAR_SOURCE_STALE_SQL).toContain("- 'sourceStale'");
    expect(WRITE_BACK_SOURCE_SQL).toContain(`"typespecSource" = $2`);
    expect(WRITE_BACK_SOURCE_SQL).toContain("- 'sourceStale'");
    expect(WRITE_BACK_SOURCE_SQL).toContain("- 'typespecMigration'");
  });
});

describe("describeDraftState / toDraftVersionState", () => {
  it("renders the three header states (spec §5.3)", () => {
    expect(describeDraftState({ latestVersionLabel: null, hasUnpublishedChanges: true })).toBe("Never published");
    expect(describeDraftState({ latestVersionLabel: "2.1", hasUnpublishedChanges: true })).toBe(
      "Draft · unpublished changes · latest v2.1"
    );
    expect(describeDraftState({ latestVersionLabel: "2.1", hasUnpublishedChanges: false })).toBe("Published · v2.1");
  });

  it("maps a loaded entity to the header state", () => {
    expect(toDraftVersionState({ hasUnpublishedChanges: false, latestVersion: { major: 3, minor: 0 } })).toEqual({
      latestVersionLabel: "3.0",
      hasUnpublishedChanges: false,
    });
    expect(toDraftVersionState({ hasUnpublishedChanges: true, latestVersion: null })).toEqual({
      latestVersionLabel: null,
      hasUnpublishedChanges: true,
    });
  });
});
