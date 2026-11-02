/**
 * The HTTP leg of a webhook delivery, with the destination policy (KD-027).
 *
 * An endpoint URL is registered by a platform administrator, but a delivery is started by whoever makes an emission or a governance decision
 * (any user with `entity.read` can), so the server must not be steered by the URL into its own network. The policy:
 * - `https:` only;
 * - the address the request CONNECTS to is checked, not only the URL's text: a hostname is resolved here, and every address it resolves to must
 *   be public. The check runs in the socket's `lookup`, so the address that is checked is the address that is dialled (no second resolution to
 *   rebind). An IP literal is checked the same way, before anything is connected;
 * - an address is public when it is IPv4 outside the non-public ranges, or IPv6 inside the global unicast range (2000::/3) outside its documentation
 *   and tunnelling sub-ranges. An IPv4-mapped (::ffff:a.b.c.d) or NAT64 (64:ff9b::/96) address is public when the IPv4 address it carries is;
 * - a redirect is not followed: a 3xx answer is a failed delivery;
 * - the URL is checked when an endpoint is created or its URL changed (`refuseEndpointUrl`), and again at every connection.
 *
 * Development only: `WEBHOOK_ALLOW_PRIVATE_TARGETS=true` lets a delivery reach `http:` and non-public addresses (a receiver on the developer's
 * machine). It is documented in docs/auth-ops.md and .env.example and is never set in production.
 *
 * The request is made with `node:https` (or `node:http` under that opt-out) rather than `fetch`, because `fetch` offers no hook on the connection.
 */

import dns from "node:dns";
import http from "node:http";
import https from "node:https";
import net from "node:net";

/** A refused destination (not https, not public). It is a delivery failure that a retry cannot fix. */
export class WebhookTargetError extends Error {}

/** The environment setting that lets a delivery reach http and non-public addresses (development only). */
export const PRIVATE_TARGETS_ENV = "WEBHOOK_ALLOW_PRIVATE_TARGETS";

/** True when the development opt-out is set: `true` or `1`, in any case, with surrounding space ignored. */
export function privateTargetsAllowed(env: Readonly<Record<string, string | undefined>> = process.env): boolean {
  return ["true", "1"].includes((env[PRIVATE_TARGETS_ENV] ?? "").trim().toLowerCase());
}

// Two lists: a BlockList applies an IPv6 rule to IPv4 addresses too (as IPv4-mapped), so the IPv4 ranges and the IPv6 ranges are kept apart.
const NON_PUBLIC_V4 = new net.BlockList();
for (const [address, prefix] of [
  ["0.0.0.0", 8],
  ["10.0.0.0", 8],
  ["100.64.0.0", 10],
  ["127.0.0.0", 8],
  ["169.254.0.0", 16],
  ["172.16.0.0", 12],
  ["192.0.0.0", 24],
  ["192.0.2.0", 24], // TEST-NET-1 (documentation)
  ["192.88.99.0", 24], // the deprecated 6to4 relay anycast range
  ["192.168.0.0", 16],
  ["198.18.0.0", 15],
  ["198.51.100.0", 24], // TEST-NET-2 (documentation)
  ["203.0.113.0", 24], // TEST-NET-3 (documentation)
  ["224.0.0.0", 4],
  ["240.0.0.0", 4],
] as const) {
  NON_PUBLIC_V4.addSubnet(address, prefix, "ipv4");
}

/**
 * The IPv6 ranges inside the global unicast range (2000::/3) that are not public: documentation, the 6to4 range and the IETF protocol block,
 * which holds Teredo (it carries an IPv4 address). Everything outside 2000::/3 is refused before this list is read (see isPublicAddress).
 */
const NON_PUBLIC_GLOBAL_V6 = new net.BlockList();
for (const [address, prefix] of [
  ["2001:db8::", 32], // documentation
  ["2001::", 23], // the IETF protocol assignments, Teredo (2001::/32) among them
  ["2002::", 16], // 6to4 (carries an IPv4 address)
] as const) {
  NON_PUBLIC_GLOBAL_V6.addSubnet(address, prefix, "ipv6");
}

/** The eight 16-bit groups of an IPv6 address, or null when it is not one. A dotted tail is read as two groups, as the URL parser writes it. */
function ipv6Groups(address: string): number[] | null {
  if (net.isIPv6(address) === false) return null;
  // The WHATWG URL parser writes every address in one canonical form (one "::", a dotted tail turned into hexadecimal groups).
  const canonical = new URL(`http://[${address}]/`).hostname.slice(1, -1);
  const [head, tail] = canonical.split("::");
  const groups = (text: string | undefined) => (text ? text.split(":").map((group) => parseInt(group, 16)) : []);
  if (tail === undefined) return groups(head);
  return [...groups(head), ...new Array<number>(8 - groups(head).length - groups(tail).length).fill(0), ...groups(tail)];
}

/** The dotted IPv4 address two 16-bit groups carry (the low 32 bits of a mapped or translated IPv6 address). */
const dottedOf = (high: number, low: number): string => `${high >> 8}.${high & 0xff}.${low >> 8}.${low & 0xff}`;

