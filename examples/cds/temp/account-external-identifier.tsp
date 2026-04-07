// ================================================================================================
// ACCOUNT EXTERNAL IDENTIFIER — Interleaved child of Account (depth 2)
// ================================================================================================
//
// Interleave path: customer → account → account_external_identifier
// Uses same shared pattern structure as customer_external_identifier.
// ================================================================================================

namespace PayPal.CustomerDataStore;

using PayPal.CustomerDataStore.Decorators;

@doc("External system identifiers for accounts (MPDS, Venmo, etc.). Used for cross-platform account identity resolution. Depth-2 interleaving under customer → account.")
@interleaveInParent("Account", "CASCADE")
@tableCategory("TRANSACTIONAL")
@accountability("DTCDS-113", "dt-cp-identity-cds@paypal.com", "DT-CP-Identity-CDS")
@capacity(350)
@dataProvenance("INTEGRATION_SYSTEMS", "API")
@dataResidency(true, #["US", "EU", "APAC"])
@apiResource(#{
  basePath: "/v1/enterprise-data/customers/{customer_id}/accounts/{account_id}/external_identifiers",
  singularName: "external_identifier",
  pluralName: "external_identifiers",
  operations: #["create", "list"],
  parentEntity: "account",
  parentPathParam: "account_id"
})
@spannerIndex("idx_account_external_lookup", #["brand", "external_system", "external_id"], #{ unique: true, description: "Unique lookup index to find PayPal account by external system identifier. Critical for MPDS, Venmo, and other platform account integrations." })
model AccountExternalIdentifier {
  @doc("Part of parent key path inherited from account table. Required for Spanner interleaving at depth 2 (customer → account → account_external_identifier).")
  @visibility(Lifecycle.Read)
  @infosecClass("Class 4")
  @accessScopes(#["account:read"])
  customer_id: uuid;

  @doc("Foreign key reference to parent account table UUID. Part of composite primary key and interleave key path.")
  @visibility(Lifecycle.Read)
  @infosecClass("Class 4")
  @accessScopes(#["account:read"])
  account_id: uuid;

  @doc("Fully-qualified domain name identifying external system (e.g., mpds.paypal.com, venmo.com, braintree.com). Part of composite primary key.")
  @key
  @visibility(Lifecycle.Create, Lifecycle.Read)
  @infosecClass("Class 4")
  @maxLength(256)
  @dqRules(#["non_empty", "fqdn_format"])
  @accessScopes(#["account:read"], #["account:write"])
  @ownedBy("integration")
  external_system: string;

  @doc("Unique identifier from external system for this account. Part of composite primary key. Used in unique index lookup.")
  @key
  @visibility(Lifecycle.Create, Lifecycle.Read)
  @infosecClass("Class 2")
  @pii @spi @cde
  @maxLength(256)
  @accessScopes(#["account:read"], #["account:write"])
  @ownedBy("integration")
  external_id: string;

  @doc("Denormalized brand value from customer.brand for efficient lookup index without requiring join to parent tables. Normalized to UPPERCASE.")
  @visibility(Lifecycle.Create, Lifecycle.Read)
  @infosecClass("Class 4")
  @maxLength(50)
  @accessScopes(#["account:read"], #["account:write"])
  @ownedBy("integration")
  brand: Brand;

  @doc("Spanner commit timestamp when external identifier mapping was created. Immutable after insert.")
  @visibility(Lifecycle.Read)
  @infosecClass("Class 5")
  @commitTimestamp
  @accessScopes(#["account:read"])
  time_created: utcDateTime;
}
