import "@typespec/http";
import "@typespec/rest";
import "@typespec/openapi";

using TypeSpec.Http;
using TypeSpec.Rest;
using TypeSpec.OpenAPI;

@service({ title: "Customer Data Store API" })
@doc("Customer Data Store - Centralized federated customer data management solution with focus on data minimization, tenant isolation, and access policy enforcement.")
@server("https://api.paypal.com", "Production")
namespace PayPal.CustomerDataStore;

// ═══════════════════════════════════════════════════════════════════════════════
// SCALARS
// ═══════════════════════════════════════════════════════════════════════════════

@format("uuid")
@maxLength(36)
scalar uuid extends string;

@doc("ISO 3166-1 alpha-2 country code")
@pattern("^[A-Z]{2}$")
@maxLength(2)
scalar CountryCode extends string;

@format("email")
@maxLength(254)
scalar EmailAddress extends string;

@pattern("^\\+[1-9]\\d{1,14}$")
@maxLength(35)
scalar E164PhoneNumber extends string;

// ═══════════════════════════════════════════════════════════════════════════════
// ENUMS
// ═══════════════════════════════════════════════════════════════════════════════

@doc("Brand namespace for customer. Normalized to UPPERCASE.")
enum Brand {
  PAYPAL,
  VENMO,
  FASTLANE,
  BRAINTREE,
}

@doc("Customer type — determines which profile columns are populated (person_* vs organization_*).")
enum CustomerType {
  INDIVIDUAL,
  ORGANIZATION,
}

@doc("Customer relationship lifecycle status.")
enum CustomerStatus {
  ACTIVE,
  CLOSED,
}

@doc("PayPal legal entity.")
enum LegalEntity {
  INC,
  EUROPE,
  SINGAPORE,
  AUSTRALIA,
}

@doc("Person gender self-identification.")
enum Gender {
  MALE,
  FEMALE,
  PREFER_NOT_TO_SAY,
}

// ═══════════════════════════════════════════════════════════════════════════════
// SHARED MODELS — JSON column structures
// ═══════════════════════════════════════════════════════════════════════════════

// schema_ref: schemas/customer/locale.json
model Locale {
  language?: string;
  country?: CountryCode;
  timezone?: string;
}

// schema_ref: schemas/common/legal_name.json
model LegalName {
  given_name: string;
  surname: string;
  prefix?: string;
  middle_name?: string;
  suffix?: string;
  full_name?: string;
  confirmation_status?: string;
  confirmation_authority?: string;
}

// schema_ref: schemas/customer/birth_details.json
model BirthDetails {
  date_of_birth?: plainDate;
  place_of_birth?: string;
}

// schema_ref: schemas/common/email.json
model EmailContact {
  email_address: EmailAddress;
  verification_status?: string;
  verified_at?: utcDateTime;
}

// schema_ref: schemas/common/phone.json
model PhoneContact {
  e164_phone_number: E164PhoneNumber;
  extension_number?: string;
  phone_type?: string;
  verification_status?: string;
  verified_at?: utcDateTime;
}

// schema_ref: schemas/common/address.json
model PostalAddress {
  address_line_1: string;
  address_line_2?: string;
  address_line_3?: string;
  admin_area_1?: string;
  admin_area_2?: string;
  admin_area_3?: string;
  admin_area_4?: string;
  postal_code?: string;
  country_code: CountryCode;
  address_details?: AddressDetails;
}

model AddressDetails {
  street_number?: string;
  street_name?: string;
  street_type?: string;
  delivery_service?: string;
  building_name?: string;
  sub_building?: string;
}

// schema_ref: schemas/account/tax_info.json
model TaxDetails {
  @secret tax_id: string;
  tax_id_type: string;
  issuing_country: CountryCode;
  verification_status?: string;
  verified_at?: utcDateTime;
  verification_authority?: string;
  tax_address?: PostalAddress;
}

