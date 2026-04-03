// user-profile-enhanced.tsp
import "@typespec/http";
import "@typespec/rest";
import "@typespec/openapi3";

using TypeSpec.Http;
using TypeSpec.Rest;

@service({
  title: "User Profile Service",
  version: "1.0.0",
  description: "Comprehensive user profile management system with full governance and metadata"
})
@server("https://api.example.com/v1", "Production API")
namespace UserProfileService;

// ============================================================================
// CUSTOM DECORATOR DEFINITIONS
// ============================================================================

/**
 * Specify decimal precision and scale
 */
extern decorator @precision(target: ModelProperty, precision: int32, scale: int32);

/**
 * Numeric range constraints
 */
extern decorator @range(target: ModelProperty, min: numeric, max: numeric);

/**
 * Minimum string length
 */
extern decorator @minLength(target: ModelProperty, length: int32);

/**
 * Maximum string length
 */
extern decorator @maxLength(target: ModelProperty, length: int32);

/**
 * Fixed string length
 */
extern decorator @fixedLength(target: ModelProperty, length: int32);

/**
 * String length range
 */
extern decorator @lengthRange(target: ModelProperty, min: int32, max: int32);

/**
 * Regular expression pattern validation
 */
extern decorator @pattern(target: ModelProperty, pattern: string);

/**
 * Predefined format validation
 */
extern decorator @format(target: ModelProperty, format: string);

/**
 * Custom validation function reference
 */
extern decorator @validator(target: ModelProperty, validator: string);

/**
 * Allowed enum-like values
 */
extern decorator @allowedValues(target: ModelProperty, values: string[]);

/**
 * Uniqueness constraint
 */
extern decorator @unique(target: ModelProperty, scope: string);

/**
 * Immutability constraint
 */
extern decorator @immutable(target: ModelProperty, after: string);

/**
 * Conditional requirement
 */
extern decorator @requiredIf(target: ModelProperty, condition: string);

/**
 * Cross-field validation
 */
extern decorator @crossFieldValidation(target: Model, rule: string);

/**
 * Business owner
 */
extern decorator @businessOwner(target: Model | ModelProperty, owner: string);

/**
 * Data retention policy
 */
extern decorator @retentionPolicy(target: Model, policy: string);

/**
 * Atomic business unit
 */
extern decorator @atomicUnit(target: Model, isAtomic: boolean);

/**
 * Data classification level
 */
extern decorator @dataClassification(target: ModelProperty, level: string);

/**
 * Anonymization strategy
 */
extern decorator @anonymization(target: ModelProperty, strategy: string);

/**
 * Source system and column
 */
extern decorator @dataSource(target: ModelProperty, source: string);

/**
 * Data quality rule
 */
extern decorator @qualityRule(target: ModelProperty, rule: string);

/**
 * Storage optimization strategy
 */
extern decorator @storageStrategy(target: Model | ModelProperty, hint: string);

/**
 * Relationship to other entities
 */
extern decorator @relationship(target: ModelProperty, targetEntity: string, type: string);

/**
 * Transformation logic
 */
extern decorator @transformationLogic(target: ModelProperty, logic: string);

/**
 * Reference documentation
 */
extern decorator @referenceDoc(target: ModelProperty, url: string);

/**
 * Custom metadata key-value
 */
extern decorator @metadata(target: Model | ModelProperty, key: string, value: string);

/**
 * Multiple metadata as map
 */
extern decorator @metadataMap(target: Model | ModelProperty, data: unknown);

/**
 * Temporary field marker
 */
extern decorator @temporary(target: ModelProperty, reason: string, removeAfter: string);

/**
 * Feature flag association
 */
extern decorator @featureFlag(target: ModelProperty, flag: string);

/**
 * Migration status
 */
extern decorator @migrationStatus(target: Model | ModelProperty, status: string, phase: string);

/**
 * Technical debt marker
 */
extern decorator @technicalDebt(target: Model | ModelProperty, issue: string, ticket: string);

/**
 * Performance hint
 */
extern decorator @performanceHint(target: ModelProperty, hint: string);

/**
 * Cost estimation
 */
extern decorator @costEstimate(target: ModelProperty, estimate: string);

/**
 * Access frequency hint
 */
extern decorator @accessFrequency(target: ModelProperty, frequency: string);

/**
 * Custom tags
 */
extern decorator @tags(target: Model | ModelProperty, tags: string[]);

/**
 * Compliance requirement
 */
extern decorator @compliance(target: ModelProperty, regulation: string, requirement: string);

/**
 * Encryption requirement
 */
extern decorator @encryption(target: ModelProperty, method: string, algorithm?: string);

/**
 * Audit requirement
 */
extern decorator @audit(target: ModelProperty, level: string, retention: string);

/**
 * Data lineage
 */
extern decorator @lineage(target: ModelProperty, upstream: string, transformation: string, refreshFrequency: string);

/**
 * Calculated field
 */
extern decorator @calculated(target: ModelProperty, formula: string, dependencies: string[]);

/**
 * ML model derived
 */
extern decorator @mlDerived(target: ModelProperty, model: string, version: string, features: string[]);

/**
 * Data freshness requirement
 */
extern decorator @freshness(target: ModelProperty, maxAge: string, staleBehavior: string);

/**
 * API visibility
 */
extern decorator @apiVisible(target: ModelProperty, apis: string[]);

/**
 * Write-only field
 */
extern decorator @writeOnly(target: ModelProperty);

/**
 * Read-only field
 */
extern decorator @readOnly(target: ModelProperty);

/**
 * Requires permission
 */
extern decorator @requiresPermission(target: ModelProperty, permission: string);

/**
 * Pageable field
 */
extern decorator @pageable(target: ModelProperty);

/**
 * Sortable field
 */
extern decorator @sortable(target: ModelProperty);

/**
 * Filterable field
 */
extern decorator @filterable(target: ModelProperty);

/**
 * Searchable field
 */
extern decorator @searchable(target: ModelProperty, weight?: int32);

/**
 * Field masking
 */
extern decorator @mask(target: ModelProperty, context: string, method: string);

/**
 * Usage example
 */
extern decorator @example(target: ModelProperty, example: string);

/**
 * Multiple examples
 */
extern decorator @examples(target: ModelProperty, examples: string[]);

/**
 * Default value
 */
extern decorator @defaultValue(target: ModelProperty, value: string);

/**
 * Detailed explanation
 */
extern decorator @explanation(target: Model | ModelProperty, explanation: string);

/**
 * External documentation link
 */
extern decorator @externalDocs(target: Model | ModelProperty, url: string);

/**
 * Warning message
 */
extern decorator @warning(target: ModelProperty, message: string);

/**
 * See also references
 */
extern decorator @seeAlso(target: Model | ModelProperty, references: string[]);

/**
 * Version information
 */
extern decorator @version(target: ModelProperty, added: string, modified?: string, deprecated?: string);

/**
 * Breaking change marker
 */
extern decorator @breakingChange(target: ModelProperty, version: string, description: string);

/**
 * Backward compatibility note
 */
extern decorator @backwardCompatible(target: ModelProperty, note: string);

/**
 * Rename history
 */
extern decorator @renamedFrom(target: ModelProperty, previousNames: string[]);

/**
 * Test data generator
 */
extern decorator @testDataGenerator(target: ModelProperty, generator: string, params?: string);

/**
 * Monitoring metric
 */
extern decorator @monitor(target: ModelProperty, metric: string, threshold: string);

/**
 * SLA definition
 */
extern decorator @sla(target: Model | ModelProperty, availability: string, latency: string);

/**
 * Data quality check
 */
extern decorator @qualityCheck(target: ModelProperty, check: string, frequency: string);

// ============================================================================
// ENUMERATIONS
// ============================================================================

@doc("Address type classification")
enum AddressType {
  @doc("Residential address")
  residential: "R",

  @doc("Business address")
  business: "B",

  @doc("Other address type")
  other: "O",
}

@doc("Address status codes")
enum AddressStatus {
  @doc("Active address")
  active: "A",

  @doc("Inactive address")
  inactive: "I",

  @doc("Pending verification")
  pending: "P",
}

@doc("AFS classification types")
enum AfsType {
  @doc("Type A classification")
  typeA: "A",

  @doc("Type B classification")
  typeB: "B",

  @doc("Type C classification")
  typeC: "C",
}

@doc("User account status")
enum AccountStatus {
  @doc("Account is active and operational")
  active: "active",

  @doc("Account is temporarily suspended")
  suspended: "suspended",

  @doc("Account is permanently closed")
  closed: "closed",

  @doc("Account is pending verification")
  pending: "pending",
}

// ============================================================================
// MAIN ENTITY - USER PROFILE (Logical Model)
// ============================================================================

