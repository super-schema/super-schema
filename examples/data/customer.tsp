@doc("Customer entity representing individuals and organizations with federated data ownership. Supports data minimization via selective attribute retrieval. Collapsed person_profile and business_profile into single table per Spanner best practices — ~50% NULL columns depending on customer_type.")
model Customer {
  @key
  @doc("Unique UUID identifier for customer. Not the legacy party_id but a modern UUID-based identifier for clean data architecture.")
  @visibility(Lifecycle.Read)
  @tag("classification:PII")
  customer_id: string;
  @doc("Legacy party_id from party management v2 system for backward compatibility lookups. Indexed for migration path support. Will eventually be deprecated in favor of customer_id.")
  @maxLength(20)
  @visibility(Lifecycle.Read)
  party_id?: string;
  @doc("Brand namespace for customer. Normalized to UPPERCASE. Provides brand-based partitioning without hard tenant isolation.")
  @visibility(Lifecycle.Create, Lifecycle.Read)
  brand: string;
  @doc("Customer type distinguishing individual consumers from business organizations. Determines which profile columns are populated (person_* vs organization_*).")
  @visibility(Lifecycle.Create, Lifecycle.Read)
  customer_type: string;
  @doc("Customer relationship lifecycle status. ACTIVE for ongoing relationships, CLOSED when all accounts terminated.")
  @visibility(Lifecycle.Create, Lifecycle.Read, Lifecycle.Update)
  status: string;
  @doc("PayPal legal entity for this customer relationship. Determines contractual terms and regulatory jurisdiction.")
  @visibility(Lifecycle.Create, Lifecycle.Read)
  legal_entity?: string;
  @doc("Customer legal country of residence in ISO 3166-1 alpha-2 format. Critical for compliance, tax jurisdiction, and future geo-partitioning.")
  @visibility(Lifecycle.Create, Lifecycle.Read, Lifecycle.Update)
  legal_country: string;
  @doc("Geographic placement region for data locality and multi-region optimization. Populated by application logic based on legal_country. Used as Spanner placement key for geo-partitioning (US, EU, APAC regions).")
  placement_region: string;
  @doc("Customer record creation timestamp. Immutable after insert. Used for RIG retention policy enforcement and audit trails.")
  @visibility(Lifecycle.Read)
  time_created: utcDateTime;
  @doc("Timestamp when customer activated their first account. NULL until first account activation.")
  @visibility(Lifecycle.Read, Lifecycle.Update)
  time_activated?: utcDateTime;
  @doc("Timestamp when customer relationship ended. NULL for active customers.")
  @visibility(Lifecycle.Read, Lifecycle.Update)
  time_closed?: utcDateTime;
  @doc("Customer locale preferences (language, country, timezone). Replaces separate locale table per Spanner best practice for co-queried data.")
  @visibility(Lifecycle.Create, Lifecycle.Read, Lifecycle.Update)
  locale?: string;
  @doc("Array of ISO 3166-1 alpha-2 country codes representing person citizenship. Supports multiple citizenship. NULL for ORGANIZATION type.")
  @visibility(Lifecycle.Create, Lifecycle.Read, Lifecycle.Update)
  person_citizenship?: string[];
  @doc("Person gender self-identification. NULL for ORGANIZATION type. Optional field respecting customer privacy preferences.")
  @visibility(Lifecycle.Create, Lifecycle.Read, Lifecycle.Update)
  person_gender?: string;
  @doc("Legal name as it appears on official documents (passport, government ID). Includes confirmation metadata.")
  @visibility(Lifecycle.Create, Lifecycle.Read, Lifecycle.Update)
  person_legal_name?: string;
  @doc("Birth information including date and place. Used for identity verification and age verification. Highly sensitive PII requiring strict access controls.")
  @visibility(Lifecycle.Create, Lifecycle.Read, Lifecycle.Update)
  person_birth_details?: string;
  @doc("Primary email address. Denormalized from customer_email table for 95% fast read optimization. NULL for ORGANIZATION customers.")
  @visibility(Lifecycle.Create, Lifecycle.Read, Lifecycle.Update)
  person_primary_email?: string;
  @doc("Primary mobile phone number. Used for SMS 2FA and notifications. Denormalized from customer_phone table. NULL for ORGANIZATION customers.")
  @visibility(Lifecycle.Create, Lifecycle.Read, Lifecycle.Update)
  person_primary_mobile_phone?: string;
  @doc("Primary home phone number. Denormalized from customer_phone table. NULL for ORGANIZATION customers.")
  @visibility(Lifecycle.Create, Lifecycle.Read, Lifecycle.Update)
  person_primary_home_phone?: string;
  @doc("Primary residence address. Denormalized from customer_address table for 95% read optimization. NULL for ORGANIZATION customers.")
  @visibility(Lifecycle.Create, Lifecycle.Read, Lifecycle.Update)
  person_primary_residential_address?: string;
  @doc("Official registered legal name of organization as filed with government authorities. NULL for INDIVIDUAL customers.")
  @maxLength(256)
  @visibility(Lifecycle.Create, Lifecycle.Read, Lifecycle.Update)
  organization_legal_name?: string;
  @doc("Doing Business As (DBA) or trading name. May differ from legal name. NULL for INDIVIDUAL customers.")
  @maxLength(256)
  @visibility(Lifecycle.Create, Lifecycle.Read, Lifecycle.Update)
  organization_trading_name?: string;
  @doc("Tax identification information for the organization. Critical for tax compliance and regulatory reporting.")
  @visibility(Lifecycle.Create, Lifecycle.Read, Lifecycle.Update)
  organization_tax_details?: string;
  @doc("Organization type and subtype classification (corporation, partnership, sole proprietorship, nonprofit). NULL for INDIVIDUAL customers.")
  @visibility(Lifecycle.Create, Lifecycle.Read, Lifecycle.Update)
  organization_type?: string;
  @doc("Incorporation details including date, country, and registration number. NULL for INDIVIDUAL customers.")
  @visibility(Lifecycle.Create, Lifecycle.Read, Lifecycle.Update)
  organization_incorporation?: string;
  @doc("Primary contact email for PayPal to reach the organization. NULL for INDIVIDUAL customers.")
  @visibility(Lifecycle.Create, Lifecycle.Read, Lifecycle.Update)
  organization_notification_email?: string;
  @doc("Main office phone number for the organization. NULL for INDIVIDUAL customers.")
  @visibility(Lifecycle.Create, Lifecycle.Read, Lifecycle.Update)
  organization_office_phone?: string;
  @doc("Legal registered address from incorporation documents. NULL for INDIVIDUAL customers.")
  @visibility(Lifecycle.Create, Lifecycle.Read, Lifecycle.Update)
  organization_registered_address?: string;
  @doc("Principal place of business/operations. May differ from registered address. NULL for INDIVIDUAL customers.")
  @visibility(Lifecycle.Create, Lifecycle.Read, Lifecycle.Update)
  organization_principal_office_address?: string;
}
