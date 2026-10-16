import type { EventsAssetCounts } from "@/lib/product-deletion";

export interface DomainDeletionImpact extends EventsAssetCounts {
  entities: number;
  /** Products in the domain — deleted (cascade) with it. */
  products: number;
  /**
   * Product-level Data Types (enums, scalars, unions) and APIs. Already included in
   * the per-kind counts below (product-level assets carry the domainId too); surfaced
   * separately so the confirmation can say they go with their products.
   */
  productLevelAssets: number;
  modelDefinitions: number;
  decoratorDefinitions: number;
  sharedEnums: number;
  customScalars: number;
  unionTypes: number;
  services: number;
  interfaces: number;
  userRoles: number;
  // `traits` and `eventSpecs` (EventsAssetCounts) count the Events assets of the domain and its products at every
  // level; like entities they block the delete instead of cascading.
}
