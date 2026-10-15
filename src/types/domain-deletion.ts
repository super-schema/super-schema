export interface DomainDeletionImpact {
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
}
