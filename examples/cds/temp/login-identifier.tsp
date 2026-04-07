// ================================================================================================
// LOGIN IDENTIFIER — Interleaved child of Customer
// ================================================================================================
//
// Authentication credentials and identity provider mappings.
// Owned by Auth domain - CDS provides read-only access.
// Normalization: Provider-specific, client responsible.
// Schema pending review with Auth team.
// ================================================================================================

namespace PayPal.CustomerDataStore;

using PayPal.CustomerDataStore.Decorators;

@doc("Login credentials and OAuth identity provider mappings. Owned by Auth domain - write access restricted via access control.")
@interleaveInParent("Customer", "CASCADE")
@tableCategory("TRANSACTIONAL")
@deletePattern("HARD_DELETE")
@accountability("DTCDS-113", "dt-cp-identity-cds@paypal.com", "DT-CP-Identity-CDS")
@dataProvenance("TBD", "API")
@dataResidency(true, #["US", "EU", "APAC"])
@apiResource(#{
  basePath: "/v1/enterprise-data/customers/{customer_id}/login_identifiers",
  singularName: "login_identifier",
  pluralName: "login_identifiers",
  operations: #["create", "list"],
  parentEntity: "customer",
  parentPathParam: "customer_id"
})
@spannerIndex("idx_login_brand_provider_alias", #["brand", "identity_provider", "alias"], #{ unique: true, description: "Unique index enforcing one alias per identity provider per brand. Serves as primary lookup index for authentication flows via findCustomerByUserIdentifier() API." })
model LoginIdentifier {
  @doc("Foreign key to parent customer table, part of composite primary key and interleave key path.")
  @visibility(Lifecycle.Read)
  @infosecClass("Class 4")
  @accessScopes(#["customer:read"])
  customer_id: uuid;

  @doc("Denormalized brand value from customer.brand for efficient lookup index without join to parent. Part of composite primary key. Normalized to UPPERCASE.")
  @key
  @visibility(Lifecycle.Read)
  @infosecClass("Class 4")
  @maxLength(50)
  @accessScopes(#["customer:read", "auth:read"])
  brand: Brand;

  @doc("External authentication provider. Part of composite primary key. Used in findCustomerByUserIdentifier() lookup index.")
  @key
  @visibility(Lifecycle.Read)
  @infosecClass("Class 4")
  @accessScopes(#["customer:read", "auth:read"])
  identity_provider: IdentityProvider;

  @doc("Email, username, or phone identifier. Part of composite primary key. Provider-specific normalization with client responsible (email: lowercase, GitHub/case-sensitive: preserve case).")
  @key
  @visibility(Lifecycle.Read)
  @infosecClass("Class 2")
  @pii @spi @cde
  @maxLength(256)
  @accessScopes(#["customer:pii:read", "auth:read"])
  alias: string;

  @doc("Classification of alias identifier type for validation and UX purposes.")
  @visibility(Lifecycle.Read)
  @infosecClass("Class 4")
  @accessScopes(#["customer:read", "auth:read"])
  alias_type: AliasType;

  @doc("Spanner commit timestamp when login identifier was created. Immutable after insert.")
  @visibility(Lifecycle.Read)
  @infosecClass("Class 5")
  @commitTimestamp
  @accessScopes(#["customer:read", "auth:read"])
  time_created: utcDateTime;
}
