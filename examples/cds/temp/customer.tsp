// ================================================================================================
// CUSTOMER — Root Entity
// ================================================================================================
//
// Root entity combining customer core identity with collapsed person profile and
// business profile data for optimal latency. Uses denormalization per Spanner best
// practices with 100% data minimization via column projection.
//
// Supports both INDIVIDUAL and ORGANIZATION customer types with ~50% NULL columns
// depending on type.
//
// TABLE_CATEGORY: TRANSACTIONAL
// JIRA: DTCDS-113
// ================================================================================================

namespace PayPal.CustomerDataStore;

using PayPal.CustomerDataStore.Decorators;

@doc("Customer entity representing individuals and organizations with federated data ownership. Supports data minimization via selective attribute retrieval.")
@tableCategory("TRANSACTIONAL")
@accountability("DTCDS-113", "dt-cp-identity-cds@paypal.com", "DT-CP-Identity-CDS")
@capacity(2800)
@dataProvenance("TBD", "API")
@dataResidency(true, #["US", "EU", "APAC"])
@apiResource(#{
  basePath: "/v1/enterprise-data/customers",
  singularName: "customer",
  pluralName: "customers",
  operations: #["create", "read", "update", "delete"],
  resourceScope: "top_level_resource",
  defaultPageSize: 50
})
@fieldset(
  "profile_summary",
  "Quick customer identity snapshot (denormalized fields)",
  #["customer_id", "party_id", "brand", "customer_type", "status", "legal_entity", "legal_country", "person_legal_name", "person_primary_email", "person_primary_mobile_phone", "organization_legal_name", "organization_trading_name"]
)
@fieldset(
  "contact_info",
  "All contact channels across customer root + interleaved email/phone/address tables",
  #["customer_id", "brand", "person_primary_email", "person_primary_mobile_phone", "person_primary_home_phone", "person_primary_residential_address"]
)
@spannerIndex("idx_customer_party_id", #["party_id"], #{ unique: true, description: "Unique index on legacy party_id for backward compatibility lookups. Supports migration from legacy party management systems." })
model Customer {
  // ── Primary Key ──────────────────────────────────────────────────────────

  @doc("Unique UUID identifier for customer, serves as primary key. Not the legacy party_id but a modern UUID-based identifier for clean data architecture.")
  @key
  @visibility(Lifecycle.Read)
  @infosecClass("Class 4")
  @accessScopes(#["customer:read"])
  customer_id: uuid;

  // ── Business Identifiers ─────────────────────────────────────────────────

  @doc("Legacy party_id from party management v2 system for backward compatibility lookups. Indexed for migration path support. Will eventually be deprecated in favor of customer_id.")
  @visibility(Lifecycle.Read)
  @infosecClass("Class 3")
  @pii @spi @cde
  @maxLength(20)
  @accessScopes(#["customer:read"])
  party_id?: string;

  // ── Core Identity ────────────────────────────────────────────────────────

  @doc("Brand namespace for customer. Normalized to UPPERCASE for consistency. Provides brand-based partitioning without hard tenant isolation.")
  @visibility(Lifecycle.Create, Lifecycle.Read)
  @infosecClass("Class 4")
  @accessScopes(#["customer:read"], #["customer:lifecycle:write"])
  @ownedBy("customer-360")
  brand: Brand;

  @doc("Customer type distinguishing individual consumers from business organizations. Determines which profile columns are populated (person_* vs organization_*).")
  @visibility(Lifecycle.Create, Lifecycle.Read)
  @infosecClass("Class 4")
  @accessScopes(#["customer:read"], #["customer:lifecycle:write"])
  @ownedBy("customer-360")
  customer_type: CustomerType;

  @doc("Customer relationship lifecycle status. ACTIVE for ongoing relationships, CLOSED when all accounts terminated.")
  @visibility(Lifecycle.Create, Lifecycle.Read, Lifecycle.Update)
  @infosecClass("Class 4")
  @accessScopes(#["customer:read"], #["customer:lifecycle:write"])
  @ownedBy("customer-360")
  status: CustomerStatus;

  @doc("PayPal legal entity for this customer relationship. Determines contractual terms and regulatory jurisdiction.")
  @visibility(Lifecycle.Create, Lifecycle.Read)
  @infosecClass("Class 4")
  @accessScopes(#["customer:read"], #["customer:lifecycle:write"])
  @ownedBy("customer-360")
  legal_entity?: LegalEntity;

  @doc("Customer legal country of residence in ISO 3166-1 alpha-2 format. Critical for compliance, tax jurisdiction, and future geo-partitioning by region.")
  @visibility(Lifecycle.Create, Lifecycle.Read, Lifecycle.Update)
  @infosecClass("Class 3")
  @pii @spi @cde
  @dqRules(#["non_empty", "iso_3166_1_alpha2"])
  @accessScopes(#["customer:read"], #["customer:pii:write"])
  @ownedBy("customer-360")
  legal_country: CountryCode;

  @doc("Geographic placement region for data locality and multi-region optimization. Populated by application logic based on legal_country. Enables Spanner to co-locate customer data within the same regional split for optimal query performance (p95 15-25ms home region reads).")
  @infosecClass("Class 4")
  @placementKey
  placement_region: string;

  // ── Timestamps ───────────────────────────────────────────────────────────

  @doc("Customer record creation timestamp using Spanner commit timestamp. Immutable after insert. Used for RIG retention policy enforcement and audit trails.")
  @visibility(Lifecycle.Read)
  @infosecClass("Class 5")
  @commitTimestamp
  @accessScopes(#["customer:read"])
  time_created: utcDateTime;

  @doc("Timestamp when customer activated their first account. NULL until first account activation. Used for customer lifecycle analytics and engagement metrics.")
  @visibility(Lifecycle.Read, Lifecycle.Update)
  @infosecClass("Class 5")
  @accessScopes(#["customer:read"], #["customer:lifecycle:write"])
  @ownedBy("customer-360")
  time_activated?: utcDateTime;

  @doc("Timestamp when customer relationship ended with all accounts closed. NULL for active customers. Used with status=CLOSED for customer relationship lifecycle tracking.")
  @visibility(Lifecycle.Read, Lifecycle.Update)
  @infosecClass("Class 5")
  @accessScopes(#["customer:read"], #["customer:lifecycle:write"])
  @ownedBy("customer-360")
  time_closed?: utcDateTime;

  // ── Locale ───────────────────────────────────────────────────────────────

  @doc("Customer locale preferences stored as JSON containing language, country, and timezone. Replaces separate locale table per Spanner best practice for co-queried data.")
  @visibility(Lifecycle.Create, Lifecycle.Read, Lifecycle.Update)
  @infosecClass("Class 4")
  @schemaRef("schemas/customer/locale.json")
  @accessScopes(#["customer:read"], #["customer:profile:write"])
  @ownedBy("customer-360")
  locale?: Locale;

  // ── Person Profile (NULL for ORGANIZATION) ───────────────────────────────

  @doc("Array of ISO 3166-1 alpha-2 country codes representing person citizenship. Supports multiple citizenship. NULL for ORGANIZATION type customers.")
  @visibility(Lifecycle.Create, Lifecycle.Read, Lifecycle.Update)
  @infosecClass("Class 3")
  @pii @spi @cde
  @encrypted("cds-instance.cds_database.customer.person_citizenship", "AES-GCM")
  @dqRules(#["iso_3166_1_alpha2_array"])
  @accessScopes(#["customer:pii:read"], #["customer:pii:write"])
  @ownedBy("customer-360")
  person_citizenship?: CountryCode[];

  @doc("Person gender self-identification. NULL for ORGANIZATION type customers. Optional field respecting customer privacy preferences.")
  @visibility(Lifecycle.Create, Lifecycle.Read, Lifecycle.Update)
  @infosecClass("Class 3")
  @pii @spi @cde
  @encrypted("cds-instance.cds_database.customer.person_gender", "AES-GCM")
  @accessScopes(#["customer:pii:read"], #["customer:pii:write"])
  @ownedBy("customer-360")
  person_gender?: Gender;

  @doc("Legal name as it appears on official documents (passport, government ID). Includes confirmation metadata.")
  @visibility(Lifecycle.Create, Lifecycle.Read, Lifecycle.Update)
  @infosecClass("Class 2")
  @pii @spi @cde
  @encrypted("cds-instance.cds_database.customer.person_legal_name", "AES-GCM")
  @schemaRef("schemas/common/legal_name.json")
  @accessScopes(#["customer:pii:read"], #["customer:pii:write"])
  @ownedBy("customer-360")
  person_legal_name?: LegalName;

  @doc("Birth information including date and place of birth. Used for identity verification and age verification. Highly sensitive PII requiring strict access controls.")
  @visibility(Lifecycle.Create, Lifecycle.Read, Lifecycle.Update)
  @infosecClass("Class 3")
  @pii @spi @cde
  @encrypted("cds-instance.cds_database.customer.person_birth_details", "AES-GCM")
  @schemaRef("schemas/customer/birth_details.json")
  @accessScopes(#["customer:pii:read"], #["customer:pii:write"])
  @ownedBy("customer-360")
  person_birth_details?: BirthDetails;

  // ── Person Primary Contacts (Denormalized for fast reads) ────────────────
  // ALL contacts (including primary) also stored in interleaved tables for extensibility.
  // Hybrid denormalization: write to both locations.

  @doc("Primary email address for the individual. Denormalized from customer_email table for 95% fast read optimization. Hybrid pattern: write to both locations. NULL for ORGANIZATION customers.")
  @visibility(Lifecycle.Create, Lifecycle.Read, Lifecycle.Update)
  @infosecClass("Class 2")
  @pii @spi @cde
  @encrypted("cds-instance.cds_database.customer.person_primary_email", "AES-GCM")
  @schemaRef("schemas/common/email.json")
  @accessScopes(#["customer:pii:read"], #["customer:pii:write"])
  @ownedBy("customer-360")
  person_primary_email?: EmailContact;

  @doc("Primary mobile phone number. Used for SMS 2FA and notifications. Denormalized from customer_phone table for fast reads. NULL for ORGANIZATION customers.")
  @visibility(Lifecycle.Create, Lifecycle.Read, Lifecycle.Update)
  @infosecClass("Class 2")
  @pii @spi @cde
  @encrypted("cds-instance.cds_database.customer.person_primary_mobile_phone", "AES-GCM")
  @schemaRef("schemas/common/phone.json")
  @accessScopes(#["customer:pii:read"], #["customer:pii:write"])
  @ownedBy("customer-360")
  person_primary_mobile_phone?: PhoneContact;

  @doc("Primary home phone number for voice contact. Denormalized from customer_phone table for performance. NULL for ORGANIZATION customers.")
  @visibility(Lifecycle.Create, Lifecycle.Read, Lifecycle.Update)
  @infosecClass("Class 2")
  @pii @spi @cde
  @encrypted("cds-instance.cds_database.customer.person_primary_home_phone", "AES-GCM")
  @schemaRef("schemas/common/phone.json")
  @accessScopes(#["customer:pii:read"], #["customer:pii:write"])
  @ownedBy("customer-360")
  person_primary_home_phone?: PhoneContact;

  @doc("Primary residence address. Denormalized from customer_address table for 95% read optimization. Hybrid write pattern. NULL for ORGANIZATION customers.")
  @visibility(Lifecycle.Create, Lifecycle.Read, Lifecycle.Update)
  @infosecClass("Class 2")
  @pii @spi @cde
  @encrypted("cds-instance.cds_database.customer.person_primary_residential_address", "AES-GCM")
  @schemaRef("schemas/common/address.json")
  @accessScopes(#["customer:pii:read"], #["customer:pii:write"])
  @ownedBy("customer-360")
  person_primary_residential_address?: PostalAddress;

  // ── Organization Profile (NULL for INDIVIDUAL) ───────────────────────────

  @doc("Official registered legal name of organization as filed with government authorities. NULL for INDIVIDUAL customers. Used for KYC, legal documentation, and regulatory reporting.")
  @visibility(Lifecycle.Create, Lifecycle.Read, Lifecycle.Update)
  @infosecClass("Class 2")
  @pii @spi @cde
  @encrypted("cds-instance.cds_database.customer.organization_legal_name", "AES-GCM")
  @maxLength(256)
  @accessScopes(#["customer:read"], #["customer:profile:write"])
  @ownedBy("customer-360")
  organization_legal_name?: string;

  @doc("The Doing Business As (DBA) or trading name used by organization in commerce. May differ from legal name. NULL for INDIVIDUAL customers.")
  @visibility(Lifecycle.Create, Lifecycle.Read, Lifecycle.Update)
  @infosecClass("Class 2")
  @pii @spi @cde
  @encrypted("cds-instance.cds_database.customer.organization_trading_name", "AES-GCM")
  @maxLength(256)
  @accessScopes(#["customer:read"], #["customer:profile:write"])
  @ownedBy("customer-360")
  organization_trading_name?: string;

  @doc("Tax identification information for the organization. Critical for tax compliance and regulatory reporting.")
  @visibility(Lifecycle.Create, Lifecycle.Read, Lifecycle.Update)
  @infosecClass("Class 2")
  @pii @pci @spi @cde
  @encrypted("cds-instance.cds_database.customer.organization_tax_details", "AES-GCM")
  @schemaRef("schemas/account/tax_info.json")
  @accessScopes(#["customer:tax:read"], #["customer:tax:write"])
  @ownedBy("tax")
  organization_tax_details?: TaxDetails;

  @doc("Organization type and subtype classification (e.g., corporation, partnership, sole proprietorship, nonprofit). NULL for INDIVIDUAL customers.")
  @visibility(Lifecycle.Create, Lifecycle.Read, Lifecycle.Update)
  @infosecClass("Class 4")
  @schemaRef("schemas/customer/organization_type.json")
  @accessScopes(#["customer:read"], #["customer:profile:write"])
  @ownedBy("customer-360")
  organization_type?: OrganizationType;

  @doc("Incorporation details including date, country, and registration number. NULL for INDIVIDUAL customers. Used for business verification and compliance.")
  @visibility(Lifecycle.Create, Lifecycle.Read, Lifecycle.Update)
  @infosecClass("Class 3")
  @pii @spi @cde
  @encrypted("cds-instance.cds_database.customer.organization_incorporation", "AES-GCM")
  @schemaRef("schemas/customer/organization_incorporation.json")
  @accessScopes(#["customer:read"], #["customer:profile:write"])
  @ownedBy("customer-360")
  organization_incorporation?: IncorporationDetails;

  @doc("Primary contact email for PayPal to reach the organization (account notifications, compliance, tax forms). NULL for INDIVIDUAL customers.")
  @visibility(Lifecycle.Create, Lifecycle.Read, Lifecycle.Update)
  @infosecClass("Class 2")
  @pii @spi @cde
  @encrypted("cds-instance.cds_database.customer.organization_notification_email", "AES-GCM")
  @schemaRef("schemas/common/email.json")
  @accessScopes(#["customer:read"], #["customer:profile:write"])
  @ownedBy("customer-360")
  organization_notification_email?: EmailContact;

  @doc("Main office phone number for the organization. NULL for INDIVIDUAL customers.")
  @visibility(Lifecycle.Create, Lifecycle.Read, Lifecycle.Update)
  @infosecClass("Class 3")
  @pii @cde
  @encrypted("cds-instance.cds_database.customer.organization_office_phone", "AES-GCM")
  @schemaRef("schemas/common/phone_number.json")
  @accessScopes(#["customer:read"], #["customer:profile:write"])
  @ownedBy("customer-360")
  organization_office_phone?: PhoneContact;

  @doc("Legal registered address from incorporation documents. Required for regulatory compliance. NULL for INDIVIDUAL customers.")
  @visibility(Lifecycle.Create, Lifecycle.Read, Lifecycle.Update)
  @infosecClass("Class 2")
  @pii
  @schemaRef("schemas/common/address.json")
  @accessScopes(#["customer:read"], #["customer:profile:write"])
  @ownedBy("customer-360")
  organization_registered_address?: PostalAddress;

  @doc("Principal place of business/operations. May differ from registered address. NULL for INDIVIDUAL customers.")
  @visibility(Lifecycle.Create, Lifecycle.Read, Lifecycle.Update)
  @infosecClass("Class 2")
  @pii @spi @cde
  @encrypted("cds-instance.cds_database.customer.organization_registered_address", "AES-GCM")
  @schemaRef("schemas/common/address.json")
  @accessScopes(#["customer:read"], #["customer:profile:write"])
  @ownedBy("customer-360")
  organization_principal_office_address?: PostalAddress;
}
