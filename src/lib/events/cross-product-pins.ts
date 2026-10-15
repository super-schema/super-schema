// src/lib/events/cross-product-pins.ts
/**
 * Cross-product pin guard (pure, client-safe) for Product / Domain deletes.
 *
 * A PUBLISHED event spec version is immutable and keeps pointing at what it was published against: message
 * versions (`messageVersionIds` + `schema_references` EVENT_SPEC_VERSION -> MESSAGE_VERSION edges) and the channels
 * / traits it froze (`frozenChannels` / `frozenTraits`). Deleting the owner of such an asset from under a spec in
 * another product would orphan the pin, so the delete is blocked and the referencing specs are named.
 */

import { joinList } from "@/lib/product-deletion";

export type PinnedAssetKind = "Message" | "Channel" | "Trait";

export interface PinnedAsset {
  kind: PinnedAssetKind;
  name: string;
}

/** One event spec of ANOTHER product (same tenant) whose published versions reference assets owned by the delete target. */
export interface CrossProductPin {
  specId: string;
  specName: string;
  productId: string;
  productName: string;
  /** Labels ("1.0") of the published versions that reference the assets, oldest first. */
  versions: string[];
  /** The referenced assets, de-duplicated, sorted by kind then name. */
  assets: PinnedAsset[];
}

export const MAX_NAMED_PIN_SPECS = 5;
export const MAX_NAMED_PIN_ASSETS = 3;
export const MAX_NAMED_PIN_VERSIONS = 3;

function assetList(assets: PinnedAsset[]): string {
  const shown = assets.slice(0, MAX_NAMED_PIN_ASSETS).map((a) => `${a.kind} "${a.name}"`);
  const more = assets.length - shown.length;
  return joinList(more > 0 ? [...shown, `${more} more`] : shown);
}

/** "v1.0, v1.1, v2.0", or "v1.0, v1.1, v2.0 and 4 more" for a spec with many published versions (the message stays bounded). */
function versionList(versions: string[]): string {
  const shown = versions.slice(0, MAX_NAMED_PIN_VERSIONS).map((v) => `v${v}`);
  const more = versions.length - shown.length;
  return more > 0 ? `${shown.join(", ")} and ${more} more` : shown.join(", ");
}

function describePin(p: CrossProductPin): string {
  return `"${p.specName}" (product "${p.productName}", ${versionList(p.versions)}) references ${assetList(p.assets)}`;
}

/** The block message naming the referencing specs + products, or null when no other product's spec references the target. */
export function crossProductPinBlocker(pins: CrossProductPin[]): string | null {
  if (pins.length === 0) return null;
  const shown = pins.slice(0, MAX_NAMED_PIN_SPECS).map(describePin);
  const more = pins.length - shown.length;
  const single = pins.length === 1;
  const subject = single
    ? "A published event spec in another product references assets owned here"
    : "Published event specs in other products reference assets owned here";
  const fix = single
    ? "Delete that event spec first (published versions cannot be changed), then retry"
    : "Delete those event specs first (published versions cannot be changed), then retry";
  return `${subject}: ${shown.join("; ")}${more > 0 ? ` and ${more} more` : ""}. ${fix}.`;
}
