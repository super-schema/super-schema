// ================================================================================================
// CUSTOMER PHONE — Interleaved child of Customer
// ================================================================================================
//
// All phone numbers for customer. Uses E.164 international phone number format.
// Implements hybrid denormalization pattern. Hard delete with audit log.
//
// TABLE_CATEGORY: TRANSACTIONAL | DELETE_PATTERN: HARD_DELETE
// ================================================================================================

namespace PayPal.CustomerDataStore;

using PayPal.CustomerDataStore.Decorators;

@doc("Phone numbers associated with a customer. Supports primary mobile, home, and additional phones with verification metadata.")
@interleaveInParent("Customer", "CASCADE")
@tableCategory("TRANSACTIONAL")
@deletePattern("HARD_DELETE")
@accountability("DTCDS-113", "dt-cp-identity-cds@paypal.com", "DT-CP-Identity-CDS")
@capacity(300)
@dataProvenance("TBD", "API")
@dataResidency(true, #["US", "EU", "APAC"])
@apiResource(#{
  basePath: "/v1/enterprise-data/customers/{customer_id}/phones",
  singularName: "phone",
  pluralName: "phones",
  operations: #["create", "list"],
  resourceScope: "sub_level_resource",
  parentEntity: "customer",
  parentPathParam: "customer_id"
})
@spannerIndex("idx_customer_phone_primary", #["primary_checker"], #{ unique: true, nullFiltered: true, description: "Unique null-filtered index enforcing single primary phone constraint per customer." })
model CustomerPhone {
  @doc("Foreign key to parent customer table, part of composite primary key and interleave key path.")
  @visibility(Lifecycle.Read)
  @infosecClass("Class 4")
  @accessScopes(#["customer:read"])
  customer_id: uuid;

  @doc("Globally unique UUID for customer_phone. Part of composite primary key.")
  @key
  @visibility(Lifecycle.Read)
  @infosecClass("Class 4")
  @accessScopes(#["customer:read"])
  phone_id: uuid;

  @doc("Phone number in E.164 international format with leading plus sign (e.g., +12345678901). Maximum 15 digits per E.164 specification.")
  @visibility(Lifecycle.Create, Lifecycle.Read)
  @infosecClass("Class 2")
  @pii @spi @cde
  @encrypted("cds-instance.cds_database.customer_phone.e164_phone_number", "AES-GCM")
  @dqRules(#["non_empty", "e164_format", "max_length_35"])
  @accessScopes(#["customer:pii:read"], #["customer:pii:write"])
  @ownedBy("customer-360")
  e164_phone_number: E164PhoneNumber;

  @doc("Optional phone extension number for business lines or switchboards. Maximum 20 characters. NULL for most consumer phone numbers.")
  @visibility(Lifecycle.Create, Lifecycle.Read)
  @infosecClass("Class 2")
  @pii @spi @cde
  @maxLength(20)
  @accessScopes(#["customer:read"], #["customer:pii:write"])
  @ownedBy("customer-360")
  extension_number?: string;

  @doc("Boolean flag for primary phone number. Only one phone per customer can have is_primary=TRUE, enforced by unique null-filtered index.")
  @visibility(Lifecycle.Create, Lifecycle.Read, Lifecycle.Update)
  @infosecClass("Class 4")
  @accessScopes(#["customer:read"], #["customer:pii:write"])
  @ownedBy("customer-360")
  is_primary: boolean;

  @doc("Generated column for uniqueness constraint. Evaluates to customer_id when is_primary=TRUE, NULL when is_primary=FALSE.")
  @visibility(Lifecycle.Read)
  @infosecClass("Class 4")
  @computed("IF(is_primary, customer_id, NULL)")
  primary_checker?: string;

  @doc("Classification of phone number type. Optional field as type can be inferred from is_primary flag and customer.type.")
  @visibility(Lifecycle.Create, Lifecycle.Read, Lifecycle.Update)
  @infosecClass("Class 4")
  @accessScopes(#["customer:read"], #["customer:pii:write"])
  @ownedBy("customer-360")
  phone_type?: PhoneType;

  @doc("Phone verification metadata stored as JSON.")
  @visibility(Lifecycle.Create, Lifecycle.Read, Lifecycle.Update)
  @infosecClass("Class 4")
  @schemaRef("schemas/common/phone_quality_metadata.json")
  @accessScopes(#["customer:read"], #["customer:pii:write"])
  @ownedBy("customer-360")
  quality_metadata: PhoneQualityMetadata;

  @doc("Spanner commit timestamp when phone number was added to customer record. Immutable after insert.")
  @visibility(Lifecycle.Read)
  @infosecClass("Class 5")
  @commitTimestamp
  @accessScopes(#["customer:read"])
  time_created: utcDateTime;
}