@doc("Complete user profile entity combining user, address, and risk information")
@businessOwner("User Management Team")
@retentionPolicy("7 years after account closure")
@atomicUnit(true)
@storageStrategy("partition_by:user_time_created, cluster_by:user_group,primary_residence")
@sla("99.9%", "p95 < 200ms")
@crossFieldValidation("if wuser_flag_closed == true, time_closed must be set")
@crossFieldValidation("lifetime_revenue >= 0")
@tags(["core-entity", "high-volume", "real-time"])
@externalDocs("https://docs.company.com/data-models/user-profile")
@explanation(
  "The UserProfile entity is the central atomic unit for all user-related operations. " +
  "It combines data from multiple legacy source tables (WUSER, WUSER_ADDRESS, WUSER_NORM_ADDRESS, " +
  "WUSER_RISK_STATS) into a unified logical model. This entity supports GDPR/CCPA compliance " +
  "through embedded governance metadata and is optimized for high-volume transactional workloads."
)
model UserProfile {
  // ═══════════════════════════════════════════════════════════════════════
  // PRIMARY KEY
  // ═══════════════════════════════════════════════════════════════════════

  @key
  @doc("Primary key - unique user identifier")
  @dataClassification("INTERNAL")
  @dataSource("ALL.ACCOUNT_NUMBER")
  @minValue(1)
  @unique("global")
  @immutable("create")
  @qualityRule("must be positive integer")
  @sortable
  @filterable
  @readOnly
  @example("12345678")
  @testDataGenerator("sequence", "start=1000000")
  @version("1.0.0")
  @tags(["primary-key", "indexed"])
  account_number: int64;

  // ═══════════════════════════════════════════════════════════════════════
  // CORE USER INFORMATION (WUSER - 49 columns)
  // ═══════════════════════════════════════════════════════════════════════

  @doc("Account creation timestamp")
  @dataClassification("INTERNAL")
  @dataSource("WUSER.TIME_CREATED")
  @storageStrategy("partition_key")
  @readOnly
  @sortable
  @filterable
  @example("2024-01-15T10:30:00Z")
  @version("1.0.0")
  @tags(["audit", "partition-key"])
  user_time_created?: utcDateTime;

  @doc("User's first name")
  @dataClassification("PII")
  @anonymization("tokenize")
  @dataSource("WUSER.FIRST_NAME")
  @minLength(1)
  @maxLength(64)
  @pattern("^[a-zA-Z\\s'-]+$")
  @qualityRule("non-empty when present, alphabetic characters only with hyphens and apostrophes")
  @encryption("at-rest", "AES-256")
  @compliance("GDPR", "right to rectification")
  @compliance("CCPA", "consumer right to know")
  @audit("write", "7 years")
  @requiresPermission("users.read")
  @apiVisible(["v1", "v2"])
  @searchable(10)
  @mask("logs", "partial")
  @example("John")
  @examples(["John", "Mary", "José", "O'Brien"])
  @testDataGenerator("faker.name.firstName")
  @version("1.0.0")
  @tags(["pii", "searchable"])
  first_name?: string;

  @doc("User's last name")
  @dataClassification("PII")
  @anonymization("tokenize")
  @dataSource("WUSER.LAST_NAME")
  @minLength(1)
  @maxLength(64)
  @pattern("^[a-zA-Z\\s'-]+$")
  @qualityRule("non-empty when present, alphabetic characters only with hyphens and apostrophes")
  @encryption("at-rest", "AES-256")
  @compliance("GDPR", "right to rectification")
  @compliance("CCPA", "consumer right to know")
  @audit("write", "7 years")
  @requiresPermission("users.read")
  @apiVisible(["v1", "v2"])
  @searchable(10)
  @mask("logs", "partial")
  @example("Doe")
  @examples(["Doe", "Smith", "García", "O'Neill"])
  @testDataGenerator("faker.name.lastName")
  @version("1.0.0")
  @tags(["pii", "searchable"])
  last_name?: string;

  @doc("System flags bitfield (legacy)")
  @dataClassification("INTERNAL")
  @dataSource("WUSER.FLAGS")
  @deprecated("Use decomposed flag fields (wuser_flag_*) instead")
  @version("1.0.0", deprecated: "3.0.0")
  @breakingChange("4.0.0", "This field will be removed, use decomposed flags")
  @technicalDebt("Legacy bitfield should be fully decomposed", "JIRA-12345")
  @tags(["legacy", "deprecated"])
  user_flags?: int64;

  @doc("Last web login time")
  @dataClassification("INTERNAL")
  @dataSource("WUSER.LAST_WEB_ACCESS")
  @readOnly
  @sortable
  @filterable
  @example("2024-11-13T08:45:30Z")
  @version("1.0.0")
  @tags(["audit", "security"])
  user_last_web_access?: utcDateTime;

  @doc("Daytime phone number")
  @dataClassification("PII")
  @anonymization("mask")
  @dataSource("WUSER.DAY_PHONE")
  @maxLength(40)
  @format("phone")
  @pattern("^\\+?[1-9]\\d{1,14}$")
  @qualityRule("valid E.164 phone format")
  @encryption("at-rest", "AES-256")
  @compliance("GDPR", "right to erasure")
  @compliance("CCPA", "consumer right to know")
  @audit("all", "7 years")
  @requiresPermission("users.read")
  @mask("logs", "mask")
  @mask("export", "partial")
  @example("+14155552671")
  @examples(["+14155552671", "+442071838750", "+81312345678"])
  @testDataGenerator("faker.phone.number")
  @version("1.0.0")
  @tags(["pii", "contact"])
  day_phone?: string;

  @doc("Evening phone number")
  @dataClassification("PII")
  @anonymization("mask")
  @dataSource("WUSER.NIGHT_PHONE")
  @maxLength(40)
  @format("phone")
  @pattern("^\\+?[1-9]\\d{1,14}$")
  @qualityRule("valid E.164 phone format")
  @encryption("at-rest", "AES-256")
  @compliance("GDPR", "right to erasure")
  @compliance("CCPA", "consumer right to know")
  @audit("all", "7 years")
  @requiresPermission("users.read")
  @mask("logs", "mask")
  @mask("export", "partial")
  @example("+14155552672")
  @testDataGenerator("faker.phone.number")
  @version("1.0.0")
  @tags(["pii", "contact"])
  night_phone?: string;

  @doc("Reference to primary address")
  @dataClassification("INTERNAL")
  @dataSource("WUSER.ADDRESS_ID")
  @relationship("UserAddress", "ONE_TO_MANY")
  @filterable
  @version("1.0.0")
  @tags(["foreign-key"])
  address_id?: int64;

  @doc("Billing cycle number")
  @dataClassification("INTERNAL")
  @dataSource("WUSER.CYCLE_NUMBER")
  @minValue(1)
  @maxValue(31)
  @qualityRule("valid day of month (1-31)")
  @filterable
  @version("1.0.0")
  @tags(["billing"])
  cycle_number?: int64;

  @doc("Active transaction ID")
  @dataClassification("INTERNAL")
  @dataSource("WUSER.SERVER_CURRENT_TRANSACTION")
  @minValue(0)
  @readOnly
  @version("1.0.0")
  @tags(["transactional"])
  server_current_transaction?: int64;

  @doc("Credit charges amount")
  @dataClassification("FINANCIAL")
  @dataSource("WUSER.CREDIT_CHARGED")
  @precision(19, 4)
  @range(0, 999999999999999.9999)
  @qualityRule("non-negative, monetary value")
  @requiresPermission("finance.read")
  @sortable
  @filterable
  @example("125.50")
  @examples(["0.00", "125.50", "1500.00"])
  @testDataGenerator("random.decimal", "0,10000,2")
  @version("1.0.0")
  @tags(["financial", "monetary"])
  credit_charged?: decimal;

  @doc("Last cycle update time")
  @dataClassification("INTERNAL")
  @dataSource("WUSER.CYCLE_LAST_UPDATED")
  @readOnly
  @sortable
  @version("1.0.0")
  @tags(["audit"])
  cycle_last_updated?: utcDateTime;

  @doc("Confirmation error count")
  @dataClassification("INTERNAL")
  @dataSource("WUSER.CONFIRM_ERROR_COUNT")
  @minValue(0)
  @maxValue(1000)
  @qualityRule("non-negative integer, typically less than 10")
  @monitor("confirmation_errors", "> 5")
  @version("1.0.0")
  @tags(["quality", "monitoring"])
  confirm_error_count?: int64;

  @doc("Transaction limit amount")
  @dataClassification("FINANCIAL")
  @dataSource("WUSER.TRANSACTION_LIMIT")
  @precision(19, 4)
  @range(0, 999999999999999.9999)
  @qualityRule("non-negative, monetary value")
  @requiresPermission("finance.write")
  @filterable
  @example("5000.00")
  @examples(["100.00", "1000.00", "10000.00", "100000.00"])
  @defaultValue("1000.00")
  @explanation(
    "Daily transaction limit in USD. This is a soft limit that can be increased " +
    "by customer support or automatically after account verification. Different " +
    "user groups have different default limits."
  )
  @seeAlso(["user_group", "total_amount_sent"])
  @version("1.0.0")
  @tags(["financial", "limit"])
  transaction_limit?: decimal;

  @doc("Default credit card ID")
  @dataClassification("SENSITIVE")
  @dataSource("WUSER.DEFAULT_CC")
  @minValue(0)
  @encryption("at-rest", "AES-256")
  @compliance("PCI-DSS", "payment card data protection")
  @requiresPermission("payment.read")
  @version("1.0.0")
  @tags(["sensitive", "payment"])
  default_cc?: int64;

  @doc("Default ACH account ID")
  @dataClassification("SENSITIVE")
  @dataSource("WUSER.DEFAULT_ACH")
  @minValue(0)
  @encryption("at-rest", "AES-256")
  @compliance("PCI-DSS", "payment account data protection")
  @requiresPermission("payment.read")
  @version("1.0.0")
  @tags(["sensitive", "payment"])
  default_ach?: int64;

  @doc("User group classification")
  @dataClassification("INTERNAL")
  @dataSource("WUSER.USER_GROUP")
  @minValue(1)
  @maxValue(999)
  @storageStrategy("cluster_key")
  @filterable
  @sortable
  @example("100")
  @examples(["1", "50", "100", "500"])
  @explanation("User group determines access levels, transaction limits, and feature availability")
  @version("1.0.0")
  @tags(["classification", "cluster-key"])
  user_group?: int64;

  @doc("Primary email ID reference")
  @dataClassification("INTERNAL")
  @dataSource("WUSER.PRIMARY_EMAIL")
  @minValue(0)
  @version("1.0.0")
  @tags(["foreign-key"])
  primary_email?: int64;

  @doc("Lifetime sent amount")
  @dataClassification("FINANCIAL")
  @dataSource("WUSER.TOTAL_AMOUNT_SENT")
  @precision(19, 4)
  @range(0, 999999999999999.9999)
  @qualityRule("non-negative, monetary value")
  @readOnly
  @requiresPermission("finance.read")
  @sortable
  @filterable
  @example("15432.75")
  @testDataGenerator("random.decimal", "0,100000,2")
  @version("1.0.0")
  @tags(["financial", "metric"])
  total_amount_sent?: decimal;

  @doc("Authentication count")
  @dataClassification("INTERNAL")
  @dataSource("WUSER.AUTHENTICATIONS")
  @minValue(0)
  @qualityRule("non-negative integer")
  @readOnly
  @monitor("auth_count", "growth_rate")
  @version("1.0.0")
  @tags(["security", "metric"])
  authentications?: int64;

  @doc("Receiving preferences bitfield")
  @dataClassification("INTERNAL")
  @dataSource("WUSER.RECEIVING_PREFS")
  @version("1.0.0")
  @tags(["preferences"])
  receiving_prefs?: int64;

  @doc("Credit card receipts amount")
  @dataClassification("FINANCIAL")
  @dataSource("WUSER.CC_AMOUNT_RECEIVED")
  @precision(19, 4)
  @range(0, 999999999999999.9999)
  @qualityRule("non-negative, monetary value")
  @readOnly
  @requiresPermission("finance.read")
  @sortable
  @filterable
  @version("1.0.0")
  @tags(["financial", "metric"])
  cc_amount_received?: decimal;

  @doc("Last login IP address")
  @dataClassification("INTERNAL")
  @dataSource("WUSER.LAST_LOGIN_IP")
  @maxLength(45)
  @format("ipv4-or-ipv6")
  @pattern("^(?:(?:25[0-5]|2[0-4][0-9]|[01]?[0-9][0-9]?)\\.){3}(?:25[0-5]|2[0-4][0-9]|[01]?[0-9][0-9]?)$|^(?:[0-9a-fA-F]{1,4}:){7}[0-9a-fA-F]{1,4}$")
  @qualityRule("valid IPv4 or IPv6 address")
  @readOnly
  @filterable
  @example("192.168.1.1")
  @examples(["192.168.1.1", "10.0.0.1", "2001:0db8:85a3:0000:0000:8a2e:0370:7334"])
  @version("1.0.0")
  @tags(["security", "audit"])
  user_last_login_ip?: string;

  @doc("Citizenship information")
  @dataClassification("SENSITIVE")
  @anonymization("tokenize")
  @dataSource("WUSER.CITIZENSHIP")
  @maxLength(64)
  @qualityRule("valid country name or ISO code")
  @encryption("at-rest", "AES-256")
  @compliance("GDPR", "special category data")
  @audit("all", "10 years")
  @requiresPermission("sensitive.read")
  @mask("logs", "hash")
  @example("USA")
  @examples(["USA", "GBR", "CAN", "AUS"])
  @version("1.0.0")
  @tags(["sensitive", "pii"])
  citizenship?: string;

  @doc("Risk assessment score (0-100)")
  @dataClassification("INTERNAL")
  @dataSource("WUSER.FRAUD_SCORE")
  @precision(5, 2)
  @range(0, 100)
  @qualityRule("between 0 and 100")
  @mlDerived(
    "fraud_detection_v3",
    "3.2.1",
    ["transaction_velocity", "device_fingerprint", "behavioral_patterns", "historical_chargebacks"]
  )
  @freshness("real-time", "recalculate")
  @readOnly
  @requiresPermission("risk.read")
  @apiVisible(["internal-v1"])
  @sortable
  @filterable
  @example("42.75")
  @examples(["5.00", "25.50", "75.00", "95.00"])
  @testDataGenerator("random.uniform", "0,100")
  @qualityCheck("score_distribution", "hourly")
  @monitor("high_risk_accounts", "> 100 per hour")
  @explanation(
    "ML-generated risk score indicating fraud probability. Higher scores indicate " +
    "higher fraud risk. Scores above 80 trigger additional verification workflows. " +
    "Model is retrained weekly using latest fraud patterns."
  )
  @externalDocs("https://docs.company.com/risk-management/fraud-scoring")
  @seeAlso(["risk_stats_last_login_ip", "authentications"])
  @metadata("model_endpoint", "https://ml-api.company.com/fraud-score")
  @version("2.0.0")
  @tags(["ml-derived", "real-time", "risk", "kpi"])
  fraud_score?: decimal;

  @doc("Total revenue generated by customer")
  @dataClassification("FINANCIAL")
  @dataSource("WUSER.LIFETIME_REVENUE")
  @precision(19, 4)
  @range(0, 999999999999999.9999)
  @qualityRule("non-negative, monetary value")
  @calculated(
    "SUM(orders.total_amount WHERE orders.status = 'completed') - SUM(refunds.amount)",
    ["orders.total_amount", "orders.status", "refunds.amount"]
  )
  @freshness("24 hours", "use_cached")
  @lineage("CALCULATED.revenue_aggregations", "Daily batch aggregation from orders and refunds", "daily")
  @readOnly
  @requiresPermission("finance.read")
  @sortable
  @filterable
  @example("25432.10")
  @examples(["100.00", "1000.00", "10000.00", "100000.00"])
  @testDataGenerator("random.decimal", "0,100000,2")
  @qualityCheck("ltv_calculation_accuracy", "daily")
  @monitor("ltv_anomalies", "stddev > 3")
  @explanation(
    "Calculated as the sum of all completed order amounts minus refunds. " +
    "Refreshed daily via batch job at 2 AM UTC. Used for customer segmentation, " +
    "marketing campaigns, and credit limit decisions."
  )
  @seeAlso(["total_amount_sent", "volume_completed"])
  @performanceHint("Cached in Redis for 24 hours to reduce database load")
  @costEstimate("Low - calculated field, no direct storage cost")
  @accessFrequency("hot")
  @version("1.0.0", modified: "2.3.0")
  @tags(["calculated", "financial", "kpi", "cached"])
  lifetime_revenue?: decimal;

  @doc("Subprime risk indicator")
  @dataClassification("INTERNAL")
  @dataSource("WUSER.SUBPRIME")
  @precision(5, 2)
  @range(0, 100)
  @qualityRule("numeric risk value between 0 and 100")
  @requiresPermission("risk.read")
  @version("1.0.0")
  @tags(["risk"])
  subprime?: decimal;

  @doc("Additional system flags")
  @dataClassification("INTERNAL")
  @dataSource("WUSER.FLAGS2")
  @version("1.0.0")
  @tags(["system"])
  flags2?: int64;

  @doc("Autosweep target account identifier")
  @dataClassification("INTERNAL")
  @dataSource("WUSER.AUTOSWEEP_TARGET")
  @maxLength(30)
  @qualityRule("valid account identifier format")
  @version("1.0.0")
  @tags(["feature"])
  autosweep_target?: string;

  @doc("Account closure timestamp")
  @dataClassification("INTERNAL")
  @dataSource("WUSER.TIME_CLOSED")
  @readOnly
  @requiredIf("wuser_flag_closed == true")
  @sortable
  @filterable
  @version("1.0.0")
  @tags(["audit", "lifecycle"])
  time_closed?: utcDateTime;

  @doc("Withdrawable balance")
  @dataClassification("FINANCIAL")
  @dataSource("WUSER.WITHDRAW_BALANCE")
  @precision(19, 4)
  @range(-999999999999999.9999, 999999999999999.9999)
  @qualityRule("monetary value, can be negative for overdraft")
  @requiresPermission("finance.read")
  @sortable
  @filterable
  @example("1543.25")
  @examples(["-100.00", "0.00", "1543.25", "50000.00"])
  @version("1.0.0")
  @tags(["financial", "balance"])
  withdraw_balance?: decimal;

  @doc("Primary email address")
  @dataClassification("PII")
  @anonymization("hash")
  @dataSource("WUSER.PRIMARY_EMAIL_NAME")
  @minLength(5)
  @maxLength(127)
  @format("email")
  @pattern("^[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\\.[a-zA-Z]{2,}$")
  @unique("global")
  @immutable("create")
  @qualityRule("valid email format, globally unique")
  @storageStrategy("indexed")
  @lineage("CRM.users.email_address", "LOWER(TRIM(source.email_address))", "real-time-cdc")
  @freshness("real-time", "use_cached")
  @encryption("both", "AES-256")
  @compliance("GDPR", "right to erasure")
  @compliance("GDPR", "right to rectification")
  @compliance("CCPA", "consumer right to know")
  @compliance("CAN-SPAM", "unsubscribe mechanism")
  @audit("all", "7 years")
  @requiresPermission("users.read")
  @apiVisible(["v1", "v2"])
  @filterable
  @searchable(10)
  @mask("logs", "hash")
  @mask("export", "partial")
  @example("user@example.com")
  @examples(["john.doe@company.com", "jane_smith+test@example.org", "user123@domain.co.uk"])
  @testDataGenerator("faker.internet.email")
  @qualityCheck("email_format_validation", "daily")
  @qualityCheck("email_deliverability", "weekly")
  @monitor("invalid_email_rate", "< 0.1%")
  @monitor("bounce_rate", "< 5%")
  @explanation(
    "The email address is used for: authentication, password reset, transaction " +
    "notifications, marketing communications, and account recovery. Must be unique " +
    "across all users. Validated upon entry using third-party email verification service."
  )
  @warning("Changing email requires re-verification and may temporarily lock the account")
  @seeAlso(["primary_email", "authentications"])
  @externalDocs("https://docs.company.com/user-management/email-handling")
  @metadata("verification_service", "sendgrid_validate")
  @metadataMap(#{
    data_owner: "user_management_team",
    backup_frequency: "hourly",
    encryption_key_rotation: "90_days",
    geographic_scope: "global"
  })
  @version("1.0.0")
  @tags(["pii", "searchable", "unique", "authentication"])
  primary_email_name?: string;

  @doc("AFS classification type")
  @dataClassification("INTERNAL")
  @dataSource("WUSER.AFS_TYPE")
  @filterable
  @version("1.0.0")
  @tags(["classification"])
  afs_type?: AfsType;

  @doc("AFS identifier")
  @dataClassification("INTERNAL")
  @dataSource("WUSER.AFS_ID")
  @minValue(0)
  @version("1.0.0")
  @tags(["classification"])
  afs_id?: int64;

  @doc("AAC error count")
  @dataClassification("INTERNAL")
  @dataSource("WUSER.AAC_ERROR_COUNT")
  @minValue(0)
  @qualityRule("non-negative integer")
  @monitor("aac_errors", "> 10")
  @version("1.0.0")
  @tags(["quality", "monitoring"])
  aac_error_count?: int64;

  @doc("Extended system flags")
  @dataClassification("INTERNAL")
  @dataSource("WUSER.FLAGS3")
  @version("1.0.0")
  @tags(["system"])
  flags3?: int64;

  @doc("Completed transaction volume")
  @dataClassification("FINANCIAL")
  @dataSource("WUSER.VOLUME_COMPLETED")
  @precision(19, 4)
  @range(0, 999999999999999.9999)
  @qualityRule("non-negative, monetary value")
  @readOnly
  @requiresPermission("finance.read")
  @sortable
  @filterable
  @version("1.0.0")
  @tags(["financial", "metric"])
  volume_completed?: decimal;

  @doc("Completed plus pending volume")
  @dataClassification("FINANCIAL")
  @dataSource("WUSER.VOLUME_COMPLETED_PLUS_PENDING")
  @precision(19, 4)
  @range(0, 999999999999999.9999)
  @qualityRule("non-negative, monetary value, should be >= volume_completed")
  @readOnly
  @requiresPermission("finance.read")
  @sortable
  @filterable
  @version("1.0.0")
  @tags(["financial", "metric"])
  volume_completed_plus_pending?: decimal;

  @doc("Preferred language code (ISO 639)")
  @dataClassification("INTERNAL")
  @dataSource("WUSER.LANGUAGE")
  @minLength(2)
  @maxLength(5)
  @pattern("^[a-z]{2}(-[A-Z]{2})?$")
  @qualityRule("valid ISO 639-1 or ISO 639-1 with country code")
  @filterable
  @example("en-US")
  @examples(["en", "en-US", "es", "es-MX", "fr", "de", "ja", "zh-CN"])
  @defaultValue("en")
  @version("1.0.0")
  @tags(["locale", "i18n"])
  language?: string;

  @doc("Primary residence country (ISO 3166)")
  @dataClassification("INTERNAL")
  @dataSource("WUSER.PRIMARY_RESIDENCE")
  @fixedLength(2)
  @pattern("^[A-Z]{2}$")
  @qualityRule("valid ISO 3166-1 alpha-2 country code")
  @storageStrategy("cluster_key")
  @filterable
  @sortable
  @example("US")
  @examples(["US", "GB", "CA", "AU", "DE", "FR", "JP", "CN"])
  @version("1.0.0")
  @tags(["locale", "geo", "cluster-key"])
  primary_residence?: string;

  @doc("Account validation attempts")
  @dataClassification("INTERNAL")
  @dataSource("WUSER.VALIDATION_TRIES")
  @minValue(0)
  @maxValue(100)
  @qualityRule("non-negative integer, typically less than 10")
  @monitor("validation_failures", "> 5")
  @version("1.0.0")
  @tags(["security", "quality"])
  validation_tries?: int64;

  @doc("Latest system flags")
  @dataClassification("INTERNAL")
  @dataSource("WUSER.FLAGS4")
  @version("1.0.0")
  @tags(["system"])
  flags4?: int64;

  @doc("ACH deposit amounts")
  @dataClassification("FINANCIAL")
  @dataSource("WUSER.AMOUNT_ACH_DEPOSITED")
  @precision(19, 4)
  @range(0, 999999999999999.9999)
  @qualityRule("non-negative, monetary value")
  @requiresPermission("finance.read")
  @sortable
  @filterable
  @version("1.0.0")
  @tags(["financial", "metric"])
  amount_ach_deposited?: decimal;

  @doc("Manual risk override score")
  @dataClassification("INTERNAL")
  @dataSource("WUSER.CONTACT_SCORE_OVERRIDE")
  @precision(5, 2)
  @range(0, 100)
  @qualityRule("numeric risk value between 0 and 100")
  @requiresPermission("risk.write")
  @audit("write", "10 years")
  @explanation("Manually set by risk team to override automated fraud score")
  @version("1.0.0")
  @tags(["risk", "manual-override"])
  contact_score_override?: decimal;

  @doc("Account cloning state")
  @dataClassification("INTERNAL")
  @dataSource("WUSER.CLONE_STATE")
  @minValue(0)
  @version("1.0.0")
  @tags(["system"])
  clone_state?: int64;

  @doc("Credit card risk group")
  @dataClassification("INTERNAL")
  @dataSource("WUSER.CCRISK_CUTOFF_GROUP")
  @minValue(0)
  @filterable
  @version("1.0.0")
  @tags(["risk", "classification"])
  ccrisk_cutoff_group?: int64;

  @doc("Amount sent from balance")
  @dataClassification("FINANCIAL")
  @dataSource("WUSER.AMOUNT_SENT_FROM_BALANCE")
  @precision(19, 4)
  @range(0, 999999999999999.9999)
  @qualityRule("non-negative, monetary value")
  @requiresPermission("finance.read")
  @sortable
  @filterable
  @version("1.0.0")
  @tags(["financial", "metric"])
  amount_sent_from_balance?: decimal;

  @doc("Amount sent from unconfirmed funds")
  @dataClassification("FINANCIAL")
  @dataSource("WUSER.AMOUNT_SENT_FROM_UNCONFIRMED")
  @precision(19, 4)
  @range(0, 999999999999999.9999)
  @qualityRule("non-negative, monetary value")
  @requiresPermission("finance.read")
  @sortable
  @filterable
  @version("1.0.0")
  @tags(["financial", "metric"])
  amount_sent_from_unconfirmed?: decimal;

  @doc("User's timezone (IANA timezone)")
  @dataClassification("INTERNAL")
  @dataSource("WUSER.TIMEZONE")
  @maxLength(32)
  @pattern("^[A-Za-z_]+/[A-Za-z_]+$")
  @qualityRule("valid IANA timezone identifier")
  @example("America/New_York")
  @examples(["America/New_York", "America/Los_Angeles", "Europe/London", "Asia/Tokyo", "UTC"])
  @defaultValue("UTC")
  @externalDocs("https://www.iana.org/time-zones")
  @version("1.0.0", modified: "2.1.0")
  @renamedFrom(["user_tz", "timezone_string"])
  @tags(["locale", "time"])
  timezone?: string;

  // ═══════════════════════════════════════════════════════════════════════
  // RISK AND SECURITY INFORMATION (WUSER_RISK_STATS - 4 columns)
  // ═══════════════════════════════════════════════════════════════════════

  @doc("Last risk update time")
  @dataClassification("INTERNAL")
  @dataSource("WUSER_RISK_STATS.PYPL_TIME_TOUCHED")
  @readOnly
  @version("1.0.0")
  @tags(["audit", "risk"])
  risk_stats_pypl_time_touched?: utcDateTime;

  @doc("Last web access from risk tracking")
  @dataClassification("INTERNAL")
  @dataSource("WUSER_RISK_STATS.LAST_WEB_ACCESS")
  @readOnly
  @sortable
  @filterable
  @version("1.0.0")
  @tags(["audit", "risk"])
  risk_stats_last_web_access?: utcDateTime;

  @doc("Last login IP from risk tracking")
  @dataClassification("INTERNAL")
  @dataSource("WUSER_RISK_STATS.LAST_LOGIN_IP")
  @maxLength(45)
  @format("ipv4-or-ipv6")
  @qualityRule("valid IPv4 or IPv6 address")
  @readOnly
  @filterable
  @version("1.0.0")
  @tags(["security", "audit"])
  risk_stats_last_login_ip?: string;

  @doc("Last login session ID")
  @dataClassification("INTERNAL")
  @dataSource("WUSER_RISK_STATS.LAST_LOGIN_ID")
  @minValue(0)
  @readOnly
  @version("1.0.0")
  @tags(["security", "audit"])
  last_login_id?: int64;

  // ═══════════════════════════════════════════════════════════════════════
  // DECOMPOSED FLAGS (Bitfield extraction)
  // ═══════════════════════════════════════════════════════════════════════

  @doc("Account locked status flag")
  @dataClassification("INTERNAL")
  @dataSource("WUSER.FLAGS")
  @transformationLogic("Bit extraction from FLAGS field (bit 0)")
  @referenceDoc("https://github.paypal.com/Core-R/code/blob/master/biz/User/AccountFlags.h")
  @filterable
  @example("false")
  @defaultValue("false")
  @version("1.0.0")
  @tags(["flag", "security"])
  wuser_flag_locked: boolean;

  @doc("Address confirmed status flag")
  @dataClassification("INTERNAL")
  @dataSource("WUSER.FLAGS")
  @transformationLogic("Bit extraction from FLAGS field (bit 1)")
  @referenceDoc("https://github.paypal.com/Core-R/code/blob/master/biz/User/AccountFlags.h")
  @filterable
  @example("true")
  @defaultValue("false")
  @version("1.0.0")
  @tags(["flag", "verification"])
  wuser_flag_address_confirmed: boolean;

  @doc("Account closed status flag")
  @dataClassification("INTERNAL")
  @dataSource("WUSER.FLAGS")
  @transformationLogic("Bit extraction from FLAGS field (bit 2)")
  @referenceDoc("https://github.paypal.com/Core-R/code/blob/master/biz/User/AccountFlags.h")
  @filterable
  @example("false")
  @defaultValue("false")
  @version("1.0.0")
  @tags(["flag", "lifecycle"])
  wuser_flag_closed: boolean;

  // ═══════════════════════════════════════════════════════════════════════
  // GENERATED SYSTEM FIELDS
  // ═══════════════════════════════════════════════════════════════════════

  @doc("UUID for external references")
  @dataClassification("INTERNAL")
  @dataSource("GENERATED")
  @fixedLength(36)
  @format("uuid")
  @pattern("^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$")
  @unique("global")
  @immutable("create")
  @readOnly
  @example("550e8400-e29b-41d4-a716-446655440000")
  @testDataGenerator("faker.datatype.uuid")
  @version("1.0.0")
  @tags(["uuid", "generated"])
  user_profile_id?: string;

  @doc("Record creation time")
  @dataClassification("INTERNAL")
  @dataSource("GENERATED")
  @immutable("create")
  @readOnly
  @sortable
  @filterable
  @version("1.0.0")
  @tags(["audit", "generated"])
  row_created_time: utcDateTime;

  @doc("Record last modified time")
  @dataClassification("INTERNAL")
  @dataSource("GENERATED")
  @readOnly
  @sortable
  @filterable
  @version("1.0.0")
  @tags(["audit", "generated"])
  row_updated_time?: utcDateTime;
}

