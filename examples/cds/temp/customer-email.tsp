// ================================================================================================
// CUSTOMER EMAIL — Interleaved child of Customer
// ================================================================================================
//
// All email addresses for customer including primary and additional emails.
// Implements hybrid denormalization pattern where primary email is duplicated
// in customer.person_primary_email for 95% fast read optimization.
// Uses hard delete pattern with audit log. Unique null-filtered index enforces
// single primary email per customer.
//
// TABLE_CATEGORY: TRANSACTIONAL | DELETE_PATTERN: HARD_DELETE
// ================================================================================================

namespace PayPal.CustomerDataStore;

using PayPal.CustomerDataStore.Decorators;

@doc("Email addresses associated with a customer. Supports primary and additional emails with verification metadata.")
@interleaveInParent("Customer", "CASCADE")
@tableCategory("TRANSACTIONAL")
@deletePattern("HARD_DELETE")
@accountability("DTCDS-113", "dt-cp-identity-cds@paypal.com", "DT-CP-Identity-CDS")
@capacity(400)
@dataProvenance("TBD", "API")
@dataResidency(true, #["US", "EU", "APAC"])
@apiResource(#{
  basePath: "/v1/enterprise-data/customers/{customer_id}/emails",
  singularName: "email",
  pluralName: "emails",
  operations: #["create", "list"],
  parentEntity: "customer",
  parentPathParam: "customer_id"
})
@spannerIndex("idx_customer_email_primary", #["primary_checker"], #{ unique: true, nullFiltered: true, description: "Unique null-filtered index enforcing single primary email constraint per customer. Uses generated column primary_checker (customer_id when is_primary=TRUE, NULL otherwise)." })
model CustomerEmail {
  @doc("Foreign key to parent customer table, part of composite primary key and interleave key path.")
  @visibility(Lifecycle.Read)
  @infosecClass("Class 4")
  @accessScopes(#["customer:read"])
  customer_id: uuid;

  @doc("Globally unique UUID for customer_email. Part of composite primary key.")
  @key
  @visibility(Lifecycle.Read)
  @infosecClass("Class 4")
  @accessScopes(#["customer:read"])
  email_id: uuid;

  @doc("Email address in RFC 5321 standard format, maximum 254 characters. Used for customer communication and verification.")
  @visibility(Lifecycle.Create, Lifecycle.Read)
  @infosecClass("Class 2")
  @pii @spi @cde
  @encrypted("cds-instance.cds_database.customer_email.email_address", "AES-GCM")
  @dqRules(#["non_empty", "email_format", "max_length_254"])
  @accessScopes(#["customer:pii:read"], #["customer:pii:write"])
  @ownedBy("customer-360")
  email_address: EmailAddress;

  @doc("Boolean flag indicating primary email address for customer. Only one email per customer can have is_primary=TRUE, enforced by unique null-filtered index.")
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

  @doc("Email quality and verification metadata stored as JSON.")
  @visibility(Lifecycle.Create, Lifecycle.Read, Lifecycle.Update)
  @infosecClass("Class 4")
  @schemaRef("schemas/common/email_quality_metadata.json")
  @accessScopes(#["customer:read"], #["customer:pii:write"])
  @ownedBy("customer-360")
  quality_metadata: EmailQualityMetadata;

  @doc("Spanner commit timestamp when email address was added to customer record. Immutable after insert.")
  @visibility(Lifecycle.Read)
  @infosecClass("Class 5")
  @commitTimestamp
  @accessScopes(#["customer:read"])
  time_created: utcDateTime;
}