// schema_ref: schemas/customer/organization_type.json
model OrganizationType {
  type: string;
  subtype?: string;
}

// schema_ref: schemas/customer/organization_incorporation.json
model IncorporationDetails {
  incorporation_date?: plainDate;
  incorporation_country?: CountryCode;
  registration_number?: string;
}

// ═══════════════════════════════════════════════════════════════════════════════
// CUSTOMER — Root entity
// ═══════════════════════════════════════════════════════════════════════════════
//
// Spanner table: customer
// Primary key: (customer_id)
// Table category: TRANSACTIONAL
// Avg row size: 2800 bytes
//
// Accountability:
//   ticket: DTCDS-113
//   owning_dl: dt-cp-identity-cds@paypal.com
//   agile_team: DT-CP-Identity-CDS
//
// Data residency: geo-partitioned (US, EU, APAC)
// Source system: TBD | Ingestion: API
//
// API resource:
//   base_path: /v1/enterprise-data/customers
//   operations: create, read, update, delete
//   default_page_size: 50
//
// Fieldsets:
//   profile_summary: customer_id, party_id, brand, customer_type, status,
//     legal_entity, legal_country, person_legal_name, person_primary_email,
//     person_primary_mobile_phone, organization_legal_name, organization_trading_name
//   contact_info: customer_id, brand, person_primary_email,
//     person_primary_mobile_phone, person_primary_home_phone,
//     person_primary_residential_address (+ interleaved email/phone/address tables)
//
// Indexes:
//   idx_customer_party_id UNIQUE ON (party_id) — legacy backward compat lookup
//
// ═══════════════════════════════════════════════════════════════════════════════

