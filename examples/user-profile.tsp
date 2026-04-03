// user-profile-unified.tsp
// ═══════════════════════════════════════════════════════════════════════════
// SINGLE SOURCE OF TRUTH — Emits to Protobuf, OpenAPI 3, and JSON Schema
// ═══════════════════════════════════════════════════════════════════════════
//
// Compatibility rules applied:
//  `?` (optional) instead of `| null` — proto3 compatible
//  `int64` → google.protobuf.Timestamp (proto) / string date-time (OpenAPI)
//  `int64` for currency (cents) — no `decimal` (proto incompatible)
//  `int32` for scores (×100) — no `decimal` (proto incompatible)
//  `@field(n)` ignored by OpenAPI/JSON Schema emitters — safe to include
//  `@pattern`, `@minLength`, `@secret` etc. ignored by Protobuf — safe
//  `@key`, `@visibility`, `@format` ignored by Protobuf — safe
//  `@message` ignored by OpenAPI emitter — safe
//  `@jsonSchema` ignored by Protobuf emitter — safe
//
// for utcDateTime to int64 mapping for proto :  https://github.com/microsoft/typespec/pull/7089

// Compile:
//   tsp compile user-profile.tsp --emit=@typespec/json-schema --option "@typespec/json-schema.file-type=json"
//                                --emit=@typespec/openapi3
//                                --emit=@typespec/protobuf
//
import "@typespec/http";
import "@typespec/rest";
import "@typespec/openapi3";
import "@typespec/protobuf";
import "@typespec/json-schema";


using TypeSpec.Http;
using TypeSpec.Rest;
using TypeSpec.Protobuf;
using TypeSpec.JsonSchema;

