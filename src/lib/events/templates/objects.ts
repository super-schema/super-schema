// src/lib/events/templates/objects.ts
// The AsyncAPI 3.0 object templates: every non-`x-` property of every object, with a label, a plain-language help,
// a kind and a group, so a form can offer the whole spec and the user only fills values (round-2 plan R2).
// Tested against `@asyncapi/specs` (tests/unit/lib/events/templates/objects.test.ts). Pure data — client-safe.
import type { FieldKind, FieldTemplate, ObjectTemplate, ObjectTemplateId, ReferenceTarget } from "./types";

type Extras = Partial<Omit<FieldTemplate, "key" | "label" | "kind" | "help" | "group">>;

/** `f(key, label, kind, group, help, extras)`; `required` always implies the basics group. */
function f(key: string, label: string, kind: FieldKind, group: FieldTemplate["group"], help: string, extras: Extras = {}): FieldTemplate {
  const { required, placeholder, example, options, suggestions, fields, default: fallback, refersTo, multiple, mapKeyLabel, when } = extras;
  return {
    key, label, kind,
    ...(required ? { required: true } : {}),
    help,
    ...(placeholder !== undefined ? { placeholder } : {}),
    ...(example !== undefined ? { example } : {}),
    ...(options ? { options } : {}),
    ...(suggestions ? { suggestions } : {}),
    ...(fields ? { fields } : {}),
    group: required ? "basics" : group,
    ...(fallback !== undefined ? { default: fallback } : {}),
    ...(refersTo ? { refersTo } : {}),
    ...(multiple ? { multiple: true } : {}),
    ...(mapKeyLabel ? { mapKeyLabel } : {}),
    ...(when ? { when } : {}),
  };
}

const ref = (key: string, label: string, group: FieldTemplate["group"], help: string, refersTo: ReferenceTarget, extras: Extras = {}) =>
  f(key, label, "reference", group, help, { ...extras, refersTo });

/** Protocols people put in `server.protocol` (the AsyncAPI registry plus the secure variants). */
const PROTOCOLS = [
  "kafka", "kafka-secure", "googlepubsub", "pulsar", "pulsar+ssl", "amqp", "amqps", "mqtt", "mqtts", "secure-mqtt", "nats", "redis",
  "sns", "sqs", "ws", "wss", "http", "https", "jms", "stomp", "stomps", "solace", "smf", "smfs", "ibmmq", "anypointmq", "mercure", "ros2",
];

const CONTENT_TYPES = [
  "application/json", "application/avro", "avro/binary", "application/vnd.apache.avro+json", "application/vnd.apache.avro+binary",
  "application/x-protobuf", "application/protobuf", "application/cloudevents+json", "application/xml", "application/octet-stream",
  "application/x-www-form-urlencoded", "text/plain", "text/csv",
];

// --- Leaf objects ---------------------------------------------------------------------------------------------

const CONTACT_FIELDS: FieldTemplate[] = [
  f("name", "Name", "text", "basics", "The person, team or organisation to contact.", { placeholder: "API Support" }),
  f("url", "Contact page", "url", "basics", "A web page with contact information.", { placeholder: "https://www.example.com/support" }),
  f("email", "Email address", "email", "basics", "An email address for questions about this API.", { placeholder: "support@example.com" }),
];

const LICENSE_FIELDS: FieldTemplate[] = [
  f("name", "License name", "text", "basics", "The license the API is offered under. An open-source license is encouraged.", {
    required: true, placeholder: "Apache 2.0", suggestions: ["Apache 2.0", "MIT", "BSD-3-Clause", "GPL-3.0", "MPL-2.0", "Proprietary"],
  }),
  f("url", "License link", "url", "basics", "A web page with the license text.", { placeholder: "https://www.apache.org/licenses/LICENSE-2.0.html" }),
];

const EXTERNAL_DOCS_FIELDS: FieldTemplate[] = [
  f("url", "Link", "url", "basics", "Where the extra documentation lives. Must be an absolute URL.", { required: true, placeholder: "https://example.com/docs" }),
  f("description", "Description", "markdown", "basics", "What the reader finds at the link. Markdown is allowed.", { placeholder: "Find more info here" }),
];