@doc("Customer entity representing individuals and organizations with federated data ownership. Supports data minimization via selective attribute retrieval. Collapsed person_profile and business_profile into single table per Spanner best practices — ~50% NULL columns depending on customer_type.")
model Customer {

  // ── Primary Key ──────────────────────────────────────────────────────────

  @doc("Unique UUID identifier for customer. Not the legacy party_id but a modern UUID-based identifier for clean data architecture.")
  @key
  @visibility(Lifecycle.Read)
  // infosec: Class 4 | pii: false | read scopes: [customer:read]
  customer_id: uuid;

  // ── Business Identifiers ─────────────────────────────────────────────────

  @doc("Legacy party_id from party management v2 system for backward compatibility lookups. Indexed for migration path support. Will eventually be deprecated in favor of customer_id.")
  @visibility(Lifecycle.Read)
  @maxLength(20)
  // infosec: Class 3 | pii: true | spi: true | cde: true
  // read scopes: [customer:read]
  party_id?: string;

  // ── Core Identity ────────────────────────────────────────────────────────

  @doc("Brand namespace for customer. Normalized to UPPERCASE. Provides brand-based partitioning without hard tenant isolation.")
  @visibility(Lifecycle.Create, Lifecycle.Read)
  // infosec: Class 4
  // read scopes: [customer:read] | write scopes: [customer:lifecycle:write] | owned_by: customer-360
  brand: Brand;

  @doc("Customer type distinguishing individual consumers from business organizations. Determines which profile columns are populated (person_* vs organization_*).")
  @visibility(Lifecycle.Create, Lifecycle.Read)
  // infosec: Class 4
  // read scopes: [customer:read] | write scopes: [customer:lifecycle:write] | owned_by: customer-360
  customer_type: CustomerType;

  @doc("Customer relationship lifecycle status. ACTIVE for ongoing relationships, CLOSED when all accounts terminated.")
  @visibility(Lifecycle.Create, Lifecycle.Read, Lifecycle.Update)
  // infosec: Class 4
  // read scopes: [customer:read] | write scopes: [customer:lifecycle:write] | owned_by: customer-360
  status: CustomerStatus;

  @doc("PayPal legal entity for this customer relationship. Determines contractual terms and regulatory jurisdiction.")
  @visibility(Lifecycle.Create, Lifecycle.Read)
  // infosec: Class 4
  // read scopes: [customer:read] | write scopes: [customer:lifecycle:write] | owned_by: customer-360
  legal_entity?: LegalEntity;

  @doc("Customer legal country of residence in ISO 3166-1 alpha-2 format. Critical for compliance, tax jurisdiction, and future geo-partitioning.")
  @visibility(Lifecycle.Create, Lifecycle.Read, Lifecycle.Update)
  // infosec: Class 3 | pii: true | spi: true | cde: true
  // dq_rules: [non_empty, iso_3166_1_alpha2]
  // read scopes: [customer:read] | write scopes: [customer:pii:write] | owned_by: customer-360
  legal_country: CountryCode;

  @doc("Geographic placement region for data locality and multi-region optimization. Populated by application logic based on legal_country. Used as Spanner placement key for geo-partitioning (US, EU, APAC regions).")
  // infosec: Class 4
  // spanner: PLACEMENT KEY
  placement_region: string;

  // ── Timestamps ───────────────────────────────────────────────────────────

  @doc("Customer record creation timestamp. Immutable after insert. Used for RIG retention policy enforcement and audit trails.")
  @visibility(Lifecycle.Read)
  // infosec: Class 5 | spanner: allow_commit_timestamp=true
  // read scopes: [customer:read]
  time_created: utcDateTime;

  @doc("Timestamp when customer activated their first account. NULL until first account activation.")
  @visibility(Lifecycle.Read, Lifecycle.Update)
  // infosec: Class 5
  // read scopes: [customer:read] | write scopes: [customer:lifecycle:write] | owned_by: customer-360
  time_activated?: utcDateTime;

  @doc("Timestamp when customer relationship ended. NULL for active customers.")
  @visibility(Lifecycle.Read, Lifecycle.Update)
  // infosec: Class 5
  // read scopes: [customer:read] | write scopes: [customer:lifecycle:write] | owned_by: customer-360
  time_closed?: utcDateTime;

  // ── Locale ───────────────────────────────────────────────────────────────

  @doc("Customer locale preferences (language, country, timezone). Replaces separate locale table per Spanner best practice for co-queried data.")
  @visibility(Lifecycle.Create, Lifecycle.Read, Lifecycle.Update)
  // infosec: Class 4
  // read scopes: [customer:read] | write scopes: [customer:profile:write] | owned_by: customer-360
  locale?: Locale;

  // ── Person Profile (NULL for ORGANIZATION) ───────────────────────────────

  @doc("Array of ISO 3166-1 alpha-2 country codes representing person citizenship. Supports multiple citizenship. NULL for ORGANIZATION type.")
  @visibility(Lifecycle.Create, Lifecycle.Read, Lifecycle.Update)
  // infosec: Class 3 | pii: true | spi: true | cde: true
  // encrypted: AES-GCM (key: cds-instance.cds_database.customer.person_citizenship)
  // dq_rules: [iso_3166_1_alpha2_array]
  // read scopes: [customer:pii:read] | write scopes: [customer:pii:write] | owned_by: customer-360
  person_citizenship?: CountryCode[];

  @doc("Person gender self-identification. NULL for ORGANIZATION type. Optional field respecting customer privacy preferences.")
  @visibility(Lifecycle.Create, Lifecycle.Read, Lifecycle.Update)
  // infosec: Class 3 | pii: true | spi: true | cde: true
  // encrypted: AES-GCM (key: cds-instance.cds_database.customer.person_gender)
  // read scopes: [customer:pii:read] | write scopes: [customer:pii:write] | owned_by: customer-360
  person_gender?: Gender;

  @doc("Legal name as it appears on official documents (passport, government ID). Includes confirmation metadata.")
  @visibility(Lifecycle.Create, Lifecycle.Read, Lifecycle.Update)
  // infosec: Class 2 | pii: true | spi: true | cde: true
  // encrypted: AES-GCM (key: cds-instance.cds_database.customer.person_legal_name)
  // read scopes: [customer:pii:read] | write scopes: [customer:pii:write] | owned_by: customer-360
  person_legal_name?: LegalName;

  @doc("Birth information including date and place. Used for identity verification and age verification. Highly sensitive PII requiring strict access controls.")
  @visibility(Lifecycle.Create, Lifecycle.Read, Lifecycle.Update)
  // infosec: Class 3 | pii: true | spi: true | cde: true
  // encrypted: AES-GCM (key: cds-instance.cds_database.customer.person_birth_details)
  // read scopes: [customer:pii:read] | write scopes: [customer:pii:write] | owned_by: customer-360
  person_birth_details?: BirthDetails;

  // ── Person Primary Contacts (Denormalized for fast reads) ────────────────
  // HYBRID DENORMALIZATION: Primary contacts kept here for 95% fast reads.
  // ALL contacts also stored in interleaved tables (customer_email, customer_phone,
  // customer_address) for domain extensibility. Write to both locations.

  @doc("Primary email address. Denormalized from customer_email table for 95% fast read optimization. NULL for ORGANIZATION customers.")
  @visibility(Lifecycle.Create, Lifecycle.Read, Lifecycle.Update)
  // infosec: Class 2 | pii: true | spi: true | cde: true
  // encrypted: AES-GCM (key: cds-instance.cds_database.customer.person_primary_email)
  // read scopes: [customer:pii:read] | write scopes: [customer:pii:write] | owned_by: customer-360
  person_primary_email?: EmailContact;

  @doc("Primary mobile phone number. Used for SMS 2FA and notifications. Denormalized from customer_phone table. NULL for ORGANIZATION customers.")
  @visibility(Lifecycle.Create, Lifecycle.Read, Lifecycle.Update)
  // infosec: Class 2 | pii: true | spi: true | cde: true
  // encrypted: AES-GCM (key: cds-instance.cds_database.customer.person_primary_mobile_phone)
  // read scopes: [customer:pii:read] | write scopes: [customer:pii:write] | owned_by: customer-360
  person_primary_mobile_phone?: PhoneContact;

  @doc("Primary home phone number. Denormalized from customer_phone table. NULL for ORGANIZATION customers.")
  @visibility(Lifecycle.Create, Lifecycle.Read, Lifecycle.Update)
  // infosec: Class 2 | pii: true | spi: true | cde: true
  // encrypted: AES-GCM (key: cds-instance.cds_database.customer.person_primary_home_phone)
  // read scopes: [customer:pii:read] | write scopes: [customer:pii:write] | owned_by: customer-360
  person_primary_home_phone?: PhoneContact;

  @doc("Primary residence address. Denormalized from customer_address table for 95% read optimization. NULL for ORGANIZATION customers.")
  @visibility(Lifecycle.Create, Lifecycle.Read, Lifecycle.Update)
  // infosec: Class 2 | pii: true | spi: true | cde: true
  // encrypted: AES-GCM (key: cds-instance.cds_database.customer.person_primary_residential_address)
  // read scopes: [customer:pii:read] | write scopes: [customer:pii:write] | owned_by: customer-360
  person_primary_residential_address?: PostalAddress;

  // ── Organization Profile (NULL for INDIVIDUAL) ───────────────────────────

  @doc("Official registered legal name of organization as filed with government authorities. NULL for INDIVIDUAL customers.")
  @visibility(Lifecycle.Create, Lifecycle.Read, Lifecycle.Update)
  @maxLength(256)
  // infosec: Class 2 | pii: true | spi: true | cde: true
  // encrypted: AES-GCM (key: cds-instance.cds_database.customer.organization_legal_name)
  // read scopes: [customer:read] | write scopes: [customer:profile:write] | owned_by: customer-360
  organization_legal_name?: string;

  @doc("Doing Business As (DBA) or trading name. May differ from legal name. NULL for INDIVIDUAL customers.")
  @visibility(Lifecycle.Create, Lifecycle.Read, Lifecycle.Update)
  @maxLength(256)
  // infosec: Class 2 | pii: true | spi: true | cde: true
  // encrypted: AES-GCM (key: cds-instance.cds_database.customer.organization_trading_name)
  // read scopes: [customer:read] | write scopes: [customer:profile:write] | owned_by: customer-360
  organization_trading_name?: string;

  @doc("Tax identification information for the organization. Critical for tax compliance and regulatory reporting.")
  @visibility(Lifecycle.Create, Lifecycle.Read, Lifecycle.Update)
  // infosec: Class 2 | pii: true | pci: true | spi: true | cde: true
  // encrypted: AES-GCM (key: cds-instance.cds_database.customer.organization_tax_details)
  // read scopes: [customer:tax:read] | write scopes: [customer:tax:write] | owned_by: tax
  organization_tax_details?: TaxDetails;

  @doc("Organization type and subtype classification (corporation, partnership, sole proprietorship, nonprofit). NULL for INDIVIDUAL customers.")
  @visibility(Lifecycle.Create, Lifecycle.Read, Lifecycle.Update)
  // infosec: Class 4
  // read scopes: [customer:read] | write scopes: [customer:profile:write] | owned_by: customer-360
  organization_type?: OrganizationType;

  @doc("Incorporation details including date, country, and registration number. NULL for INDIVIDUAL customers.")
  @visibility(Lifecycle.Create, Lifecycle.Read, Lifecycle.Update)
  // infosec: Class 3 | pii: true | spi: true | cde: true
  // encrypted: AES-GCM (key: cds-instance.cds_database.customer.organization_incorporation)
  // read scopes: [customer:read] | write scopes: [customer:profile:write] | owned_by: customer-360
  organization_incorporation?: IncorporationDetails;

  @doc("Primary contact email for PayPal to reach the organization. NULL for INDIVIDUAL customers.")
  @visibility(Lifecycle.Create, Lifecycle.Read, Lifecycle.Update)
  // infosec: Class 2 | pii: true | spi: true | cde: true
  // encrypted: AES-GCM (key: cds-instance.cds_database.customer.organization_notification_email)
  // read scopes: [customer:read] | write scopes: [customer:profile:write] | owned_by: customer-360
  organization_notification_email?: EmailContact;

  @doc("Main office phone number for the organization. NULL for INDIVIDUAL customers.")
  @visibility(Lifecycle.Create, Lifecycle.Read, Lifecycle.Update)
  // infosec: Class 3 | pii: true | cde: true
  // encrypted: AES-GCM (key: cds-instance.cds_database.customer.organization_office_phone)
  // read scopes: [customer:read] | write scopes: [customer:profile:write] | owned_by: customer-360
  organization_office_phone?: PhoneContact;

  @doc("Legal registered address from incorporation documents. NULL for INDIVIDUAL customers.")
  @visibility(Lifecycle.Create, Lifecycle.Read, Lifecycle.Update)
  // infosec: Class 2 | pii: true
  // read scopes: [customer:read] | write scopes: [customer:profile:write] | owned_by: customer-360
  organization_registered_address?: PostalAddress;

  @doc("Principal place of business/operations. May differ from registered address. NULL for INDIVIDUAL customers.")
  @visibility(Lifecycle.Create, Lifecycle.Read, Lifecycle.Update)
  // infosec: Class 2 | pii: true | spi: true | cde: true
  // encrypted: AES-GCM (key: cds-instance.cds_database.customer.organization_registered_address)
  // read scopes: [customer:read] | write scopes: [customer:profile:write] | owned_by: customer-360
  organization_principal_office_address?: PostalAddress;
}