// ============================================================================
// INTERLEAVED ENTITY - USER ADDRESS
// ============================================================================

@doc("User address information stored as child entity")
@businessOwner("User Management Team")
@retentionPolicy("7 years after account closure")
@storageStrategy("interleaved_in_parent:UserProfile, on_delete_cascade")
@tags(["interleaved", "child-entity"])
@externalDocs("https://docs.company.com/data-models/user-address")
model UserAddress {
  @key
  @doc("Reference to parent user profile")
  @dataClassification("INTERNAL")
  @relationship("UserProfile", "MANY_TO_ONE")
  @immutable("create")
  @filterable
  @version("1.0.0")
  account_number: int64;

  @key
  @doc("Address identifier within user's addresses")
  @dataClassification("INTERNAL")
  @dataSource("WUSER_ADDRESS.ID")
  @minValue(1)
  @immutable("create")
  @sortable
  @version("1.0.0")
  address_id: int64;

  @doc("Address-specific flags")
  @dataClassification("INTERNAL")
  @dataSource("WUSER_ADDRESS.FLAGS")
  @version("1.0.0")
  address_flags?: int64;

  @doc("Address status code")
  @dataClassification("INTERNAL")
  @dataSource("WUSER_ADDRESS.STATUS")
  @filterable
  @example("A")
  @defaultValue("A")
  @version("1.0.0")
  status?: AddressStatus;

  @doc("Primary address line")
  @dataClassification("PII")
  @anonymization("tokenize")
  @dataSource("WUSER_ADDRESS.ADDRESS1")
  @minLength(1)
  @maxLength(300)
  @qualityRule("non-empty when present")
  @encryption("at-rest", "AES-256")
  @compliance("GDPR", "right to erasure")
  @audit("write", "7 years")
  @searchable(8)
  @mask("logs", "partial")
  @example("123 Main Street")
  @testDataGenerator("faker.address.streetAddress")
  @version("1.0.0")
  @tags(["pii", "address"])
  address1?: string;

  @doc("Secondary address line")
  @dataClassification("PII")
  @anonymization("tokenize")
  @dataSource("WUSER_ADDRESS.ADDRESS2")
  @maxLength(300)
  @encryption("at-rest", "AES-256")
  @compliance("GDPR", "right to erasure")
  @audit("write", "7 years")
  @mask("logs", "partial")
  @example("Apt 4B")
  @testDataGenerator("faker.address.secondaryAddress")
  @version("1.0.0")
  @tags(["pii", "address"])
  address2?: string;

  @doc("City name")
  @dataClassification("PII")
  @dataSource("WUSER_ADDRESS.CITY")
  @minLength(1)
  @maxLength(120)
  @qualityRule("non-empty when present")
  @filterable
  @searchable(5)
  @example("San Francisco")
  @testDataGenerator("faker.address.city")
  @version("1.0.0")
  @tags(["pii", "address", "geo"])
  address_city?: string;

  @doc("State or province")
  @dataClassification("PII")
  @dataSource("WUSER_ADDRESS.STATE")
  @maxLength(120)
  @filterable
  @example("CA")
  @testDataGenerator("faker.address.stateAbbr")
  @version("1.0.0")
  @tags(["pii", "address", "geo"])
  address_state?: string;

  @doc("Postal or ZIP code")
  @dataClassification("PII")
  @dataSource("WUSER_ADDRESS.ZIP")
  @lengthRange(5, 10)
  @pattern("^[0-9]{5}(-[0-9]{4})?$")
  @qualityRule("valid US ZIP code format")
  @filterable
  @example("94102")
  @examples(["94102", "94102-1234"])
  @testDataGenerator("faker.address.zipCode")
  @version("1.0.0")
  @tags(["pii", "address", "geo"])
  zip?: string;

  @doc("Country code (ISO 3166)")
  @dataClassification("INTERNAL")
  @dataSource("WUSER_ADDRESS.COUNTRY")
  @fixedLength(2)
  @pattern("^[A-Z]{2}$")
  @qualityRule("valid ISO 3166-1 alpha-2 country code")
  @filterable
  @example("US")
  @defaultValue("US")
  @version("1.0.0")
  @tags(["address", "geo"])
  address_country?: string;

  @doc("Address creation time")
  @dataClassification("INTERNAL")
  @dataSource("WUSER_ADDRESS.TIME_CREATED")
  @immutable("create")
  @readOnly
  @sortable
  @version("1.0.0")
  @tags(["audit"])
  address_time_created?: utcDateTime;

  @doc("Name on address")
  @dataClassification("PII")
  @anonymization("tokenize")
  @dataSource("WUSER_ADDRESS.ADDRESSEE_NAME")
  @maxLength(128)
  @encryption("at-rest", "AES-256")
  @compliance("GDPR", "right to erasure")
  @example("John Doe")
  @testDataGenerator("faker.name.fullName")
  @version("1.0.0")
  @tags(["pii", "address"])
  addressee_name?: string;

  @doc("Mail delivery error count")
  @dataClassification("INTERNAL")
  @dataSource("WUSER_ADDRESS.MAIL_ERROR_COUNT")
  @minValue(0)
  @qualityRule("non-negative integer")
  @monitor("mail_errors", "> 5")
  @version("1.0.0")
  @tags(["quality", "monitoring"])
  mail_error_count?: int64;

  @doc("Address type classification")
  @dataClassification("INTERNAL")
  @dataSource("WUSER_ADDRESS.TYPE")
  @filterable
  @example("R")
  @version("1.0.0")
  @tags(["classification"])
  type?: AddressType;

  @doc("eBay integration ID")
  @dataClassification("INTERNAL")
  @dataSource("WUSER_ADDRESS.EBAY_ID")
  @minValue(0)
  @version("1.0.0")
  @tags(["integration"])
  ebay_id?: int64;

  @doc("Row last updated time")
  @dataClassification("INTERNAL")
  @dataSource("WUSER_ADDRESS.TIME_ROW_UPDATED")
  @readOnly
  @sortable
  @version("1.0.0")
  @tags(["audit"])
  time_row_updated?: utcDateTime;

  @doc("Credit check timestamp")
  @dataClassification("INTERNAL")
  @dataSource("WUSER_ADDRESS.TIME_SET_CREDIT_CHECK")
  @readOnly
  @version("1.0.0")
  @tags(["audit", "credit"])
  time_set_credit_check?: utcDateTime;

  @doc("Version control field for optimistic locking")
  @dataClassification("INTERNAL")
  @dataSource("WUSER_ADDRESS.UPDATE_VERSION")
  @minValue(0)
  @readOnly
  @explanation("Incremented on each update for optimistic concurrency control")
  @version("1.0.0")
  @tags(["concurrency", "version"])
  update_version?: int64;
}