const TAG_FIELDS: FieldTemplate[] = [
  f("name", "Tag", "text", "basics", "The tag itself, for example a team, domain or lifecycle stage.", { required: true, placeholder: "e-commerce" }),
  f("description", "Description", "markdown", "basics", "A short explanation of what the tag means. Markdown is allowed."),
  f("externalDocs", "External documentation", "object", "more", "A link with more detail about this tag.", { fields: EXTERNAL_DOCS_FIELDS }),
];

const tagsField = (help: string) => f("tags", "Tags", "tags", "more", help, { fields: TAG_FIELDS });
const externalDocsField = (help: string) => f("externalDocs", "External documentation", "object", "more", help, { fields: EXTERNAL_DOCS_FIELDS });
const bindingsField = (what: string) =>
  f("bindings", "Protocol bindings", "json", "more", `Protocol-specific settings for ${what}, keyed by protocol (kafka, mqtt, ...). Use the protocol template to fill them in as a form.`);

const SERVER_VARIABLE_FIELDS: FieldTemplate[] = [
  f("enum", "Allowed values", "stringList", "basics", "Limit the variable to this set of values. Leave empty to allow any value.", { placeholder: "production" }),
  f("default", "Default value", "text", "basics", "The value used when none is supplied."),
  f("description", "Description", "markdown", "basics", "What the variable stands for. Markdown is allowed."),
  f("examples", "Examples", "stringList", "more", "Example values for the variable."),
];

const RUNTIME_LOCATIONS = ["$message.header#/", "$message.payload#/"];

const CHANNEL_PARAMETER_FIELDS: FieldTemplate[] = [
  f("description", "Description", "markdown", "basics", "What the parameter stands for, ideally with an example of use. Markdown is allowed."),
  f("enum", "Allowed values", "stringList", "basics", "Limit the parameter to this set of values. Leave empty to allow any value."),
  f("default", "Default value", "text", "basics", "The value used when none is supplied."),
  f("examples", "Examples", "stringList", "more", "Example values for the parameter."),
  f("location", "Where to find the value", "text", "more", "A runtime expression saying where in the message the value is carried.", {
    placeholder: "$message.payload#/user/id", suggestions: RUNTIME_LOCATIONS,
  }),
];

const CORRELATION_ID_FIELDS: FieldTemplate[] = [
  f("location", "Where to find it", "text", "basics", "A runtime expression saying where in the message the correlation ID is carried.", {
    required: true, placeholder: "$message.header#/correlationId", suggestions: ["$message.header#/correlationId", "$message.payload#/correlationId"],
  }),
  f("description", "Description", "markdown", "basics", "What the correlation ID is used for. Markdown is allowed."),
];

const REPLY_ADDRESS_FIELDS: FieldTemplate[] = [
  f("location", "Where to find the address", "text", "basics", "A runtime expression saying where in the request the reply address is carried.", {
    required: true, placeholder: "$message.header#/replyTo", suggestions: ["$message.header#/replyTo", "$message.payload#/replyTo"],
  }),
  f("description", "Description", "markdown", "basics", "What the address is for. Markdown is allowed."),
];

const MESSAGE_EXAMPLE_FIELDS: FieldTemplate[] = [
  f("name", "Name", "text", "basics", "A short machine-readable name for the example.", { placeholder: "order-created" }),
  f("summary", "Summary", "text", "basics", "One line saying what the example shows."),
  f("headers", "Headers", "json", "basics", "Example application headers, as a JSON object of names and values.", { placeholder: '{ "traceId": "abc-123" }' }),
  f("payload", "Payload", "json", "basics", "An example payload. Any JSON value is allowed.", { placeholder: '{ "orderId": "o-1" }' }),
];

// --- Security schemes -----------------------------------------------------------------------------------------

