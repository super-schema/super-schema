// ================================================================================================
// ACCESSIBLE RESOURCE — Interleaved child of Customer
// ================================================================================================
//
// Access grants for secondary users in MUMA (Multi-User Merchant Account),
// Family accounts, and MAM (Managed Account Management) scenarios.
// Schema pending review with Auth team.
// ================================================================================================

namespace PayPal.CustomerDataStore;

using PayPal.CustomerDataStore.Decorators;

@doc("Access grants for secondary users (MUMA, Family accounts, MAM). Maps users to resources they can access with specific permissions.")
@interleaveInParent("Customer", "CASCADE")
@tableCategory("TRANSACTIONAL")
@accountability("DTCDS-113", "dt-cp-identity-cds@paypal.com", "DT-CP-Identity-CDS")
@capacity(300)
@dataProvenance("TBD", "API")
@dataResidency(true, #["US", "EU", "APAC"])
@apiResource(#{
  basePath: "/v1/enterprise-data/customers/{customer_id}/accessible_resources",
  singularName: "accessible_resource",
  pluralName: "accessible_resources",
  operations: #["create", "list"],
  parentEntity: "customer",
  parentPathParam: "customer_id"
})
@spannerIndex("idx_accessible_resource_lookup", #["resource_type", "resource_id", "customer_id"], #{ unique: false, description: "Reverse lookup index to find all users with access to a specific resource. Supports 'Who has access to this account?' queries for MUMA, Family accounts, and MAM access control management." })
model AccessibleResource {
  @doc("Foreign key to customer table, part of composite primary key and interleave key path. This is the user who has been granted access.")
  @visibility(Lifecycle.Read)
  @infosecClass("Class 4")
  @accessScopes(#["customer:read", "access:read"])
  customer_id: uuid;

  @doc("Globally unique UUID for accessible_resource. Part of composite primary key.")
  @key
  @visibility(Lifecycle.Read)
  @infosecClass("Class 4")
  @accessScopes(#["customer:read"])
  accessible_resource_id: uuid;

  @doc("Type of resource being accessed. Currently only ACCOUNT supported.")
  @visibility(Lifecycle.Create, Lifecycle.Read)
  @infosecClass("Class 4")
  @accessScopes(#["access:read"], #["access:write"])
  @ownedBy("access-control")
  resource_type: ResourceType;

  @doc("UUID of accessible resource (e.g., account_id). Used in reverse lookup index for 'Who has access to this account?' queries.")
  @visibility(Lifecycle.Create, Lifecycle.Read)
  @infosecClass("Class 4")
  @maxLength(36)
  @accessScopes(#["access:read"], #["access:write"])
  @ownedBy("access-control")
  resource_id: uuid;

  @doc("Array of permission roles granted to secondary user for this resource. Multiple roles supported for granular access control (e.g., MANAGE_ACCOUNT_ACCESS, VIEW_TRANSACTION, SEND_MONEY).")
  @visibility(Lifecycle.Create, Lifecycle.Read, Lifecycle.Update)
  @infosecClass("Class 4")
  @accessScopes(#["access:read"], #["access:write"])
  @ownedBy("access-control")
  @maxItems(50)
  roles: string[];
}