// ============================================================================
// INTERLEAVED ENTITY - NORMALIZED ADDRESS (JSON Storage)
// ============================================================================

@doc("Normalized address information stored as structured JSON")
@businessOwner("User Management Team")
@retentionPolicy("7 years after account closure")
@storageStrategy("interleaved_in_parent:UserAddress, json_column:normalized_data")
@tags(["interleaved", "json-storage"])
@externalDocs("https://docs.company.com/data-models/normalized-address")
@explanation(
  "Stores address validation and normalization data from third-party geocoding service. " +
  "Contains 38 fields stored as JSON to reduce schema complexity. Used for address " +
  "verification, deduplication, and geospatial queries."
)
model UserNormalizedAddress {
  @key
  @doc("Reference to parent user profile")
  @dataClassification("INTERNAL")
  @immutable("create")
  @version("1.0.0")
  account_number: int64;

  @key
  @doc("Reference to parent address")
  @dataClassification("INTERNAL")
  @relationship("UserAddress", "ONE_TO_ONE")
  @immutable("create")
  @version("1.0.0")
  user_address_id: int64;

  @key
  @doc("Normalized address ID")
  @dataClassification("INTERNAL")
  @dataSource("WUSER_NORM_ADDRESS.ID")
  @minValue(1)
  @immutable("create")
  @version("1.0.0")
  norm_address_id: int64;

  @doc("Complete normalized address data as structured JSON")
  @dataClassification("PII")
  @dataSource("WUSER_NORM_ADDRESS.*")
  @storageStrategy("json_type")
  @encryption("at-rest", "AES-256")
  @compliance("GDPR", "right to erasure")
  @performanceHint("Indexed on address_hash for deduplication queries")
  @costEstimate("~500 bytes average per record")
  @accessFrequency("warm")
  @version("1.0.0")
  @tags(["json", "pii", "normalized"])
  normalized_data: NormalizedAddressData;
}