const SECURITY_TYPES: Array<{ value: string; label: string; help: string }> = [
  { value: "userPassword", label: "User and password", help: "A user name and a password." },
  { value: "apiKey", label: "API key", help: "An API key sent as the user or the password." },
  { value: "X509", label: "X.509 certificate", help: "A client certificate." },
  { value: "symmetricEncryption", label: "Symmetric encryption", help: "A shared secret key used for encryption." },
  { value: "asymmetricEncryption", label: "Asymmetric encryption", help: "A public and private key pair used for encryption." },
  { value: "httpApiKey", label: "HTTP API key", help: "An API key sent in an HTTP header, query parameter or cookie." },
  { value: "http", label: "HTTP authentication", help: "HTTP authentication such as basic, digest or bearer tokens." },
  { value: "oauth2", label: "OAuth 2.0", help: "OAuth 2.0 with one or more flows." },
  { value: "openIdConnect", label: "OpenID Connect", help: "OpenID Connect discovery." },
  { value: "plain", label: "SASL PLAIN", help: "SASL PLAIN user name and password." },
  { value: "scramSha256", label: "SASL SCRAM-SHA-256", help: "SASL SCRAM with SHA-256." },
  { value: "scramSha512", label: "SASL SCRAM-SHA-512", help: "SASL SCRAM with SHA-512." },
  { value: "gssapi", label: "SASL GSSAPI (Kerberos)", help: "SASL GSSAPI, usually Kerberos." },
];

const SCOPE_MAP_HELP = "The scopes this flow offers: the scope name and a short description of what it allows.";
const flowFields = (...include: Array<"authorizationUrl" | "tokenUrl">): FieldTemplate[] => [
  ...(include.includes("authorizationUrl")
    ? [f("authorizationUrl", "Authorization URL", "url", "basics", "Where users are sent to authorize. Must be an absolute URL.", { required: true, placeholder: "https://example.com/oauth/authorize" })]
    : []),
  ...(include.includes("tokenUrl")
    ? [f("tokenUrl", "Token URL", "url", "basics", "Where tokens are requested. Must be an absolute URL.", { required: true, placeholder: "https://example.com/oauth/token" })]
    : []),
  f("refreshUrl", "Refresh URL", "url", "more", "Where refresh tokens are obtained. Must be an absolute URL."),
  f("availableScopes", "Available scopes", "keyValue", "basics", SCOPE_MAP_HELP, { required: true }),
];

const OAUTH2_FLOWS: FieldTemplate[] = [
  f("implicit", "Implicit flow", "object", "more", "The OAuth 2.0 implicit flow.", { fields: flowFields("authorizationUrl") }),
  f("password", "Password flow", "object", "more", "The OAuth 2.0 resource owner password flow.", { fields: flowFields("tokenUrl") }),
  f("clientCredentials", "Client credentials flow", "object", "more", "The OAuth 2.0 client credentials flow.", { fields: flowFields("tokenUrl") }),
  f("authorizationCode", "Authorization code flow", "object", "more", "The OAuth 2.0 authorization code flow.", { fields: flowFields("authorizationUrl", "tokenUrl") }),
];

