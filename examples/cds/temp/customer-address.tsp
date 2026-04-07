// ================================================================================================
// CUSTOMER ADDRESS — Interleaved child of Customer
// ================================================================================================
//
// All physical addresses for customer. Supports international addressing with
// 4-level administrative area hierarchy. Hard delete with audit log.
//
// TABLE_CATEGORY: TRANSACTIONAL | DELETE_PATTERN: HARD_DELETE
// ================================================================================================

namespace PayPal.CustomerDataStore;

using PayPal.CustomerDataStore.Decorators;

@doc("Addresses associated with a customer. Supports primary residence, mailing, previous, and organization addresses with verification metadata.")
@interleaveInParent("Customer", "CASCADE")
@tableCategory("TRANSACTIONAL")
@deletePattern("HARD_DELETE")
@accountability("DTCDS-113", "dt-cp-identity-cds@paypal.com", "DT-CP-Identity-CDS")
@capacity(850)
@dataProvenance("TBD", "API")
@dataResidency(true, #["US", "EU", "APAC"])
@apiResource(#{
  basePath: "/v1/enterprise-data/customers/{customer_id}/addresses",
  singularName: "address",
  pluralName: "addresses",
  operations: #["create", "list"],
  resourceScope: "sub_level_resource",
  parentEntity: "customer",
  parentPathParam: "customer_id"
})
@spannerIndex("idx_customer_address_primary", #["primary_checker"], #{ unique: true, nullFiltered: true, description: "Unique null-filtered index enforcing single primary address constraint per customer." })
model CustomerAddress {
  @doc("Foreign key to parent customer table, part of composite primary key and interleave key path.")
  @visibility(Lifecycle.Read)
  @infosecClass("Class 4")
  @accessScopes(#["customer:read"])
  customer_id: uuid;

  @doc("Globally unique UUID for customer_address. Part of composite primary key.")
  @key
  @visibility(Lifecycle.Read)
  @infosecClass("Class 4")
  @accessScopes(#["customer:read"])
  address_id: uuid;

  @doc("Portable international postal address stored as JSON. Contains standard address lines, 4-level administrative area hierarchy, postal_code, country_code, and nested address_details. Follows PayPal Portable Postal Address (Medium-Grained) specification.")
  @visibility(Lifecycle.Create, Lifecycle.Read, Lifecycle.Update)
  @infosecClass("Class 2")
  @pii @spi @cde
  @encrypted("cds-instance.cds_database.customer_address.address", "AES-GCM")
  @schemaRef("schema-ref/common/address.json")
  @accessScopes(#["customer:pii:read"], #["customer:pii:write"])
  @ownedBy("customer-360")
  address: PostalAddress;

  @doc("Country code in ISO 3166-1 alpha-2 format. Required for address validation and compliance.")
  @visibility(Lifecycle.Create, Lifecycle.Read)
  @infosecClass("Class 2")
  @pii @spi @cde
  @dqRules(#["non_empty", "iso_3166_1_alpha2"])
  @accessScopes(#["customer:read"], #["customer:pii:write"])
  @ownedBy("customer-360")
  country_code: CountryCode;

  @doc("Script or writing system for the address (CYRILLIC, KANJI, KATAKANA, ROMAJI, Kana, Latn, Thai, UNKNOWN).")
  @visibility(Lifecycle.Create, Lifecycle.Read, Lifecycle.Update)
  @infosecClass("Class 4")
  @maxLength(255)
  @accessScopes(#["customer:read"], #["customer:pii:write"])
  @ownedBy("customer-360")
  orthography?: string;

  @doc("Boolean flag indicating primary address for customer. Only one address per customer can have is_primary=TRUE.")
  @visibility(Lifecycle.Create, Lifecycle.Read, Lifecycle.Update)
  @infosecClass("Class 4")
  @accessScopes(#["customer:read"], #["customer:pii:write"])
  @ownedBy("customer-360")
  is_primary: boolean;

  @doc("Generated column for uniqueness constraint enforcement. Evaluates to customer_id when is_primary=TRUE, NULL when is_primary=FALSE.")
  @visibility(Lifecycle.Read)
  @infosecClass("Class 4")
  @computed("IF(is_primary, customer_id, NULL)")
  primary_checker?: string;

  @doc("Address classification to distinguish usage purpose.")
  @visibility(Lifecycle.Create, Lifecycle.Read, Lifecycle.Update)
  @infosecClass("Class 4")
  @accessScopes(#["customer:read"], #["customer:pii:write"])
  @ownedBy("customer-360")
  address_type?: AddressType;

  @doc("Additional address metadata tags (e.g., likely_po_box indicator).")
  @visibility(Lifecycle.Create, Lifecycle.Read, Lifecycle.Update)
  @infosecClass("Class 4")
  @accessScopes(#["customer:read"], #["customer:pii:write"])
  @ownedBy("customer-360")
  tags?: AddressTags;

  @doc("Address quality and verification metadata stored as JSON containing confirmation_status, confirmation_authority, validation_status, validation_authority, normalization_status, and associated timestamps.")
  @visibility(Lifecycle.Create, Lifecycle.Read, Lifecycle.Update)
  @infosecClass("Class 4")
  @schemaRef("schemas/common/address_quality_metadata.json")
  @accessScopes(#["customer:read"], #["customer:pii:write"])
  @ownedBy("customer-360")
  quality_metadata: AddressQualityMetadata;

  @doc("Spanner commit timestamp when address was added to customer record. Immutable after insert.")
  @visibility(Lifecycle.Read)
  @infosecClass("Class 5")
  @commitTimestamp
  @accessScopes(#["customer:read"])
  time_created: utcDateTime;
}