@doc("Normalized address data structure (stored as JSON)")
@explanation(
  "Contains address validation results from geocoding service including standardized " +
  "address components, confidence scores, geographic coordinates, and error information."
)
model NormalizedAddressData {
  @doc("Number of addresses matching normalization")
  @dataSource("WUSER_NORM_ADDRESS.NUMBER_OF_MATCHES")
  @minValue(0)
  @maxValue(100)
  @version("1.0.0")
  number_of_matches?: int32;

  @doc("Whether address is deliverable")
  @dataSource("WUSER_NORM_ADDRESS.IS_DELIVERABLE_ADDRESS")
  @version("1.0.0")
  is_deliverable_address?: boolean;

  @doc("Address validation confidence (0-100)")
  @dataSource("WUSER_NORM_ADDRESS.CONFIDENCE_SCORE")
  @range(0, 100)
  @version("1.0.0")
  confidence_score?: float64;

  @doc("Normalized address type code")
  @dataSource("WUSER_NORM_ADDRESS.ADDRESS_TYPE")
  @maxLength(2)
  @version("1.0.0")
  address_type?: string;

  @doc("Normalized street number")
  @dataSource("WUSER_NORM_ADDRESS.STREET_NUMBER")
  @maxLength(30)
  @version("1.0.0")
  street_number?: string;

  @doc("Street directional prefix (N, S, E, W)")
  @dataSource("WUSER_NORM_ADDRESS.STREET_PREFIX")
  @maxLength(50)
  @version("1.0.0")
  street_prefix?: string;

  @doc("Street type suffix (St, Ave, Blvd)")
  @dataSource("WUSER_NORM_ADDRESS.STREET_POSTFIX")
  @maxLength(50)
  @version("1.0.0")
  street_postfix?: string;

  @doc("Normalized street name")
  @dataSource("WUSER_NORM_ADDRESS.STREET_NAME")
  @maxLength(300)
  @version("1.0.0")
  street_name?: string;

  @doc("Apartment or unit number")
  @dataSource("WUSER_NORM_ADDRESS.APARTMENT_NUMBER")
  @maxLength(30)
  @version("1.0.0")
  apartment_number?: string;

  @doc("Normalized city name")
  @dataSource("WUSER_NORM_ADDRESS.CITY")
  @maxLength(120)
  @version("1.0.0")
  norm_address_city?: string;

  @doc("County or district name")
  @dataSource("WUSER_NORM_ADDRESS.COUNTY")
  @maxLength(60)
  @version("1.0.0")
  county?: string;

  @doc("Normalized state or province")
  @dataSource("WUSER_NORM_ADDRESS.STATE")
  @maxLength(120)
  @version("1.0.0")
  norm_address_state?: string;

  @doc("First part of postal code")
  @dataSource("WUSER_NORM_ADDRESS.POSTAL_CODE_FIRST")
  @maxLength(60)
  @version("1.0.0")
  postal_code_first?: string;

  @doc("Extension part of postal code")
  @dataSource("WUSER_NORM_ADDRESS.POSTAL_CODE_LAST")
  @maxLength(60)
  @version("1.0.0")
  postal_code_last?: string;

  @doc("Normalized country code (ISO 3166)")
  @dataSource("WUSER_NORM_ADDRESS.COUNTRY")
  @fixedLength(2)
  @pattern("^[A-Z]{2}$")
  @version("1.0.0")
  norm_address_country?: string;

  @doc("Address hash for deduplication")
  @dataSource("WUSER_NORM_ADDRESS.ADDRESS_HASH")
  @maxLength(1024)
  @version("1.0.0")
  address_hash?: string;

  @doc("Normalization error code")
  @dataSource("WUSER_NORM_ADDRESS.ERROR_CODE")
  @maxLength(20)
  @version("1.0.0")
  error_code?: string;

  @doc("Normalization error description")
  @dataSource("WUSER_NORM_ADDRESS.ERROR_DESCRIPTION")
  @maxLength(256)
  @version("1.0.0")
  error_description?: string;

  @doc("Normalization timestamp")
  @dataSource("WUSER_NORM_ADDRESS.TIME_CREATED")
  @version("1.0.0")
  norm_address_time_created?: utcDateTime;

  @doc("Last normalization update time")
  @dataSource("WUSER_NORM_ADDRESS.PYPL_TIME_TOUCHED")
  @version("1.0.0")
  norm_address_pypl_time_touched?: utcDateTime;

  @doc("Unit type description")
  @dataSource("WUSER_NORM_ADDRESS.UNIT_DESCRIPTION")
  @maxLength(30)
  @version("1.0.0")
  unit_description?: string;

  @doc("Normalization process status")
  @dataSource("WUSER_NORM_ADDRESS.NORMALIZATION_STATUS")
  @maxLength(20)
  @version("1.0.0")
  normalization_status?: string;

  @doc("Geographic latitude coordinate")
  @dataSource("WUSER_NORM_ADDRESS.LATITUDE")
  @range(-90, 90)
  @version("1.0.0")
  latitude?: float64;

  @doc("Geographic longitude coordinate")
  @dataSource("WUSER_NORM_ADDRESS.LONGITUDE")
  @range(-180, 180)
  @version("1.0.0")
  longitude?: float64;

  @doc("Building type indicator")
  @dataSource("WUSER_NORM_ADDRESS.BUILDING_TYPE")
  @maxLength(1)
  @version("1.0.0")
  building_type?: string;

  @doc("64-bit address hash")
  @dataSource("WUSER_NORM_ADDRESS.ADDRESS_HASH_64")
  @maxLength(20)
  @version("1.0.0")
  address_hash_64?: string;

  @doc("API caller context information")
  @dataSource("WUSER_NORM_ADDRESS.CALLER_CONTEXT")
  @maxLength(50)
  @version("1.0.0")
  caller_context?: string;

  @doc("Match confidence level identifier")
  @dataSource("WUSER_NORM_ADDRESS.MATCH_LEVEL_TYPE_ID")
  @minValue(0)
  @version("1.0.0")
  match_level_type_id?: int32;

  @doc("Block-level geographic description")
  @dataSource("WUSER_NORM_ADDRESS.BLOCK_DESCRIPTION")
  @maxLength(18)
  @version("1.0.0")
  block_description?: string;

  @doc("Block number identifier")
  @dataSource("WUSER_NORM_ADDRESS.BLOCK_NUMBER")
  @maxLength(10)
  @version("1.0.0")
  block_number?: string;

  @doc("Input language code (ISO 639)")
  @dataSource("WUSER_NORM_ADDRESS.INPUT_LANGUAGE")
  @maxLength(5)
  @version("1.0.0")
  input_language?: string;

  @doc("Street hash value")
  @dataSource("WUSER_NORM_ADDRESS.STREET_HASH")
  @maxLength(20)
  @version("1.0.0")
  street_hash?: string;

  @doc("PO Box number")
  @dataSource("WUSER_NORM_ADDRESS.POSTAL_BOX_NUMBER")
  @maxLength(20)
  @version("1.0.0")
  postal_box_number?: string;

  @doc("Whether address is residential")
  @dataSource("WUSER_NORM_ADDRESS.IS_RESIDENTIAL")
  @version("1.0.0")
  is_residential?: boolean;

  @doc("Business name at address")
  @dataSource("WUSER_NORM_ADDRESS.BUSINESS_NAME")
  @maxLength(80)
  @version("1.0.0")
  business_name?: string;

  @doc("Formatted display address")
  @dataSource("WUSER_NORM_ADDRESS.DISPLAY_ADDRESS")
  @maxLength(365)
  @version("1.0.0")
  display_address?: string;
}