const SECURITY_SCHEME_FIELDS: FieldTemplate[] = [
  f("type", "Type", "enum", "basics", "How clients authenticate. The fields below change with the type.", { required: true, options: SECURITY_TYPES }),
  f("description", "Description", "markdown", "basics", "A short description of the scheme. Markdown is allowed."),
  f("name", "Parameter name", "text", "basics", "The name of the header, query parameter or cookie that carries the key.", {
    required: true, placeholder: "X-API-Key", when: { field: "type", oneOf: ["httpApiKey"] },
  }),
  f("in", "Where the key goes", "enum", "basics", "Where the API key is carried. User and password are for the API key type; header, query and cookie are for the HTTP API key type.", {
    required: true, when: { field: "type", oneOf: ["apiKey", "httpApiKey"] },
    options: [
      { value: "user", label: "User", help: "API key type: the key is sent as the user." },
      { value: "password", label: "Password", help: "API key type: the key is sent as the password." },
      { value: "header", label: "Header", help: "HTTP API key type: sent in a request header." },
      { value: "query", label: "Query parameter", help: "HTTP API key type: sent in the URL query string." },
      { value: "cookie", label: "Cookie", help: "HTTP API key type: sent in a cookie." },
    ],
  }),
  f("scheme", "HTTP scheme", "text", "basics", "The authorization scheme used in the Authorization header (RFC 7235).", {
    required: true, placeholder: "bearer", suggestions: ["bearer", "basic", "digest"], when: { field: "type", oneOf: ["http"] },
  }),
  f("bearerFormat", "Bearer token format", "text", "more", "A hint about how bearer tokens are formatted, for example JWT.", {
    placeholder: "JWT", suggestions: ["JWT"], when: { field: "type", oneOf: ["http"] },
  }),
  f("flows", "OAuth flows", "object", "basics", "The OAuth 2.0 flows this scheme supports.", { required: true, fields: OAUTH2_FLOWS, when: { field: "type", oneOf: ["oauth2"] } }),
  f("scopes", "Required scopes", "stringList", "more", "The scope names the API needs. An empty list means no scopes are needed.", { when: { field: "type", oneOf: ["oauth2", "openIdConnect"] } }),
  f("openIdConnectUrl", "Discovery URL", "url", "basics", "The OpenID Connect URL used to discover the OAuth 2.0 configuration. Must be an absolute URL.", {
    required: true, placeholder: "https://example.com/.well-known/openid-configuration", when: { field: "type", oneOf: ["openIdConnect"] },
  }),
];

// --- Document parts -------------------------------------------------------------------------------------------

const INFO_FIELDS: FieldTemplate[] = [
  f("title", "Title", "text", "basics", "A short, precise name for the API.", { required: true, placeholder: "Orders events" }),
  f("description", "Description", "markdown", "basics", "What the API is for, in a few paragraphs. Markdown is allowed."),
  f("termsOfService", "Terms of service", "url", "more", "A link to the terms of service. Must be a URL.", { placeholder: "https://example.com/terms" }),
  f("contact", "Contact", "object", "more", "Who to ask about this API.", { fields: CONTACT_FIELDS }),
  f("license", "License", "object", "more", "The license the API is offered under.", { fields: LICENSE_FIELDS }),
  tagsField("Tags that group and describe the API in documentation."),
  externalDocsField("A link to more documentation about the API."),
];

const SERVER_FIELDS: FieldTemplate[] = [
  f("host", "Host", "text", "basics", "The server host name, with a port if needed. Write {name} to insert a server variable.", { required: true, placeholder: "kafka.example.com:9092" }),
  f("protocol", "Protocol", "text", "basics", "The protocol clients use to connect.", { required: true, placeholder: "kafka", suggestions: PROTOCOLS }),
  f("protocolVersion", "Protocol version", "text", "basics", "The version of the protocol the server speaks.", { placeholder: "3.2" }),
  f("pathname", "Path", "text", "basics", "A path to a resource on the host, for example /production. Variables in {braces} work here too.", { placeholder: "/production" }),
  f("title", "Title", "text", "basics", "A friendly name for the server.", { placeholder: "Production Kafka" }),
  f("summary", "Summary", "text", "more", "A one-line summary of the server."),
  f("description", "Description", "markdown", "basics", "What the server is and when to use it. Markdown is allowed."),
  f("variables", "Variables", "list", "more", "Placeholders written as {name} in the host or path, with their allowed and default values.", { fields: SERVER_VARIABLE_FIELDS, mapKeyLabel: "Variable name" }),
  ref("security", "Security", "more", "The security schemes clients can use to connect. Any one of them is enough.", "securityScheme", { multiple: true }),
  tagsField("Tags that group the server in documentation."),
  externalDocsField("A link to more documentation about the server."),
  bindingsField("this server"),
];

