import { formatVersionLabel } from "./version-math";
import type { VersionNumber } from "./types";

/** What the entity header shows about Draft + Publish (spec §5.3). Client-safe. */
export interface DraftVersionState {
  latestVersionLabel: string | null;
  hasUnpublishedChanges: boolean;
}

export function describeDraftState(state: DraftVersionState): string {
  if (!state.latestVersionLabel) return "Never published";
  if (state.hasUnpublishedChanges) return `Draft · unpublished changes · latest v${state.latestVersionLabel}`;
  return `Published · v${state.latestVersionLabel}`;
}

/** Page loaders call this with the entity row (+ `latestVersion: { major, minor }` include). */
export function toDraftVersionState(entity: {
  hasUnpublishedChanges: boolean;
  latestVersion: VersionNumber | null;
}): DraftVersionState {
  return {
    latestVersionLabel: entity.latestVersion ? formatVersionLabel(entity.latestVersion) : null,
    hasUnpublishedChanges: entity.hasUnpublishedChanges,
  };
}