// ============================================================================
// API REQUEST/RESPONSE MODELS
// ============================================================================

@doc("Request to create a new user profile")
model CreateUserProfileRequest {
  @doc("User's first name")
  @minLength(1)
  @maxLength(64)
  first_name: string;

  @doc("User's last name")
  @minLength(1)
  @maxLength(64)
  last_name: string;

  @doc("Primary email address")
  @minLength(5)
  @maxLength(127)
  @format("email")
  primary_email_name: string;

  @doc("Daytime phone number")
  @maxLength(40)
  @format("phone")
  day_phone?: string;

  @doc("Evening phone number")
  @maxLength(40)
  @format("phone")
  night_phone?: string;

  @doc("Preferred language code (ISO 639)")
  @minLength(2)
  @maxLength(5)
  language?: string;

  @doc("Primary residence country (ISO 3166)")
  @fixedLength(2)
  primary_residence?: string;

  @doc("User's timezone (IANA timezone)")
  @maxLength(32)
  timezone?: string;

  @doc("Citizenship information")
  @maxLength(64)
  citizenship?: string;

  @doc("User group classification")
  @minValue(1)
  user_group?: int64;
}

@doc("Response after creating a user profile")
model CreateUserProfileResponse {
  @doc("Newly created account number")
  account_number: int64;

  @doc("UUID for external references")
  user_profile_id: string;

  @doc("Account creation timestamp")
  user_time_created: utcDateTime;

  @doc("User's first name")
  first_name: string;

  @doc("User's last name")
  last_name: string;

  @doc("Primary email address")
  primary_email_name: string;
}

