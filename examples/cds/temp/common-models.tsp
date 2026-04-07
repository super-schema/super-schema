// ================================================================================================
// COMMON MODELS — Shared types for JSON column schemas
// ================================================================================================
//
// These models represent the structure of JSON columns referenced by schema_ref
// in the DDL metadata. They provide type-safe definitions for complex nested
// structures stored as JSON in Spanner.
// ================================================================================================

namespace PayPal.CustomerDataStore;

using PayPal.CustomerDataStore.Decorators;

// ── Scalars ──────────────────────────────────────────────────────────────────

@doc("UUID v4 string identifier")
@format("uuid")
@maxLength(36)
scalar uuid extends string;

@doc("ISO 3166-1 alpha-2 country code")
@pattern("^[A-Z]{2}$")
@maxLength(2)
scalar CountryCode extends string;

@doc("Email address in RFC 5321 format")
@format("email")
@maxLength(254)
scalar EmailAddress extends string;

@doc("Phone number in E.164 international format")
@pattern("^\\+[1-9]\\d{1,14}$")
@maxLength(35)
scalar E164PhoneNumber extends string;

@doc("4-digit Merchant Category Code")
@pattern("^[0-9]{4}$")
@maxLength(4)
scalar MerchantCategoryCodeValue extends string;

@doc("URL with maximum 2048 characters")
@format("uri")
@maxLength(2048)
scalar UrlString extends string;

// ── Locale ───────────────────────────────────────────────────────────────────

@doc("Customer locale preferences. Replaces separate locale table per Spanner best practice for co-queried data.")
@schemaRef("schemas/customer/locale.json")
model Locale {
  @doc("Language preference in ISO 639-1 with country format (e.g., en_US, fr_CA)")
  language?: string;

  @doc("Country preference in ISO 3166-1 format, typically matches legal_country")
  country?: CountryCode;

  @doc("IANA timezone identifier (e.g., America/Los_Angeles)")
  timezone?: string;
}

// ── Legal Name ───────────────────────────────────────────────────────────────

@doc("Legal name as it appears on official documents (passport, government ID). Includes confirmation metadata.")
@schemaRef("schemas/common/legal_name.json")
model LegalName {
  @doc("Given/first name") given_name: string;
  @doc("Family/last name") surname: string;
  prefix?: string;
  middle_name?: string;
  suffix?: string;
  full_name?: string;
  confirmation_status?: string;
  confirmation_authority?: string;
}

// ── Birth Details ────────────────────────────────────────────────────────────

@doc("Birth information including date and place. Used for identity verification and age verification.")
@schemaRef("schemas/customer/birth_details.json")
model BirthDetails {
  @doc("Date of birth") date_of_birth?: plainDate;
  @doc("Place of birth") place_of_birth?: string;
}

// ── Contact Models ───────────────────────────────────────────────────────────

@doc("Email contact information with verification metadata")
@schemaRef("schemas/common/email.json")
model EmailContact {
  email_address: EmailAddress;
  verification_status?: string;
  verified_at?: utcDateTime;
}

@doc("Phone contact information with verification metadata")
@schemaRef("schemas/common/phone.json")
model PhoneContact {
  e164_phone_number: E164PhoneNumber;
  extension_number?: string;
  phone_type?: PhoneType;
  verification_status?: string;
  verified_at?: utcDateTime;
}

@doc("Portable international postal address following PayPal Portable Postal Address (Medium-Grained) specification.")
@schemaRef("schemas/common/address.json")
model PostalAddress {
  @doc("Primary street address line") address_line_1: string;
  @doc("Secondary address line (apt, suite, unit)") address_line_2?: string;
  @doc("Tertiary address line") address_line_3?: string;
  @doc("First-level administrative subdivision (state, province, region)") admin_area_1?: string;
  @doc("Second-level administrative subdivision (city, town)") admin_area_2?: string;
  @doc("Third-level administrative subdivision") admin_area_3?: string;
  @doc("Fourth-level administrative subdivision") admin_area_4?: string;
  postal_code?: string;
  @doc("ISO 3166-1 alpha-2 country code") country_code: CountryCode;

  @doc("Fine-grain address components")
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

// ── Quality Metadata ─────────────────────────────────────────────────────────

@doc("Email quality and verification metadata")
@schemaRef("schemas/common/email_quality_metadata.json")
model EmailQualityMetadata {
  confirmation_status: string;
  confirmation_authority: string;
  time_confirmed?: utcDateTime;
}

@doc("Phone verification metadata")
@schemaRef("schemas/common/phone_quality_metadata.json")
model PhoneQualityMetadata {
  confirmation_status: string;
  confirmation_authority: string;
  time_confirmed?: utcDateTime;
}

@doc("Address quality and verification metadata")
@schemaRef("schemas/common/address_quality_metadata.json")
model AddressQualityMetadata {
  confirmation_status: string;
  confirmation_authority: string;
  validation_status: string;
  validation_authority: string;
  normalization_status: string;
  time_confirmed?: utcDateTime;
  time_validated?: utcDateTime;
  time_normalized?: utcDateTime;
}

// ── Organization Models ──────────────────────────────────────────────────────

@doc("Organization type and subtype classification")
@schemaRef("schemas/customer/organization_type.json")
model OrganizationType {
  @doc("Primary type (corporation, partnership, sole_proprietorship, nonprofit)")
  type: string;

  subtype?: string;
}

@doc("Incorporation details including date, country, and registration number")
@schemaRef("schemas/customer/organization_incorporation.json")
model IncorporationDetails {
  incorporation_date?: plainDate;

  @doc("Country of incorporation in ISO 3166-1 alpha-2")
  incorporation_country?: CountryCode;

  registration_number?: string;
}

@doc("Stakeholder name consistent with legal name pattern")
@schemaRef("schemas/StakeholderName.v1.json")
model StakeholderName {
  given_name: string;
  surname: string;
  middle_name?: string;
  suffix?: string;
}

// ── Tax ──────────────────────────────────────────────────────────────────────

@doc("Tax identification details. MUST be encrypted at application layer.")
@schemaRef("schemas/account/tax_info.json")
model TaxDetails {
  @doc("Tax identification number — MUST be encrypted at application layer, PII Class 2")
  @secret
  tax_id: string;

  @doc("Tax ID type (EIN, VAT, GST, etc)")
  tax_id_type: string;

  @doc("Issuing country in ISO 3166-1 alpha-2")
  issuing_country: CountryCode;

  verification_status?: string;
  verified_at?: utcDateTime;
  verification_authority?: string;
  tax_address?: PostalAddress;
}

// ── Merchant Models ──────────────────────────────────────────────────────────

@doc("Merchant Category Code with category and description")
@schemaRef("schemas/account/merchant_category_code.json")
model MerchantCategoryCode {
  @doc("4-digit MCC code") code: MerchantCategoryCodeValue;
  category?: string;
  description?: string;
}

@doc("Statement descriptor displayed on customer bank/card statements")
@schemaRef("schemas/account/statement_descriptor.json")
model StatementDescriptor {
  name: string;
  phone?: string;
}

@doc("Merchant customer service contact information")
@schemaRef("schemas/account/customer_service_contact.json")
model CustomerServiceContact {
  email?: EmailAddress;
  phone?: E164PhoneNumber;
  url?: UrlString;
}

// ── Address Tags ─────────────────────────────────────────────────────────────

@doc("Additional address metadata tags")
model AddressTags {
  likely_po_box?: boolean;
}
