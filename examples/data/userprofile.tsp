model UserProfile {
  @doc("Primary key - unique user identifier")
  @visibility(Lifecycle.Read)
  @tag("classification:PII")
  account_number?: int64;
  @doc("Account creation timestamp")
  user_time_created?: int64;
  @doc("User's first name")
  @tag("classification:PII")
  first_name?: string;
  @doc("User's last name")
  @tag("classification:PII")
  last_name?: string;
  @doc("System flags bitfield - deprecated, use decomposed flags instead")
  user_flags?: int64;
  @doc("Last web login time")
  user_last_web_access?: int64;
  @doc("Daytime phone number in E.164 format")
  day_phone?: string;
  @doc("Evening phone number in E.164 format")
  night_phone?: string;
  @doc("Reference to primary address")
  address_id?: int64;
  @doc("Billing cycle number (day of month)")
  cycle_number?: int64;
  @doc("Active transaction ID")
  server_current_transaction?: int64;
  @doc("Credit charges amount in cents (USD). Divide by 100 for dollar value.")
  credit_charged_cents?: int64;
  @doc("Last cycle update time")
  cycle_last_updated?: int64;
  @doc("Confirmation error count")
  confirm_error_count?: int64;
  @doc("Transaction limit amount in cents (USD). Divide by 100 for dollar value.")
  transaction_limit_cents?: int64;
  @doc("Default credit card ID reference")
  default_cc?: int64;
  @doc("Default ACH account ID reference")
  default_ach?: int64;
  @doc("User group classification identifier (1-999)")
  user_group?: int64;
  @doc("Primary email ID reference")
  primary_email?: int64;
  @doc("Lifetime sent amount in cents (USD). Divide by 100 for dollar value.")
  total_amount_sent_cents?: int64;
  @doc("Total authentication attempts count")
  authentications?: int64;
  @doc("Receiving preferences bitfield")
  receiving_prefs?: int64;
  @doc("Credit card receipts amount in cents (USD). Divide by 100 for dollar value.")
  cc_amount_received_cents?: int64;
  @doc("Last login IP address (IPv4 or IPv6)")
  user_last_login_ip?: string;
  @doc("Citizenship information")
  citizenship?: string;
  @doc("Risk assessment score. Scaled ×100 (0-10000 represents 0.00-100.00)")
  fraud_score?: int32;
  @doc("Total revenue generated in cents (USD). Divide by 100 for dollar value.")
  lifetime_revenue_cents?: int64;
  @doc("Subprime risk indicator. Scaled ×100 (0-10000 represents 0.00-100.00)")
  subprime?: int32;
  @doc("Additional system flags bitfield")
  flags2?: int64;
  @doc("Autosweep target account identifier")
  autosweep_target?: string;
  @doc("Account closure timestamp")
  time_closed?: int64;
  @doc("Withdrawable balance in cents (USD, can be negative for overdraft). Divide by 100 for dollar value.")
  withdraw_balance_cents?: int64;
  @doc("Primary email address for communications")
  primary_email_name?: string;
  @doc("AFS classification type")
  afs_type?: string;
  @doc("AFS identifier")
  afs_id?: int64;
  @doc("AAC error count")
  aac_error_count?: int64;
  @doc("Extended system flags bitfield")
  flags3?: int64;
  @doc("Completed transaction volume in cents (USD). Divide by 100 for dollar value.")
  volume_completed_cents?: int64;
  @doc("Completed plus pending volume in cents (USD). Divide by 100 for dollar value.")
  volume_completed_plus_pending_cents?: int64;
  @doc("Preferred language code (ISO 639)")
  language?: string;
  @doc("Primary residence country code (ISO 3166-1 alpha-2)")
  primary_residence?: string;
  @doc("Account validation attempts count")
  validation_tries?: int64;
  @doc("Latest system flags bitfield")
  flags4?: int64;
  @doc("ACH deposit amounts in cents (USD). Divide by 100 for dollar value.")
  amount_ach_deposited_cents?: int64;
  @doc("Manual risk score override. Scaled ×100 (0-10000 represents 0.00-100.00)")
  contact_score_override?: int32;
  @doc("Account cloning state identifier")
  clone_state?: int64;
  @doc("Credit card risk group identifier")
  ccrisk_cutoff_group?: int64;
  @doc("Amount sent from balance in cents (USD). Divide by 100 for dollar value.")
  amount_sent_from_balance_cents?: int64;
  @doc("Amount sent from unconfirmed funds in cents (USD). Divide by 100 for dollar value.")
  amount_sent_from_unconfirmed_cents?: int64;
  @doc("User's timezone (IANA timezone identifier)")
  timezone?: string;
  @doc("Last risk statistics update time")
  risk_stats_pypl_time_touched?: int64;
  @doc("Last web access from risk tracking system")
  risk_stats_last_web_access?: int64;
  @doc("Last login IP from risk tracking (IPv4 or IPv6)")
  risk_stats_last_login_ip?: string;
  @doc("Last login session ID")
  last_login_id?: int64;
  @doc("Account locked status flag (extracted from FLAGS bitfield)")
  wuser_flag_locked?: boolean;
  @doc("Address confirmed status flag (extracted from FLAGS bitfield)")
  wuser_flag_address_confirmed?: boolean;
  @doc("Account closed status flag (extracted from FLAGS bitfield)")
  wuser_flag_closed?: boolean;
  @doc("UUID for external references")
  @visibility(Lifecycle.Read)
  user_profile_id?: string;
  @doc("Record creation timestamp")
  row_created_time?: int64;
  @doc("Record last modification timestamp")
  row_updated_time?: int64;
  @tag("classification:SENSITIVE")
  asdasd?: string;
}