@doc("Request to update user profile information")
model UpdateUserProfileRequest {
  @doc("User's first name")
  @minLength(1)
  @maxLength(64)
  first_name?: string;

  @doc("User's last name")
  @minLength(1)
  @maxLength(64)
  last_name?: string;

  @doc("Primary email address")
  @minLength(5)
  @maxLength(127)
  @format("email")
  primary_email_name?: string;

  @doc("Daytime phone number")
  @maxLength(40)
  @format("phone")
  day_phone?: string;

  @doc("Evening phone number")
  @maxLength(40)
  @format("phone")
  night_phone?: string;

  @doc("Preferred language code (ISO 639)")
  @minLength(2)
  @maxLength(5)
  language?: string;

  @doc("Primary residence country (ISO 3166)")
  @fixedLength(2)
  primary_residence?: string;

  @doc("User's timezone (IANA timezone)")
  @maxLength(32)
  timezone?: string;

  @doc("Transaction limit amount")
  @precision(19, 4)
  @range(0, 999999999999999.9999)
  transaction_limit?: decimal;
}

@doc("Partial user profile response (commonly requested fields)")
model UserProfileSummary {
  @doc("Unique user identifier")
  account_number: int64;

  @doc("UUID for external references")
  user_profile_id?: string;

  @doc("User's first name")
  first_name?: string;

  @doc("User's last name")
  last_name?: string;

  @doc("Primary email address")
  primary_email_name?: string;

  @doc("Daytime phone number")
  day_phone?: string;

  @doc("User group classification")
  user_group?: int64;

  @doc("Preferred language code")
  language?: string;

  @doc("Primary residence country")
  primary_residence?: string;

  @doc("Account creation timestamp")
  user_time_created?: utcDateTime;

  @doc("Last web login time")
  user_last_web_access?: utcDateTime;

  @doc("Account locked status")
  wuser_flag_locked: boolean;

  @doc("Account closed status")
  wuser_flag_closed: boolean;
}

@doc("Request to add a new address to user profile")
model CreateUserAddressRequest {
  @doc("Address type classification")
  type: AddressType;

  @doc("Primary address line")
  @minLength(1)
  @maxLength(300)
  address1: string;

  @doc("Secondary address line")
  @maxLength(300)
  address2?: string;

  @doc("City name")
  @minLength(1)
  @maxLength(120)
  address_city: string;

  @doc("State or province")
  @maxLength(120)
  address_state?: string;

  @doc("Postal or ZIP code")
  @lengthRange(5, 10)
  zip: string;

  @doc("Country code (ISO 3166)")
  @fixedLength(2)
  address_country: string;

  @doc("Name on address")
  @maxLength(128)
  addressee_name?: string;
}