@TypeSpec.service(#{ title: "Customer Data Service" })
@server("https://cds.example.com/v1", "Customer Data Product API")
@package({ name: "userprofile.v1" })
namespace UserProfileService;

// ═══════════════════════════════════════════════════════════════════════════
// ENUMERATIONS (Protobuf-compatible numeric values)
// ═══════════════════════════════════════════════════════════════════════════

@doc("Address type classification")
enum AddressType {
  ADDRESS_TYPE_UNSPECIFIED : "unspecified",
  ADDRESS_TYPE_RESIDENTIAL : "residential",
  ADDRESS_TYPE_BUSINESS: "business",
  ADDRESS_TYPE_OTHER : "other",
}

@doc("Address status codes")
enum AddressStatus {
  ADDRESS_STATUS_UNSPECIFIED : "unspecified",
  ADDRESS_STATUS_ACTIVE : "active",
  ADDRESS_STATUS_INACTIVE : "inactive",
  ADDRESS_STATUS_PENDING : "pending",
}

@doc("AFS classification types")
enum AfsClassificationType {
  AFS_TYPE_UNSPECIFIED: 0,
  AFS_TYPE_A: 1,
  AFS_TYPE_B: 2,
  AFS_TYPE_C: 3,
}

// ═══════════════════════════════════════════════════════════════════════════
// MAIN ENTITY — USER PROFILE
// ═══════════════════════════════════════════════════════════════════════════

@message
@jsonSchema
@doc("Complete user profile entity combining user, address, and risk information")
@summary("User Profile - Atomic Business Entity")
model UserProfile {
  // ═══════════════════════════════════════════════════════════════════════
  // PRIMARY KEY
  // ═══════════════════════════════════════════════════════════════════════

  @key
  @field(1)
  @doc("Primary key - unique user identifier")
  @summary("Account Number")
  @minValue(1)
  @example(12345678)
  @visibility(Lifecycle.Read)
  account_number: int64;

  // ═══════════════════════════════════════════════════════════════════════
  // CORE USER INFORMATION (WUSER - 49 columns)
  // ═══════════════════════════════════════════════════════════════════════

  @field(2)
  @doc("Account creation timestamp")
  @summary("Created At")
  @visibility(Lifecycle.Read)
  @extension("x-format", "unix-timestamp")
  user_time_created?: int64;

  @field(3)
  @doc("User's first name")
  @summary("First Name")
  @minLength(1)
  @maxLength(64)
  @pattern("^[a-zA-Z\\s'-]+$", "Letters, spaces, hyphens, apostrophes only")
  @example("John")
  first_name?: string;

  @field(4)
  @doc("User's last name")
  @summary("Last Name")
  @minLength(1)
  @maxLength(64)
  @pattern("^[a-zA-Z\\s'-]+$", "Letters, spaces, hyphens, apostrophes only")
  @example("Doe")
  last_name?: string;

  @field(5)
  @doc("System flags bitfield - deprecated, use decomposed flags instead")
  @summary("User Flags (Legacy)")
  @visibility(Lifecycle.Read)
  user_flags?: int64;

  @field(6)
  @doc("Last web login time")
  @summary("Last Web Access")
  @visibility(Lifecycle.Read)
  @extension("x-format", "unix-timestamp")
  user_last_web_access?: int64;

  @field(7)
  @doc("Daytime phone number in E.164 format")
  @summary("Day Phone")
  @maxLength(40)
  @pattern("^\\+?[1-9]\\d{1,14}$", "Must be valid E.164 phone number")
  @example("+14155552671")
  day_phone?: string;

  @field(8)
  @doc("Evening phone number in E.164 format")
  @summary("Night Phone")
  @maxLength(40)
  @pattern("^\\+?[1-9]\\d{1,14}$", "Must be valid E.164 phone number")
  @example("+14155552672")
  night_phone?: string;

  @field(9)
  @doc("Reference to primary address")
  @summary("Primary Address ID")
  @minValue(0)
  address_id?: int64;

  @field(10)
  @doc("Billing cycle number (day of month)")
  @summary("Billing Cycle")
  @minValue(1)
  @maxValue(31)
  @example(15)
  cycle_number?: int64;

  @field(11)
  @doc("Active transaction ID")
  @summary("Current Transaction")
  @minValue(0)
  @visibility(Lifecycle.Read)
  server_current_transaction?: int64;

  @field(12)
  @doc("Credit charges amount in cents (USD). Divide by 100 for dollar value.")
  @summary("Credit Charged (cents)")
  @minValue(0)
  @example(12550)
  credit_charged_cents?: int64;

  @field(13)
  @doc("Last cycle update time")
  @summary("Cycle Updated")
  @extension("x-format", "unix-timestamp")
  @visibility(Lifecycle.Read)
  cycle_last_updated?: int64;

  @field(14)
  @doc("Confirmation error count")
  @summary("Confirmation Errors")
  @minValue(0)
  @maxValue(1000)
  @example(0)
  confirm_error_count?: int64;

  @field(15)
  @doc("Transaction limit amount in cents (USD). Divide by 100 for dollar value.")
  @summary("Transaction Limit (cents)")
  @minValue(0)
  @example(500000)
  transaction_limit_cents?: int64;

  @field(16)
  @doc("Default credit card ID reference")
  @summary("Default Credit Card")
  @minValue(0)
  @secret
  default_cc?: int64;

  @field(17)
  @doc("Default ACH account ID reference")
  @summary("Default ACH")
  @minValue(0)
  @secret
  default_ach?: int64;

  @field(18)
  @doc("User group classification identifier (1-999)")
  @summary("User Group")
  @minValue(1)
  @maxValue(999)
  @example(100)
  user_group?: int64;

  @field(19)
  @doc("Primary email ID reference")
  @summary("Email ID")
  @minValue(0)
  primary_email?: int64;

  @field(20)
  @doc("Lifetime sent amount in cents (USD). Divide by 100 for dollar value.")
  @summary("Total Sent (cents)")
  @minValue(0)
  @example(1543275)
  @visibility(Lifecycle.Read)
  total_amount_sent_cents?: int64;

  @field(21)
  @doc("Total authentication attempts count")
  @summary("Auth Count")
  @minValue(0)
  @visibility(Lifecycle.Read)
  authentications?: int64;

  @field(22)
  @doc("Receiving preferences bitfield")
  @summary("Receiving Preferences")
  receiving_prefs?: int64;

  @field(23)
  @doc("Credit card receipts amount in cents (USD). Divide by 100 for dollar value.")
  @summary("CC Received (cents)")
  @minValue(0)
  @visibility(Lifecycle.Read)
  cc_amount_received_cents?: int64;

  @field(24)
  @doc("Last login IP address (IPv4 or IPv6)")
  @summary("Last Login IP")
  @maxLength(45)
  @pattern("^(?:(?:25[0-5]|2[0-4][0-9]|[01]?[0-9][0-9]?)\\.){3}(?:25[0-5]|2[0-4][0-9]|[01]?[0-9][0-9]?)$|^(?:[0-9a-fA-F]{1,4}:){7}[0-9a-fA-F]{1,4}$", "Must be valid IPv4 or IPv6")
  @example("192.168.1.1")
  @visibility(Lifecycle.Read)
  user_last_login_ip?: string;

  @field(25)
  @doc("Citizenship information")
  @summary("Citizenship")
  @maxLength(64)
  @secret
  @example("USA")
  citizenship?: string;

  @field(26)
  @doc("Risk assessment score. Scaled ×100 (0-10000 represents 0.00-100.00)")
  @summary("Fraud Score (scaled ×100)")
  @minValue(0)
  @maxValue(10000)
  @example(4275)
  @visibility(Lifecycle.Read)
  fraud_score?: int32;

  @field(27)
  @doc("Total revenue generated in cents (USD). Divide by 100 for dollar value.")
  @summary("Lifetime Revenue (cents)")
  @minValue(0)
  @example(2543210)
  @visibility(Lifecycle.Read)
  lifetime_revenue_cents?: int64;

  @field(28)
  @doc("Subprime risk indicator. Scaled ×100 (0-10000 represents 0.00-100.00)")
  @summary("Subprime Score (scaled ×100)")
  @minValue(0)
  @maxValue(10000)
  subprime?: int32;

  @field(29)
  @doc("Additional system flags bitfield")
  @summary("Flags 2")
  flags2?: int64;

  @field(30)
  @doc("Autosweep target account identifier")
  @summary("Autosweep Target")
  @maxLength(30)
  autosweep_target?: string;

  @field(31)
  @doc("Account closure timestamp")
  @summary("Closed At")
  @extension("x-format", "unix-timestamp")
  @visibility(Lifecycle.Read)
  time_closed?: int64;

  @field(32)
  @doc("Withdrawable balance in cents (USD, can be negative for overdraft). Divide by 100 for dollar value.")
  @summary("Withdraw Balance (cents)")
  @example(154325)
  withdraw_balance_cents?: int64;

  @field(33)
  @doc("Primary email address for communications")
  @summary("Email Address")
  @minLength(5)
  @maxLength(127)
  @format("email")
  @pattern("^[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\\.[a-zA-Z]{2,}$", "Must be valid email format")
  @example("user@example.com")
  primary_email_name?: string;

  @field(34)
  @doc("AFS classification type")
  @summary("AFS Type")
  afs_type?: string;

  @field(35)
  @doc("AFS identifier")
  @summary("AFS ID")
  @minValue(0)
  afs_id?: int64;

  @field(36)
  @doc("AAC error count")
  @summary("AAC Errors")
  @minValue(0)
  aac_error_count?: int64;

  @field(37)
  @doc("Extended system flags bitfield")
  @summary("Flags 3")
  flags3?: int64;

  @field(38)
  @doc("Completed transaction volume in cents (USD). Divide by 100 for dollar value.")
  @summary("Volume Completed (cents)")
  @minValue(0)
  @visibility(Lifecycle.Read)
  volume_completed_cents?: int64;

  @field(39)
  @doc("Completed plus pending volume in cents (USD). Divide by 100 for dollar value.")
  @summary("Volume Completed + Pending (cents)")
  @minValue(0)
  @visibility(Lifecycle.Read)
  volume_completed_plus_pending_cents?: int64;

  @field(40)
  @doc("Preferred language code (ISO 639)")
  @summary("Language")
  @minLength(2)
  @maxLength(5)
  @pattern("^[a-z]{2}(-[A-Z]{2})?$", "Must be valid ISO 639 code (e.g., 'en', 'en-US')")
  @example("en-US")
  language?: string;

  @field(41)
  @doc("Primary residence country code (ISO 3166-1 alpha-2)")
  @summary("Country")
  @minLength(2)
  @maxLength(2)
  @pattern("^[A-Z]{2}$", "Must be valid ISO 3166 country code")
  @example("US")
  primary_residence?: string;

  @field(42)
  @doc("Account validation attempts count")
  @summary("Validation Tries")
  @minValue(0)
  @maxValue(100)
  validation_tries?: int64;

  @field(43)
  @doc("Latest system flags bitfield")
  @summary("Flags 4")
  flags4?: int64;

  @field(44)
  @doc("ACH deposit amounts in cents (USD). Divide by 100 for dollar value.")
  @summary("ACH Deposited (cents)")
  @minValue(0)
  amount_ach_deposited_cents?: int64;

  @field(45)
  @doc("Manual risk score override. Scaled ×100 (0-10000 represents 0.00-100.00)")
  @summary("Contact Score Override (scaled ×100)")
  @minValue(0)
  @maxValue(10000)
  contact_score_override?: int32;

  @field(46)
  @doc("Account cloning state identifier")
  @summary("Clone State")
  clone_state?: int64;

  @field(47)
  @doc("Credit card risk group identifier")
  @summary("CC Risk Group")
  @minValue(0)
  ccrisk_cutoff_group?: int64;

  @field(48)
  @doc("Amount sent from balance in cents (USD). Divide by 100 for dollar value.")
  @summary("Sent from Balance (cents)")
  @minValue(0)
  amount_sent_from_balance_cents?: int64;

  @field(49)
  @doc("Amount sent from unconfirmed funds in cents (USD). Divide by 100 for dollar value.")
  @summary("Sent from Unconfirmed (cents)")
  @minValue(0)
  amount_sent_from_unconfirmed_cents?: int64;

  @field(50)
  @doc("User's timezone (IANA timezone identifier)")
  @summary("Timezone")
  @maxLength(32)
  @pattern("^[A-Za-z_]+/[A-Za-z_]+$", "Must be valid IANA timezone")
  @example("America/New_York")
  timezone?: string;

  // ═══════════════════════════════════════════════════════════════════════
  // RISK AND SECURITY INFORMATION (WUSER_RISK_STATS)
  // ═══════════════════════════════════════════════════════════════════════

  @field(51)
  @doc("Last risk statistics update time")
  @summary("Risk Stats Updated")
  @extension("x-format", "unix-timestamp")
  @visibility(Lifecycle.Read)
  risk_stats_pypl_time_touched?: int64;

  @field(52)
  @doc("Last web access from risk tracking system")
  @summary("Risk Last Web Access")
  @extension("x-format", "unix-timestamp")
  @visibility(Lifecycle.Read)
  risk_stats_last_web_access?: int64;

  @field(53)
  @doc("Last login IP from risk tracking (IPv4 or IPv6)")
  @summary("Risk Last Login IP")
  @maxLength(45)
  @pattern("^(?:(?:25[0-5]|2[0-4][0-9]|[01]?[0-9][0-9]?)\\.){3}(?:25[0-5]|2[0-4][0-9]|[01]?[0-9][0-9]?)$|^(?:[0-9a-fA-F]{1,4}:){7}[0-9a-fA-F]{1,4}$", "Must be valid IP")
  @example("192.168.1.1")
  @visibility(Lifecycle.Read)
  risk_stats_last_login_ip?: string;

  @field(54)
  @doc("Last login session ID")
  @summary("Last Login Session")
  @minValue(0)
  @visibility(Lifecycle.Read)
  last_login_id?: int64;

  // ═══════════════════════════════════════════════════════════════════════
  // DECOMPOSED FLAGS (Bitfield extraction)
  // ═══════════════════════════════════════════════════════════════════════

  @field(55)
  @doc("Account locked status flag (extracted from FLAGS bitfield)")
  @summary("Is Locked")
  @example(false)
  wuser_flag_locked?: boolean;

  @field(56)
  @doc("Address confirmed status flag (extracted from FLAGS bitfield)")
  @summary("Address Confirmed")
  @example(true)
  wuser_flag_address_confirmed?: boolean;

  @field(57)
  @doc("Account closed status flag (extracted from FLAGS bitfield)")
  @summary("Is Closed")
  @example(false)
  wuser_flag_closed?: boolean;

  // ═══════════════════════════════════════════════════════════════════════
  // SYSTEM FIELDS
  // ═══════════════════════════════════════════════════════════════════════

  @field(58)
  @doc("UUID for external references")
  @summary("Profile UUID")
  @minLength(36)
  @maxLength(36)
  @format("uuid")
  @pattern("^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$", "Must be valid UUID")
  @example("550e8400-e29b-41d4-a716-446655440000")
  @visibility(Lifecycle.Read)
  user_profile_id?: string;

  @field(59)
  @doc("Record creation timestamp")
  @summary("Row Created")
  @extension("x-format", "unix-timestamp")
  @visibility(Lifecycle.Read)
  row_created_time?: int64;

  @field(60)
  @doc("Record last modification timestamp")
  @summary("Row Updated")
  @extension("x-format", "unix-timestamp")
  @visibility(Lifecycle.Read)
  row_updated_time?: int64;
}

// ═══════════════════════════════════════════════════════════════════════════
// SERVICE REQUEST/RESPONSE MESSAGES
// ═══════════════════════════════════════════════════════════════════════════

@message
@doc("Request to get a user profile by account number")
model GetUserProfileRequest {
  @field(1)
  @doc("Account number to look up")
  @minValue(1)
  account_number: int64;
}

@message
@doc("Response containing a user profile")
model GetUserProfileResponse {
  @field(1)
  @doc("The requested user profile")
  profile?: UserProfile;
}

@message
@doc("Request to create a new user profile")
model CreateUserProfileRequest {
  @field(1)
  @doc("User's first name")
  @minLength(1)
  @maxLength(64)
  @pattern("^[a-zA-Z\\s'-]+$", "Letters, spaces, hyphens, apostrophes only")
  @example("John")
  first_name: string;

  @field(2)
  @doc("User's last name")
  @minLength(1)
  @maxLength(64)
  @pattern("^[a-zA-Z\\s'-]+$", "Letters, spaces, hyphens, apostrophes only")
  @example("Doe")
  last_name: string;

  @field(3)
  @doc("Primary email address")
  @minLength(5)
  @maxLength(127)
  @format("email")
  @pattern("^[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\\.[a-zA-Z]{2,}$", "Must be valid email")
  @example("john.doe@example.com")
  primary_email_name: string;

  @field(4)
  @doc("Daytime phone number (E.164 format)")
  @maxLength(40)
  @pattern("^\\+?[1-9]\\d{1,14}$", "Must be valid E.164 phone")
  @example("+14155552671")
  day_phone?: string;

  @field(5)
  @doc("Evening phone number (E.164 format)")
  @maxLength(40)
  @pattern("^\\+?[1-9]\\d{1,14}$", "Must be valid E.164 phone")
  @example("+14155552672")
  night_phone?: string;

  @field(6)
  @doc("Preferred language code (ISO 639)")
  @minLength(2)
  @maxLength(5)
  @pattern("^[a-z]{2}(-[A-Z]{2})?$", "Must be ISO 639 code")
  @example("en-US")
  language?: string;

  @field(7)
  @doc("Primary residence country (ISO 3166-1 alpha-2)")
  @minLength(2)
  @maxLength(2)
  @pattern("^[A-Z]{2}$", "Must be ISO 3166 country code")
  @example("US")
  primary_residence?: string;

  @field(8)
  @doc("User's timezone (IANA timezone)")
  @maxLength(32)
  @pattern("^[A-Za-z_]+/[A-Za-z_]+$", "Must be IANA timezone")
  @example("America/New_York")
  timezone?: string;

  @field(9)
  @doc("Citizenship information")
  @maxLength(64)
  @secret
  @example("USA")
  citizenship?: string;

  @field(10)
  @doc("User group classification (1-999)")
  @minValue(1)
  @maxValue(999)
  @example(100)
  user_group?: int64;
}

@message
@doc("Response after creating a user profile")
model CreateUserProfileResponse {
  @field(1)
  @doc("Newly created account number")
  @minValue(1)
  account_number: int64;

  @field(2)
  @doc("UUID for external references")
  @format("uuid")
  @example("550e8400-e29b-41d4-a716-446655440000")
  user_profile_id: string;

  @field(3)
  @doc("Account creation timestamp")
  @extension("x-format", "unix-timestamp")
  user_time_created: int64;
}

@message
@doc("Request to update a user profile")
model UpdateUserProfileRequest {
  @field(1)
  @doc("Account number to update")
  @minValue(1)
  account_number: int64;

  @field(2)
  @doc("User's first name")
  @minLength(1)
  @maxLength(64)
  @pattern("^[a-zA-Z\\s'-]+$", "Letters, spaces, hyphens, apostrophes only")
  first_name?: string;

  @field(3)
  @doc("User's last name")
  @minLength(1)
  @maxLength(64)
  @pattern("^[a-zA-Z\\s'-]+$", "Letters, spaces, hyphens, apostrophes only")
  last_name?: string;

  @field(4)
  @doc("Primary email address")
  @minLength(5)
  @maxLength(127)
  @format("email")
  primary_email_name?: string;

  @field(5)
  @doc("Daytime phone number")
  @maxLength(40)
  @pattern("^\\+?[1-9]\\d{1,14}$", "Must be E.164 format")
  day_phone?: string;

  @field(6)
  @doc("Evening phone number")
  @maxLength(40)
  @pattern("^\\+?[1-9]\\d{1,14}$", "Must be E.164 format")
  night_phone?: string;

  @field(7)
  @doc("Preferred language code")
  @minLength(2)
  @maxLength(5)
  language?: string;

  @field(8)
  @doc("Primary residence country")
  @minLength(2)
  @maxLength(2)
  primary_residence?: string;

  @field(9)
  @doc("User's timezone")
  @maxLength(32)
  timezone?: string;

  @field(10)
  @doc("Transaction limit in cents (USD)")
  @minValue(0)
  transaction_limit_cents?: int64;
}

@message
@doc("Response after updating a user profile")
model UpdateUserProfileResponse {
  @field(1)
  @doc("Whether the update was successful")
  success: boolean;

  @field(2)
  @doc("Updated timestamp")
  @extension("x-format", "unix-timestamp")
  row_updated_time: int64;
}

@message
@doc("Request to list user profiles with pagination")
model ListUserProfilesRequest {
  @field(1)
  @doc("Page number (1-indexed)")
  @minValue(1)
  @example(1)
  page?: int32;

  @field(2)
  @doc("Number of items per page")
  @minValue(1)
  @maxValue(100)
  @example(20)
  limit?: int32;

  @field(3)
  @doc("Filter by user group")
  @minValue(1)
  @maxValue(999)
  user_group?: int64;

  @field(4)
  @doc("Filter by country code (ISO 3166-1 alpha-2)")
  @minLength(2)
  @maxLength(2)
  @pattern("^[A-Z]{2}$", "Must be ISO 3166 country code")
  primary_residence?: string;
}

@message
@doc("Response containing a list of user profiles")
model ListUserProfilesResponse {
  @field(1)
  @doc("List of user profiles")
  profiles: UserProfile[];

  @field(2)
  @doc("Total number of matching profiles")
  @minValue(0)
  total_count: int64;

  @field(3)
  @doc("Current page number")
  @minValue(1)
  page: int32;

  @field(4)
  @doc("Number of items per page")
  @minValue(1)
  limit: int32;
}
