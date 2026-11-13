import type { MetadataAttributeDefinition } from "@/types/schemas/metadata-attribute";
import { PAYPAL_SECURITY_CLASSIFICATION_PACK } from "@/lib/metadata-attributes/packs/paypal-security-classification";

/** A code-defined, ready-made set of Metadata Attribute Dictionary entries; installing it upserts them for a tenant. */
export interface MetadataPack {
  id: string;
  name: string;
  description: string;
  definitions: Omit<MetadataAttributeDefinition, "pack">[];
}

export const METADATA_PACKS: readonly MetadataPack[] = [PAYPAL_SECURITY_CLASSIFICATION_PACK];

export function getMetadataPack(id: string): MetadataPack | undefined {
  return METADATA_PACKS.find((p) => p.id === id);
}
