// user-profile.tsp
import "@typespec/http";
import "@typespec/rest";
import "@typespec/openapi3";

using TypeSpec.Http;
using TypeSpec.Rest;

@service({
  title: "Customer Data Service",
  version: "1.0.0",
})
@server("https://cds.example.com/v1", "Customer Data Product API")
namespace UserProfileService;

// ============================================================================
// INTERLEAVED ENTITY - USER ADDRESS
// ============================================================================

@doc("User address information stored as child entity")
@summary("User Address - Child Entity")
@example(#{
  account_number: 12345678,
  address_id: 1,
  address1: "123 Main Street",
  address_city: "San Francisco",
  zip: "94102",
  address_country: "US"
})
model UserAddress {
  @key
  @doc("Reference to parent user profile")
  @summary("Account Number")
  @minValue(1)
  @visibility(Lifecycle.Read)
  account_number: int64;

  @key
  @doc("Address identifier within user's addresses")
  @summary("Address ID")
  @minValue(1)
  @visibility(Lifecycle.Read)
  address_id: int64;

  @doc("Address-specific flags bitfield")
  @summary("Address Flags")
  address_flags: int64 | null;

  @doc("Address status code")
  @summary("Status")
  @example("A")
  status: AddressStatus | null;

  @doc("Primary address line")
  @summary("Address Line 1")
  @minLength(1)
  @maxLength(300)
  @example("123 Main Street")
  address1: string | null;

  @doc("Secondary address line (apartment, suite, etc.)")
  @summary("Address Line 2")
  @maxLength(300)
  @example("Apt 4B")
  address2: string | null;

  @doc("City name")
  @summary("City")
  @minLength(1)
  @maxLength(120)
  @example("San Francisco")
  address_city: string | null;

  @doc("State or province name or code")
  @summary("State")
  @maxLength(120)
  @example("CA")
  address_state: string | null;

  @doc("Postal or ZIP code")
  @summary("ZIP Code")
  @minLength(5)
  @maxLength(10)
  @pattern("^[0-9]{5}(-[0-9]{4})?$", "Must be valid US ZIP code")
  @example("94102")
  zip: string | null;

  @doc("Country code (ISO 3166-1 alpha-2)")
  @summary("Country")
  @minLength(2)
  @maxLength(2)
  @pattern("^[A-Z]{2}$", "Must be valid ISO 3166 country code")
  @example("US")
  address_country: string | null;

  @doc("Address creation timestamp")
  @summary("Created At")
  @visibility(Lifecycle.Read)
  address_time_created: utcDateTime | null;

  @doc("Name on address (addressee)")
  @summary("Addressee Name")
  @maxLength(128)
  @example("John Doe")
  addressee_name: string | null;

  @doc("Mail delivery error count")
  @summary("Mail Errors")
  @minValue(0)
  mail_error_count: int64 | null;

  @doc("Address type classification")
  @summary("Address Type")
  @example("R")
  type: AddressType | null;

  @doc("eBay integration identifier")
  @summary("eBay ID")
  @minValue(0)
  ebay_id: int64 | null;

  @doc("Row last update timestamp")
  @summary("Row Updated")
  @visibility(Lifecycle.Read)
  time_row_updated: utcDateTime | null;

  @doc("Credit check timestamp")
  @summary("Credit Check Date")
  @visibility(Lifecycle.Read)
  time_set_credit_check: utcDateTime | null;

  @doc("Version control field for optimistic locking")
  @summary("Update Version")
  @minValue(0)
  @visibility(Lifecycle.Read)
  update_version: int64 | null;
}

// ============================================================================
// INTERLEAVED ENTITY - NORMALIZED ADDRESS (JSON Storage)
// ============================================================================

@doc("Normalized address information stored as structured JSON")
@summary("Normalized Address - Geocoding Data")
model UserNormalizedAddress {
  @key
  @doc("Reference to parent user profile")
  @summary("Account Number")
  @minValue(1)
  @visibility(Lifecycle.Read)
  account_number: int64;

  @key
  @doc("Reference to parent address")
  @summary("User Address ID")
  @minValue(1)
  @visibility(Lifecycle.Read)
  user_address_id: int64;

  @key
  @doc("Normalized address identifier")
  @summary("Normalized Address ID")
  @minValue(1)
  @visibility(Lifecycle.Read)
  norm_address_id: int64;

  @doc("Complete normalized address data as structured JSON")
  @summary("Normalized Data")
  normalized_data: NormalizedAddressData;
}

