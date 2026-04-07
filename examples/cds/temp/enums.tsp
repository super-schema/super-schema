// ================================================================================================
// ENUM DEFINITIONS — Extracted from DDL column validation metadata
// ================================================================================================

namespace PayPal.CustomerDataStore;

using PayPal.CustomerDataStore.Decorators;

// ── Brand ────────────────────────────────────────────────────────────────────

@doc("Brand namespace for customer. Normalized to UPPERCASE for consistency. Provides brand-based partitioning without hard tenant isolation.")
enum Brand {
  PAYPAL,
  VENMO,
  FASTLANE,
  BRAINTREE,
}

// ── Customer ─────────────────────────────────────────────────────────────────

@doc("Customer type distinguishing individual consumers from business organizations. Determines which profile columns are populated (person_* vs organization_*).")
enum CustomerType {
  INDIVIDUAL,
  ORGANIZATION,
}

@doc("Customer relationship lifecycle status.")
enum CustomerStatus {
  @doc("Ongoing customer relationship") ACTIVE,
  @doc("All accounts terminated") CLOSED,
}

@doc("PayPal legal entity for customer or account relationship.")
enum LegalEntity {
  @doc("PayPal Inc (United States)") INC,
  @doc("PayPal Europe") EUROPE,
  @doc("PayPal Singapore") SINGAPORE,
  @doc("PayPal Australia") AUSTRALIA,
}

@doc("Person gender self-identification. Optional field respecting customer privacy preferences.")
enum Gender {
  MALE,
  FEMALE,
  PREFER_NOT_TO_SAY,
}

// ── Account ──────────────────────────────────────────────────────────────────

@doc("Account relationship status lifecycle.")
enum AccountStatus {
  PENDING,
  ACTIVE,
  CLOSED,
}

@doc("Product catalog tier determining available features and merchant capabilities.")
enum AccountType {
  CONSUMER,
  CONSUMER_PREMIER,
  MERCHANT,
  ENTERPRISE,
  XOOM_REMITTANCE,
}

// ── Phone ────────────────────────────────────────────────────────────────────

@doc("Classification of phone number type.")
enum PhoneType {
  MOBILE,
  HOME,
  WORK,
  FAX,
}

// ── Address ──────────────────────────────────────────────────────────────────

@doc("Address classification to distinguish usage purpose.")
enum AddressType {
  MAILING,
  PREVIOUS,
  ALTERNATE,
  REGISTERED,
  PRINCIPAL_OFFICE,
}

// ── Organization ─────────────────────────────────────────────────────────────

@doc("Stakeholder role in organization for compliance and regulatory reporting.")
enum StakeholderRole {
  OWNER,
  DIRECTOR,
  BENEFICIAL_OWNER,
}

// ── Auth ─────────────────────────────────────────────────────────────────────

@doc("External authentication provider.")
enum IdentityProvider {
  PAYPAL,
  GITHUB,
  GOOGLE,
  FACEBOOK,
  APPLE,
}

@doc("Classification of alias identifier type for validation and UX purposes.")
enum AliasType {
  EMAIL,
  USERNAME,
  PHONE,
}

// ── Access Control ───────────────────────────────────────────────────────────

@doc("Type of resource being accessed in MUMA/Family/MAM scenarios.")
enum ResourceType {
  ACCOUNT,
}