/** True for an address a delivery may connect to: an IP literal (v4 or v6) that is public (see the file's header). Anything else is refused. */
export function isPublicAddress(address: string): boolean {
  const bare = address.split("%")[0]; // a zone index (fe80::1%eth0) is not part of the address
  const family = net.isIP(bare);
  if (family === 0) return false;
  if (family === 4) return !NON_PUBLIC_V4.check(bare, "ipv4");
  const groups = ipv6Groups(bare);
  if (groups === null) return false;
  // An IPv4 address written as IPv6 (::ffff:a.b.c.d) is the IPv4 address: its own rules decide.
  if (groups.slice(0, 5).every((group) => group === 0) && groups[5] === 0xffff) return isPublicAddress(dottedOf(groups[6], groups[7]));
  // The NAT64 well-known prefix (64:ff9b::/96) translates to the IPv4 address it carries: a DNS64 answer for a public host is public.
  if (groups[0] === 0x64 && groups[1] === 0xff9b && groups.slice(2, 6).every((group) => group === 0)) return isPublicAddress(dottedOf(groups[6], groups[7]));
  // Only the global unicast range (2000::/3) is public. Everything else (loopback, unspecified, link-local, unique local, multicast, the
  // deprecated site-local range, the IPv4-compatible ::/96 range and every reserved prefix) is outside it.
  if (groups[0] >>> 13 !== 1) return false;
  return !NON_PUBLIC_GLOBAL_V6.check(bare, "ipv6");
}

type LookupCallback = (err: NodeJS.ErrnoException | null, address: string | dns.LookupAddress[], family?: number) => void;

/**
 * The `lookup` of the socket: resolves the hostname and answers only when every address is public. One refused address refuses the whole
 * name, so a name that answers with a public and a private address cannot be dialled at the private one.
 */
export function publicOnlyLookup(hostname: string, options: dns.LookupOptions, callback: LookupCallback): void {
  const fail = (error: NodeJS.ErrnoException) => callback(error, options.all ? [] : "", 0);
  dns.lookup(hostname, { all: true, family: options.family, hints: options.hints, verbatim: options.verbatim }, (error, addresses) => {
    if (error) return fail(error);
    const refused = addresses.find((entry) => !isPublicAddress(entry.address));
    if (refused) {
      return fail(Object.assign(new WebhookTargetError(`${hostname} resolves to a non-public address`), { code: "ERR_WEBHOOK_TARGET" }));
    }
    if (options.all) return callback(null, addresses);
    callback(null, addresses[0].address, addresses[0].family);
  });
}

/** The addresses a name resolves to, or null when it does not resolve (the caller decides what that means). */
function resolveAll(hostname: string): Promise<string[] | null> {
  return new Promise((resolve) => {
    dns.lookup(hostname, { all: true }, (error, addresses) => resolve(error ? null : addresses.map((entry) => entry.address)));
  });
}

/**
 * Why `target` may not be an endpoint's URL, or null when it may. Checked when an endpoint is created or its URL is changed, so that a refused URL
 * is answered at once; a delivery checks the URL again at every connection, so a name that later resolves to a non-public address is refused then.
 * A name that does not resolve is accepted: it may resolve when the endpoint is used, and a delivery records what happens then.
 */
export async function refuseEndpointUrl(target: string): Promise<string | null> {
  let url: URL;
  try {
    url = new URL(target);
  } catch {
    return "The endpoint URL is not a valid URL";
  }
  if (privateTargetsAllowed()) {
    return url.protocol === "http:" || url.protocol === "https:" ? null : "Only http and https endpoints are accepted";
  }
  if (url.protocol !== "https:") return "Only https endpoints are accepted";
  const host = url.hostname.replace(/^\[(.*)\]$/, "$1");
  if (net.isIP(host) !== 0) return isPublicAddress(host) ? null : `${host} is not a public address`;
  const addresses = await resolveAll(host);
  if (addresses === null) return null;
  const refused = addresses.find((address) => !isPublicAddress(address));
  return refused === undefined ? null : `${host} resolves to a non-public address (${refused})`;
}

export type WebhookRequest = {
  method: "POST";
  headers: Record<string, string>;
  body: string;
  signal?: AbortSignal;
};

/** The part of an answer the dispatcher reads: whether it is a success, and the status line. */
export type WebhookResponse = { ok: boolean; status: number; statusText: string };

/**
 * POSTs `request` to `target` under the destination policy. Resolves with the status of the answer (its body is discarded); rejects with a
 * `WebhookTargetError` for a refused destination, or with the network error otherwise.
 */
export function postWebhook(target: string, request: WebhookRequest): Promise<WebhookResponse> {
  return new Promise<WebhookResponse>((resolve, reject) => {
    let url: URL;
    try {
      url = new URL(target);
    } catch {
      reject(new WebhookTargetError("the endpoint URL is not a valid URL"));
      return;
    }
    const allowPrivate = privateTargetsAllowed();
    if (url.protocol !== "https:" && !(allowPrivate && url.protocol === "http:")) {
      reject(new WebhookTargetError("only https endpoints are called"));
      return;
    }
    // An IP literal is not looked up, so it is checked here; a name is checked by `publicOnlyLookup` when the socket opens.
    const host = url.hostname.replace(/^\[(.*)\]$/, "$1");
    if (!allowPrivate && net.isIP(host) !== 0 && !isPublicAddress(host)) {
      reject(new WebhookTargetError(`${host} is not a public address`));
      return;
    }

    const options = {
      method: request.method,
      headers: { ...request.headers, "Content-Length": Buffer.byteLength(request.body) },
      // The development opt-out keeps the resolver's own lookup; otherwise the address dialled is the one checked.
      ...(allowPrivate ? {} : { lookup: publicOnlyLookup }),
      signal: request.signal,
    };
    const onAnswer = (res: http.IncomingMessage) => {
      const status = res.statusCode ?? 0;
      res.resume(); // the body of an answer is not read
      resolve({ ok: status >= 200 && status < 300, status, statusText: res.statusMessage ?? "" });
    };
    const req = url.protocol === "http:" ? http.request(url, options, onAnswer) : https.request(url, options, onAnswer);
    req.on("error", reject);
    req.end(request.body);
  });
}