const CHANNEL_FIELDS: FieldTemplate[] = [
  f("address", "Address", "text", "basics", "The topic name, routing key, event type or path. Leave empty when it is only known at runtime. Write {name} for a parameter.", {
    placeholder: "orders.created", example: "user/{userId}/signedup",
  }),
  f("title", "Title", "text", "basics", "A friendly name for the channel."),
  f("summary", "Summary", "text", "basics", "A one-line summary of the channel."),
  f("description", "Description", "markdown", "basics", "What flows through the channel. Markdown is allowed."),
  ref("servers", "Servers", "basics", "The servers this channel is available on. Leave empty to offer it on every server.", "server", { multiple: true }),
  f("parameters", "Parameters", "list", "basics", "Values written as {name} in the address, with their allowed and default values.", { fields: CHANNEL_PARAMETER_FIELDS, mapKeyLabel: "Parameter name" }),
  ref("messages", "Messages", "basics", "The messages that can travel on this channel. Each message sent here must match exactly one of them.", "message", { multiple: true }),
  tagsField("Tags that group the channel in documentation."),
  externalDocsField("A link to more documentation about the channel."),
  bindingsField("this channel"),
];

const OPERATION_REPLY_FIELDS: FieldTemplate[] = [
  f("address", "Reply address", "object", "basics", "Where the reply is sent, when that is carried in the request.", { fields: REPLY_ADDRESS_FIELDS }),
  ref("channel", "Reply channel", "basics", "The channel the reply is sent on.", "channel"),
  ref("messages", "Reply messages", "basics", "The messages that can be sent as the reply. They must be a subset of the reply channel's messages.", "message", { multiple: true }),
];

const OPERATION_FIELDS: FieldTemplate[] = [
  f("action", "Action", "enum", "basics", "Send when this application publishes to the channel; receive when it consumes from it.", {
    required: true,
    options: [
      { value: "send", label: "Send", help: "The application sends messages to the channel." },
      { value: "receive", label: "Receive", help: "The application receives messages from the channel." },
    ],
  }),
  ref("channel", "Channel", "basics", "The channel this operation works on.", "channel", { required: true }),
  f("title", "Title", "text", "basics", "A friendly name for the operation."),
  f("summary", "Summary", "text", "basics", "A one-line summary of the operation."),
  f("description", "Description", "markdown", "basics", "What the operation does. Markdown is allowed."),
  ref("messages", "Messages", "basics", "The messages this operation handles. They must be a subset of the channel's messages.", "message", { multiple: true }),
  f("reply", "Reply", "object", "more", "The reply to this operation, for request-and-reply patterns.", { fields: OPERATION_REPLY_FIELDS }),
  ref("traits", "Traits", "more", "Reusable operation traits applied to this operation.", "operationTrait", { multiple: true }),
  ref("security", "Security", "more", "The security schemes that protect this operation. Any one of them is enough.", "securityScheme", { multiple: true }),
  tagsField("Tags that group the operation in documentation."),
  externalDocsField("A link to more documentation about the operation."),
  bindingsField("this operation"),
];

const OPERATION_TRAIT_FIELDS: FieldTemplate[] = [
  f("title", "Title", "text", "basics", "A friendly name for the operation."),
  f("summary", "Summary", "text", "basics", "A one-line summary of the operation."),
  f("description", "Description", "markdown", "basics", "What the operation does. Markdown is allowed."),
  ref("security", "Security", "more", "The security schemes that protect operations using this trait. Any one of them is enough.", "securityScheme", { multiple: true }),
  tagsField("Tags that group operations using this trait."),
  externalDocsField("A link to more documentation for operations using this trait."),
  bindingsField("operations using this trait"),
];