@doc("Normalized address data structure (stored as JSON)")
@summary("Address Normalization Details")
model NormalizedAddressData {
  @doc("Number of addresses matching normalization")
  @summary("Match Count")
  @minValue(0)
  @maxValue(100)
  number_of_matches: int32 | null;

  @doc("Whether address is deliverable by postal service")
  @summary("Is Deliverable")
  is_deliverable_address: boolean | null;

  @doc("Address validation confidence score (0-100)")
  @summary("Confidence Score")
  @minValue(0)
  @maxValue(100)
  confidence_score: float64 | null;

  @doc("Normalized address type code")
  @summary("Address Type")
  @maxLength(2)
  address_type: string | null;

  @doc("Normalized street number")
  @summary("Street Number")
  @maxLength(30)
  street_number: string | null;

  @doc("Street directional prefix (N, S, E, W)")
  @summary("Street Prefix")
  @maxLength(50)
  street_prefix: string | null;

  @doc("Street type suffix (St, Ave, Blvd, Rd)")
  @summary("Street Postfix")
  @maxLength(50)
  street_postfix: string | null;

  @doc("Normalized street name")
  @summary("Street Name")
  @maxLength(300)
  street_name: string | null;

  @doc("Apartment or unit number")
  @summary("Apartment Number")
  @maxLength(30)
  apartment_number: string | null;

  @doc("Normalized city name")
  @summary("City")
  @maxLength(120)
  norm_address_city: string | null;

  @doc("County or district name")
  @summary("County")
  @maxLength(60)
  county: string | null;

  @doc("Normalized state or province")
  @summary("State")
  @maxLength(120)
  norm_address_state: string | null;

  @doc("First part of postal code (5-digit ZIP)")
  @summary("Postal Code First")
  @maxLength(60)
  postal_code_first: string | null;

  @doc("Extension part of postal code (ZIP+4)")
  @summary("Postal Code Last")
  @maxLength(60)
  postal_code_last: string | null;

  @doc("Normalized country code (ISO 3166-1 alpha-2)")
  @summary("Country")
  @minLength(2)
  @maxLength(2)
  @pattern("^[A-Z]{2}$", "Must be valid ISO 3166 country code")
  norm_address_country: string | null;

  @doc("Address hash for deduplication (SHA-256)")
  @summary("Address Hash")
  @maxLength(1024)
  address_hash: string | null;

  @doc("Normalization error code")
  @summary("Error Code")
  @maxLength(20)
  error_code: string | null;

  @doc("Normalization error description")
  @summary("Error Description")
  @maxLength(256)
  error_description: string | null;

  @doc("Normalization processing timestamp")
  @summary("Normalized At")
  norm_address_time_created: utcDateTime | null;

  @doc("Last normalization update timestamp")
  @summary("Last Normalized Update")
  norm_address_pypl_time_touched: utcDateTime | null;

  @doc("Unit type description (apt, suite, floor)")
  @summary("Unit Description")
  @maxLength(30)
  unit_description: string | null;

  @doc("Normalization process status")
  @summary("Normalization Status")
  @maxLength(20)
  normalization_status: string | null;

  @doc("Geographic latitude coordinate (-90 to 90)")
  @summary("Latitude")
  @minValue(-90)
  @maxValue(90)
  @example(37.7749)
  latitude: float64 | null;

  @doc("Geographic longitude coordinate (-180 to 180)")
  @summary("Longitude")
  @minValue(-180)
  @maxValue(180)
  @example(-122.4194)
  longitude: float64 | null;

  @doc("Building type indicator")
  @summary("Building Type")
  @maxLength(1)
  building_type: string | null;

  @doc("64-bit address hash for quick lookup")
  @summary("Address Hash 64")
  @maxLength(20)
  address_hash_64: string | null;

  @doc("API caller context information")
  @summary("Caller Context")
  @maxLength(50)
  caller_context: string | null;

  @doc("Match confidence level identifier")
  @summary("Match Level Type")
  @minValue(0)
  match_level_type_id: int32 | null;

  @doc("Block-level geographic description")
  @summary("Block Description")
  @maxLength(18)
  block_description: string | null;

  @doc("Block number identifier")
  @summary("Block Number")
  @maxLength(10)
  block_number: string | null;

  @doc("Input language code (ISO 639)")
  @summary("Input Language")
  @maxLength(5)
  input_language: string | null;

  @doc("Street hash value for deduplication")
  @summary("Street Hash")
  @maxLength(20)
  street_hash: string | null;

  @doc("PO Box number if applicable")
  @summary("PO Box")
  @maxLength(20)
  postal_box_number: string | null;

  @doc("Whether address is residential (vs commercial)")
  @summary("Is Residential")
  is_residential: boolean | null;

  @doc("Business name at this address")
  @summary("Business Name")
  @maxLength(80)
  business_name: string | null;

  @doc("Formatted display address (full address string)")
  @summary("Display Address")
  @maxLength(365)
  display_address: string | null;
}