@doc("Response after creating a user address")
model CreateUserAddressResponse {
  @doc("User account number")
  account_number: int64;

  @doc("Newly created address ID")
  address_id: int64;

  @doc("Address type")
  type: AddressType;

  @doc("Primary address line")
  address1: string;

  @doc("City name")
  address_city: string;

  @doc("Postal code")
  zip: string;

  @doc("Country code")
  address_country: string;

  @doc("Address creation timestamp")
  address_time_created: utcDateTime;
}

@doc("Request to update existing address")
model UpdateUserAddressRequest {
  @doc("Primary address line")
  @minLength(1)
  @maxLength(300)
  address1?: string;

  @doc("Secondary address line")
  @maxLength(300)
  address2?: string;

  @doc("City name")
  @minLength(1)
  @maxLength(120)
  address_city?: string;

  @doc("State or province")
  @maxLength(120)
  address_state?: string;

  @doc("Postal or ZIP code")
  @lengthRange(5, 10)
  zip?: string;

  @doc("Country code (ISO 3166)")
  @fixedLength(2)
  address_country?: string;

  @doc("Name on address")
  @maxLength(128)
  addressee_name?: string;

  @doc("Address status code")
  status?: AddressStatus;
}

@doc("Pagination parameters for list operations")
model PaginationParams {
  @query
  @doc("Page number (1-indexed)")
  @minValue(1)
  page?: int32 = 1;

  @query
  @doc("Number of items per page")
  @minValue(1)
  @maxValue(100)
  limit?: int32 = 20;
}

@doc("Pagination metadata in responses")
model PaginationMeta {
  @doc("Current page number")
  page: int32;

  @doc("Items per page")
  limit: int32;

  @doc("Total number of items")
  total: int64;

  @doc("Total number of pages")
  total_pages: int32;

  @doc("Whether there is a next page")
  has_next: boolean;

  @doc("Whether there is a previous page")
  has_prev: boolean;
}

@doc("Standard API response wrapper")
model ApiResponse<T> {
  @doc("Success status")
  success: boolean;

  @doc("Response data")
  data?: T;

  @doc("Error information if failed")
  error?: ErrorInfo;

  @doc("Response metadata")
  meta?: ResponseMeta;
}

@doc("Paginated API response wrapper")
model PaginatedResponse<T> {
  @doc("Success status")
  success: boolean;

  @doc("Response data")
  data?: T;

  @doc("Pagination information")
  pagination?: PaginationMeta;

  @doc("Error information if failed")
  error?: ErrorInfo;

  @doc("Response metadata")
  meta?: ResponseMeta;
}

@doc("Error information")
model ErrorInfo {
  @doc("Error code")
  code: string;

  @doc("Error message")
  message: string;

  @doc("Additional error details")
  details?: string;

  @doc("Field-specific validation errors")
  field_errors?: Record<string[]>;
}

@doc("Response metadata")
model ResponseMeta {
  @doc("Response timestamp")
  timestamp: utcDateTime;

  @doc("Request ID for tracing")
  request_id: string;

  @doc("API version")
  api_version: string;
}

// ============================================================================
// REST API OPERATIONS
// ============================================================================

@route("/users")
@tag("User Profile Management")
interface UserProfiles {
  @doc("Create a new user profile")
  @post
  @summary("Create User Profile")
  createUser(
    @body request: CreateUserProfileRequest
  ): {
    @statusCode statusCode: 201;
    @body body: ApiResponse<CreateUserProfileResponse>;
  } | {
    @statusCode statusCode: 400;
    @body body: ApiResponse<void>;
  } | {
    @statusCode statusCode: 409;
    @body body: ApiResponse<void>;
  };

  @doc("Get user profile by account number")
  @get
  @summary("Get User Profile")
  @route("/{accountNumber}")
  getUser(
    @path accountNumber: int64
  ): {
    @statusCode statusCode: 200;
    @body body: ApiResponse<UserProfile>;
  } | {
    @statusCode statusCode: 404;
    @body body: ApiResponse<void>;
  };

  @doc("Get user profile summary (commonly requested fields only)")
  @get
  @summary("Get User Summary")
  @route("/{accountNumber}/summary")
  getUserSummary(
    @path accountNumber: int64
  ): {
    @statusCode statusCode: 200;
    @body body: ApiResponse<UserProfileSummary>;
  } | {
    @statusCode statusCode: 404;
    @body body: ApiResponse<void>;
  };

  @doc("Update user profile information")
  @patch
  @summary("Update User Profile")
  @route("/{accountNumber}")
  updateUser(
    @path accountNumber: int64,
    @body request: UpdateUserProfileRequest
  ): {
    @statusCode statusCode: 200;
    @body body: ApiResponse<UserProfile>;
  } | {
    @statusCode statusCode: 400;
    @body body: ApiResponse<void>;
  } | {
    @statusCode statusCode: 404;
    @body body: ApiResponse<void>;
  };

  @doc("Delete user profile (soft delete)")
  @delete
  @summary("Delete User Profile")
  @route("/{accountNumber}")
  deleteUser(
    @path accountNumber: int64
  ): {
    @statusCode statusCode: 200;
    @body body: ApiResponse<{deleted: boolean, time_closed: utcDateTime}>;
  } | {
    @statusCode statusCode: 404;
    @body body: ApiResponse<void>;
  };

  @doc("List user profiles with pagination")
  @get
  @summary("List User Profiles")
  listUsers(
    ...PaginationParams,
    @query user_group?: int64,
    @query primary_residence?: string,
    @query language?: string
  ): {
    @statusCode statusCode: 200;
    @body body: PaginatedResponse<UserProfileSummary[]>;
  };

  @doc("Search users by email")
  @get
  @summary("Search Users by Email")
  @route("/search/by-email")
  searchByEmail(
    @query email: string
  ): {
    @statusCode statusCode: 200;
    @body body: ApiResponse<UserProfileSummary[]>;
  };
}

@route("/users/{accountNumber}/addresses")
@tag("User Address Management")
interface UserAddresses {
  @doc("Add a new address to user profile")
  @post
  @summary("Create User Address")
  createAddress(
    @path accountNumber: int64,
    @body request: CreateUserAddressRequest
  ): {
    @statusCode statusCode: 201;
    @body body: ApiResponse<CreateUserAddressResponse>;
  } | {
    @statusCode statusCode: 400;
    @body body: ApiResponse<void>;
  } | {
    @statusCode statusCode: 404;
    @body body: ApiResponse<void>;
  };

  @doc("Get all addresses for a user")
  @get
  @summary("List User Addresses")
  listAddresses(
    @path accountNumber: int64
  ): {
    @statusCode statusCode: 200;
    @body body: ApiResponse<UserAddress[]>;
  } | {
    @statusCode statusCode: 404;
    @body body: ApiResponse<void>;
  };

  @doc("Get specific address by ID")
  @get
  @summary("Get User Address")
  @route("/{addressId}")
  getAddress(
    @path accountNumber: int64,
    @path addressId: int64
  ): {
    @statusCode statusCode: 200;
    @body body: ApiResponse<UserAddress>;
  } | {
    @statusCode statusCode: 404;
    @body body: ApiResponse<void>;
  };

  @doc("Update existing address")
  @patch
  @summary("Update User Address")
  @route("/{addressId}")
  updateAddress(
    @path accountNumber: int64,
    @path addressId: int64,
    @body request: UpdateUserAddressRequest
  ): {
    @statusCode statusCode: 200;
    @body body: ApiResponse<UserAddress>;
  } | {
    @statusCode statusCode: 400;
    @body body: ApiResponse<void>;
  } | {
    @statusCode statusCode: 404;
    @body body: ApiResponse<void>;
  };

  @doc("Delete address")
  @delete
  @summary("Delete User Address")
  @route("/{addressId}")
  deleteAddress(
    @path accountNumber: int64,
    @path addressId: int64
  ): {
    @statusCode statusCode: 200;
    @body body: ApiResponse<{deleted: boolean}>;
  } | {
    @statusCode statusCode: 404;
    @body body: ApiResponse<void>;
  };

  @doc("Get normalized address data")
  @get
  @summary("Get Normalized Address")
  @route("/{addressId}/normalized")
  getNormalizedAddress(
    @path accountNumber: int64,
    @path addressId: int64
  ): {
    @statusCode statusCode: 200;
    @body body: ApiResponse<UserNormalizedAddress>;
  } | {
    @statusCode statusCode: 404;
    @body body: ApiResponse<void>;
  };
}