/** The fields a message and a message trait share (the spec's message trait is a message minus payload and traits). */
const messageCommonFields = (): FieldTemplate[] => [
  f("name", "Name", "text", "basics", "The message's name.", { placeholder: "OrderCreated" }),
  f("title", "Title", "text", "basics", "A friendly title for the message."),
  f("summary", "Summary", "text", "basics", "A one-line summary of the message."),
  f("description", "Description", "markdown", "basics", "What the message means and when it is sent. Markdown is allowed."),
  f("contentType", "Content type", "text", "basics", "How the payload is encoded. Leave empty to use the document's default content type.", {
    placeholder: "application/json", suggestions: CONTENT_TYPES,
  }),
  f("correlationId", "Correlation ID", "object", "basics", "Where in the message a value that ties requests and replies together is carried.", { fields: CORRELATION_ID_FIELDS }),
  f("examples", "Examples", "list", "basics", "Example messages, shown in the documentation.", { fields: MESSAGE_EXAMPLE_FIELDS }),
  tagsField("Tags that group the message in documentation."),
  externalDocsField("A link to more documentation about the message."),
  f("deprecated", "Deprecated", "boolean", "more", "Turn on to mark the message as deprecated.", { default: false }),
  bindingsField("this message"),
];

const MESSAGE_FIELDS: FieldTemplate[] = (() => {
  const common = messageCommonFields();
  const pick = (key: string) => common.find((c) => c.key === key)!;
  return [
    pick("name"), pick("title"), pick("summary"), pick("description"), pick("contentType"),
    f("payload", "Payload", "entityPin", "basics", "The entity (and version) that describes the message body.", { required: true }),
    f("headers", "Headers", "entityPin", "more", "An entity (and version) that describes the message's application headers."),
    f("keyPin", "Message key", "entityPin", "more", "An entity (and version) that describes the message key; it is emitted into the Kafka message binding."),
    pick("correlationId"), pick("examples"), pick("tags"), pick("externalDocs"), pick("deprecated"), pick("bindings"),
    ref("traits", "Traits", "more", "Reusable message traits applied to this message.", "messageTrait", { multiple: true }),
  ];
})();

const MESSAGE_TRAIT_FIELDS: FieldTemplate[] = (() => {
  const common = messageCommonFields();
  const pick = (key: string) => common.find((c) => c.key === key)!;
  return [
    pick("name"), pick("title"), pick("summary"), pick("description"), pick("contentType"),
    f("headers", "Headers", "entityPin", "more", "An entity (and version) that describes the application headers of messages using this trait."),
    pick("correlationId"), pick("examples"), pick("tags"), pick("externalDocs"), pick("deprecated"), pick("bindings"),
  ];
})();

const template = (id: ObjectTemplateId, label: string, fields: FieldTemplate[]): ObjectTemplate => ({ id, label, fields });

export const TEMPLATES: Record<ObjectTemplateId, ObjectTemplate> = {
  info: template("info", "API information", INFO_FIELDS),
  contact: template("contact", "Contact", CONTACT_FIELDS),
  license: template("license", "License", LICENSE_FIELDS),
  externalDocs: template("externalDocs", "External documentation", EXTERNAL_DOCS_FIELDS),
  tag: template("tag", "Tag", TAG_FIELDS),
  server: template("server", "Server", SERVER_FIELDS),
  serverVariable: template("serverVariable", "Server variable", SERVER_VARIABLE_FIELDS),
  channel: template("channel", "Channel", CHANNEL_FIELDS),
  channelParameter: template("channelParameter", "Channel parameter", CHANNEL_PARAMETER_FIELDS),
  operation: template("operation", "Operation", OPERATION_FIELDS),
  operationReply: template("operationReply", "Operation reply", OPERATION_REPLY_FIELDS),
  operationReplyAddress: template("operationReplyAddress", "Reply address", REPLY_ADDRESS_FIELDS),
  operationTrait: template("operationTrait", "Operation trait", OPERATION_TRAIT_FIELDS),
  message: template("message", "Message", MESSAGE_FIELDS),
  messageTrait: template("messageTrait", "Message trait", MESSAGE_TRAIT_FIELDS),
  messageExample: template("messageExample", "Message example", MESSAGE_EXAMPLE_FIELDS),
  correlationId: template("correlationId", "Correlation ID", CORRELATION_ID_FIELDS),
  securityScheme: template("securityScheme", "Security scheme", SECURITY_SCHEME_FIELDS),
};
