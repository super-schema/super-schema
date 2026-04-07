// ================================================================================================
// ACCOUNT — Interleaved child of Customer
// ================================================================================================
//
// Service relationship entity representing PayPal accounts. One customer can have
// multiple accounts. Collapsed design includes merchant_account_extension and
// tax_info for service tiers with merchant capabilities.
//
// TABLE_CATEGORY: TRANSACTIONAL
// ================================================================================================

namespace PayPal.CustomerDataStore;

using PayPal.CustomerDataStore.Decorators;

@doc("Service account representing a customer's relationship with PayPal. Supports consumer and merchant capabilities with collapsed merchant extension.")
@interleaveInParent("Customer", "CASCADE")
@tableCategory("TRANSACTIONAL")
@accountability("DTCDS-113", "dt-cp-identity-cds@paypal.com", "DT-CP-Identity-CDS")
@capacity(1800)
@dataProvenance("TBD", "API")
@dataResidency(true, #["US", "EU", "APAC"])
@apiResource(#{
  basePath: "/v1/enterprise-data/accounts",
  singularName: "account",
  pluralName: "accounts",
  operations: #["create", "read", "update", "delete", "list"],
  resourceScope: "top_level_resource",
  parentEntity: "customer",
  parentPathParam: "customer_id"
})
@fieldset(
  "account_overview",
  "Account summary with external identity mappings",
  #["account_id", "account_number", "status", "legal_entity", "legal_country", "account_type", "name"]
)
@spannerIndex("idx_account_number", #["account_number"], #{ unique: true, description: "Unique index on user-visible account_number for backward compatibility with legacy systems. Supports customer service tools and migration paths." })
model Account {
  // ── Keys ─────────────────────────────────────────────────────────────────

  @doc("Foreign key to parent customer table, part of composite primary key and interleave key path. One customer can have multiple accounts.")
  @visibility(Lifecycle.Read)
  @infosecClass("Class 4")
  @accessScopes(#["account:read"])
  customer_id: uuid;

  @doc("Globally unique UUID for account. Part of composite primary key.")
  @key
  @visibility(Lifecycle.Read)
  @infosecClass("Class 4")
  @accessScopes(#["account:read"])
  account_id: uuid;

  @doc("Legacy account number for backward compatibility and customer support. Unique index supports legacy lookups.")
  @visibility(Lifecycle.Read)
  @infosecClass("Class 3")
  @pii @spi @cde
  @maxLength(20)
  @accessScopes(#["account:read"])
  account_number: string;

  // ── Account Core ─────────────────────────────────────────────────────────

  @doc("Account relationship status lifecycle.")
  @visibility(Lifecycle.Create, Lifecycle.Read, Lifecycle.Update)
  @infosecClass("Class 4")
  @accessScopes(#["account:read"], #["account:lifecycle:write"])
  @ownedBy("account-lifecycle")
  status: AccountStatus;

  @doc("PayPal legal entity for this account. May differ from customer.legal_entity when customer has accounts with multiple PayPal entities.")
  @visibility(Lifecycle.Create, Lifecycle.Read)
  @infosecClass("Class 4")
  @accessScopes(#["account:read"], #["account:lifecycle:write"])
  @ownedBy("account-lifecycle")
  legal_entity?: LegalEntity;

  @doc("Account legal country in ISO 3166-1 alpha-2 format. May differ from customer.legal_country for international accounts. Critical for compliance and tax jurisdiction.")
  @visibility(Lifecycle.Create, Lifecycle.Read)
  @infosecClass("Class 4")
  @dqRules(#["non_empty", "iso_3166_1_alpha2"])
  @accessScopes(#["account:read"], #["account:lifecycle:write"])
  @ownedBy("account-lifecycle")
  legal_country: CountryCode;

  @doc("Product catalog tier determining available features and merchant capabilities. Merchant fields populated for MERCHANT, CONSUMER_PREMIER, and ENTERPRISE tiers.")
  @visibility(Lifecycle.Create, Lifecycle.Read, Lifecycle.Update)
  @infosecClass("Class 4")
  @accessScopes(#["account:read"], #["account:tier:write"])
  @ownedBy("account-lifecycle")
  account_type: AccountType;

  @doc("User-defined account name for multi-account identification (e.g., 'My Personal Account', 'Business Checking').")
  @visibility(Lifecycle.Create, Lifecycle.Read, Lifecycle.Update)
  @infosecClass("Class 3")
  @pii @cde
  @maxLength(128)
  @accessScopes(#["account:read"], #["account:profile:write"])
  @ownedBy("account-lifecycle")
  name?: string;

  @doc("Spanner commit timestamp when account was created. Immutable after insert. Used for RIG retention policy.")
  @visibility(Lifecycle.Read)
  @infosecClass("Class 5")
  @commitTimestamp
  @accessScopes(#["account:read"])
  time_created: utcDateTime;

  // ── Tax (owned by Tax domain) ────────────────────────────────────────────

  @doc("Tax identification details owned by Tax domain. Contains tax_id (MUST be encrypted at application layer), tax_id_type, issuing_country, verification_status, and tax_address. Critical for tax compliance and regulatory reporting.")
  @visibility(Lifecycle.Create, Lifecycle.Read, Lifecycle.Update)
  @infosecClass("Class 2")
  @pii @pci @spi @cde
  @encrypted("cds-instance.cds_database.account.tax_details", "AES-GCM")
  @schemaRef("schemas/account/tax_info.json")
  @accessScopes(#["account:tax:read"], #["account:tax:write"])
  @ownedBy("tax")
  tax_details?: TaxDetails;

  // ── Merchant Extension (NULL for CONSUMER tier) ──────────────────────────

  @doc("Effective Merchant Category Code as JSON with code, category, and description. Present when service_tier includes merchant capabilities.")
  @visibility(Lifecycle.Create, Lifecycle.Read, Lifecycle.Update)
  @infosecClass("Class 4")
  @schemaRef("schemas/account/merchant_category_code.json")
  @accessScopes(#["account:read", "merchant:read"], #["merchant:mcc:write"])
  @ownedBy("merchant-risk")
  merchant_mcc?: MerchantCategoryCode;

  @doc("Merchant name appearing on customer statements. Customer-facing branding attribute.")
  @visibility(Lifecycle.Create, Lifecycle.Read, Lifecycle.Update)
  @infosecClass("Class 3")
  @pii @cde
  @schemaRef("schemas/account/statement_descriptor.json")
  @accessScopes(#["account:read", "merchant:read"], #["merchant:profile:write"])
  @ownedBy("merchant-onboarding")
  merchant_statement_name?: StatementDescriptor;

  @doc("Public-facing merchant website URL. Used for merchant verification and customer trust indicators.")
  @visibility(Lifecycle.Create, Lifecycle.Read, Lifecycle.Update)
  @infosecClass("Class 3")
  @pii @cde
  @dqRules(#["url_format", "max_length_2048"])
  @accessScopes(#["account:read", "merchant:read"], #["merchant:profile:write"])
  @ownedBy("merchant-onboarding")
  merchant_website?: UrlString;

  @doc("Merchant customer service contact information as JSON. Displayed to customers for merchant support.")
  @visibility(Lifecycle.Create, Lifecycle.Read, Lifecycle.Update)
  @infosecClass("Class 3")
  @pii @cde
  @schemaRef("schemas/account/customer_service_contact.json")
  @accessScopes(#["account:read", "merchant:read"], #["merchant:profile:write"])
  @ownedBy("merchant-onboarding")
  merchant_customer_service?: CustomerServiceContact;

  @doc("Email address for chargeback and dispute notifications. RFC 5321 format. Critical for merchant dispute resolution workflow.")
  @visibility(Lifecycle.Create, Lifecycle.Read, Lifecycle.Update)
  @infosecClass("Class 3")
  @pii @cde
  @dqRules(#["email_format", "max_length_254"])
  @accessScopes(#["account:read", "merchant:read"], #["merchant:profile:write"])
  @ownedBy("merchant-onboarding")
  merchant_dispute_email?: EmailAddress;

  @doc("Merchant logo URL for branding in checkout flows and invoices.")
  @visibility(Lifecycle.Create, Lifecycle.Read, Lifecycle.Update)
  @infosecClass("Class 4")
  @dqRules(#["url_format", "max_length_2048"])
  @accessScopes(#["account:read", "merchant:read"], #["merchant:branding:write"])
  @ownedBy("merchant-onboarding")
  merchant_logo_url?: UrlString;

  @doc("Custom background image URL for branded checkout experience.")
  @visibility(Lifecycle.Create, Lifecycle.Read, Lifecycle.Update)
  @infosecClass("Class 4")
  @dqRules(#["url_format", "max_length_2048"])
  @accessScopes(#["account:read", "merchant:read"], #["merchant:branding:write"])
  @ownedBy("merchant-onboarding")
  merchant_background_url?: UrlString;

  @doc("Merchant self-classification MCC code. 4-digit string. Compliance requirement to track merchant-provided classification separately from effective MCC.")
  @visibility(Lifecycle.Create, Lifecycle.Read, Lifecycle.Update)
  @infosecClass("Class 4")
  @dqRules(#["mcc_format", "exact_length_4"])
  @accessScopes(#["account:read", "merchant:read"], #["merchant:profile:write"])
  @ownedBy("merchant-onboarding")
  merchant_provided_mcc?: MerchantCategoryCodeValue;
}
