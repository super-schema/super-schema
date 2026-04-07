// ================================================================================================
// CUSTOMER EXTERNAL IDENTIFIER — Interleaved child of Customer
// ================================================================================================

namespace PayPal.CustomerDataStore;

using PayPal.CustomerDataStore.Decorators;

@doc("External system identifiers for customer (Venmo, Braintree, etc.). Used for cross-platform identity resolution.")
@interleaveInParent("Customer", "CASCADE")
@tableCategory("TRANSACTIONAL")
@accountability("DTCDS-113", "dt-cp-identity-cds@paypal.com", "DT-CP-Identity-CDS")
@capacity(350)
@dataProvenance("INTEGRATION_SYSTEMS", "API")
@dataResidency(true, #["US", "EU", "APAC"])
@apiResource(#{
  basePath: "/v1/enterprise-data/customers/{customer_id}/external_identifiers",
  singularName: "external_identifier",
  pluralName: "external_identifiers",
  operations: #["create", "list"],
  parentEntity: "customer",
  parentPathParam: "customer_id"
})
@spannerIndex("idx_customer_external_id_brand_lookup", #["brand", "external_system", "external_id"], #{ unique: true, description: "Unique lookup index to find PayPal customer by external system identifier. Supports brand-scoped queries. Critical for Venmo, Braintree, and other platform integrations." })
model CustomerExternalIdentifier {
  @doc("Foreign key reference to parent customer table UUID. Part of composite primary key.")
  @visibility(Lifecycle.Read)
  @infosecClass("Class 4")
  @accessScopes(#["customer:read"])
  customer_id: uuid;

  @doc("Fully-qualified domain name identifying external system (e.g., venmo.com, braintree.com). Part of composite key index.")
  @key
  @visibility(Lifecycle.Create, Lifecycle.Read)
  @infosecClass("Class 4")
  @maxLength(256)
  @dqRules(#["non_empty", "fqdn_format"])
  @accessScopes(#["customer:read"], #["customer:write"])
  @ownedBy("integration")
  external_system: string;

  @doc("Unique identifier from external system for this customer. Part of composite key index.")
  @key
  @visibility(Lifecycle.Create, Lifecycle.Read)
  @infosecClass("Class 2")
  @pii @spi @cde
  @maxLength(256)
  @accessScopes(#["customer:read"], #["customer:write"])
  @ownedBy("integration")
  external_id: string;

  @doc("Denormalized brand value from customer.brand for efficient lookup index without requiring join to parent table. Normalized to UPPERCASE.")
  @visibility(Lifecycle.Create, Lifecycle.Read)
  @infosecClass("Class 4")
  @maxLength(50)
  @accessScopes(#["customer:read"], #["customer:write"])
  @ownedBy("integration")
  brand: Brand;

  @doc("Spanner commit timestamp when external identifier mapping was created. Immutable after insert.")
  @visibility(Lifecycle.Read)
  @infosecClass("Class 5")
  @commitTimestamp
  @accessScopes(#["customer:read"])
  time_created: utcDateTime;
}
