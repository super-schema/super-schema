// @vitest-environment node
/**
 * The destination policy of a webhook delivery (KD-027): which addresses may be dialled, and that a refused destination is refused before any
 * connection is made. The addresses are literals or `localhost` (no network is used); the lookup of a name is driven through a stand-in resolver.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import http from "node:http";
import https from "node:https";

// The resolver is a stand-in whose default is the real one (so `localhost` resolves locally); each test may replace it.
const dns = vi.hoisted(() => ({ lookup: vi.fn(), real: undefined as unknown as (...args: unknown[]) => unknown }));
vi.mock("node:dns", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:dns")>();
  dns.real = actual.lookup as never;
  return { ...actual, default: { ...actual, lookup: dns.lookup }, lookup: dns.lookup };
});

import { isPublicAddress, postWebhook, publicOnlyLookup, refuseEndpointUrl, WebhookTargetError } from "@/lib/webhook-transport";

const request = { method: "POST" as const, headers: { "Content-Type": "application/json" }, body: "{}" };

beforeEach(() => {
  dns.lookup.mockReset();
  dns.lookup.mockImplementation(dns.real as never);
});

/**
 * Stands in for the connection only: no socket is opened. The request "answers" with a status line, or fails with a network error. Returns the spy
 * on `https.request`, so a test can count the connections and read the options each one was made with.
 */
function stubConnection(answer: { status: number; statusMessage: string } | { error: Error }) {
  return vi.spyOn(https, "request").mockImplementation(((_url: unknown, _options: unknown, callback?: (res: unknown) => void) => {
    const handlers: Record<string, (error: Error) => void> = {};
    const req = {
      on: (event: string, handler: (error: Error) => void) => {
        handlers[event] = handler;
        return req;
      },
      end: () => {
        if ("error" in answer) handlers.error?.(answer.error);
        else callback?.({ statusCode: answer.status, statusMessage: answer.statusMessage, resume: () => undefined });
      },
    };
    return req;
  }) as unknown as typeof https.request);
}

describe("isPublicAddress", () => {
  it.each([
    ["8.8.8.8"],
    ["93.184.216.34"],
    ["2606:4700:4700::1111"],
    ["::ffff:8.8.8.8"],
    ["64:ff9b::8.8.8.8"], // a NAT64 address for a public IPv4 host (DNS64 answers it on an IPv6-only host)
    ["64:ff9b::808:808"],
    ["2001:200::1"], // the APNIC allocation, outside the protocol block
  ])("accepts the public address %s", (address) => {
    expect(isPublicAddress(address)).toBe(true);
  });

  it.each([
    ["127.0.0.1"],
    ["10.1.2.3"],
    ["172.16.0.1"],
    ["172.31.255.255"],
    ["192.168.1.10"],
    ["169.254.169.254"], // the cloud metadata address
    ["100.64.0.1"], // shared address space
    ["0.0.0.0"],
    ["224.0.0.1"],
    ["255.255.255.255"],
    ["::1"],
    ["::"],
    ["fe80::1"],
    ["fe80::1%eth0"],
    ["fc00::1"],
    ["fd12:3456::1"],
    ["ff02::1"],
    ["::ffff:127.0.0.1"], // an IPv4 address written as IPv6
    ["::ffff:7f00:1"], // the same, in hexadecimal
    ["64:ff9b::7f00:1"],
    ["2002:7f00:1::"],
    ["192.0.2.1"], // documentation (TEST-NET-1)
    ["198.51.100.7"], // documentation (TEST-NET-2)
    ["203.0.113.9"], // documentation (TEST-NET-3)
    ["192.88.99.1"], // the deprecated 6to4 relay anycast range
    ["2001:db8::1"], // documentation (IPv6)
    ["fec0::1"], // the deprecated site-local range
    // The IPv4-compatible range (::/96) carries an IPv4 address and is not global unicast: none of these is dialled.
    ["::7f00:1"], // 127.0.0.1
    ["::127.0.0.1"],
    ["::a00:1"], // 10.0.0.1
    ["::8.8.8.8"], // a public IPv4 address, in the deprecated compatible form
    ["64:ff9b::7f00:1"], // a NAT64 address for loopback
    ["64:ff9b::a9fe:a9fe"], // a NAT64 address for the cloud metadata address
    ["2001::1"], // Teredo, which carries an IPv4 address
  ])("refuses the non-public address %s", (address) => {
    expect(isPublicAddress(address)).toBe(false);
  });

  it("refuses what is not an IP address at all", () => {
    expect(isPublicAddress("example.com")).toBe(false);
    expect(isPublicAddress("999.1.1.1")).toBe(false);
  });
});

describe("postWebhook: the destination is refused before any connection", () => {
  it("refuses a plain http endpoint", async () => {
    await expect(postWebhook("http://8.8.8.8/hook", request)).rejects.toBeInstanceOf(WebhookTargetError);
  });

  it("refuses a file or any other scheme", async () => {
    await expect(postWebhook("file:///etc/passwd", request)).rejects.toBeInstanceOf(WebhookTargetError);
  });

  it("refuses a URL that is not a URL", async () => {
    await expect(postWebhook("not a url", request)).rejects.toBeInstanceOf(WebhookTargetError);
  });

  it.each([
    ["https://127.0.0.1:9/hook"],
    ["https://169.254.169.254/latest/meta-data"],
    ["https://[::1]:9/hook"],
    ["https://10.0.0.5/hook"],
  ])("refuses the IP literal in %s", async (target) => {
    await expect(postWebhook(target, request)).rejects.toBeInstanceOf(WebhookTargetError);
  });

  it("refuses a name that resolves to the loopback address (localhost)", async () => {
    await expect(postWebhook("https://localhost:9/hook", request)).rejects.toBeInstanceOf(WebhookTargetError);
  });
});

describe("publicOnlyLookup", () => {
  const answer = (addresses: Array<{ address: string; family: number }>) =>
    dns.lookup.mockImplementation((_name: string, _options: unknown, callback: (err: null, addresses: unknown) => void) => callback(null, addresses));

  it("answers every address of a name whose addresses are all public", () => {
    answer([{ address: "93.184.216.34", family: 4 }, { address: "2606:4700:4700::1111", family: 6 }]);
    const callback = vi.fn();

    publicOnlyLookup("hooks.example.test", { all: true }, callback);

    expect(callback).toHaveBeenCalledWith(null, [{ address: "93.184.216.34", family: 4 }, { address: "2606:4700:4700::1111", family: 6 }]);
  });

  it("refuses the whole name when one of its addresses is not public (a private answer is never dialled)", () => {
    answer([{ address: "93.184.216.34", family: 4 }, { address: "10.0.0.7", family: 4 }]);
    const callback = vi.fn();

    publicOnlyLookup("hooks.example.test", { all: true }, callback);

    const [error, addresses] = callback.mock.calls[0];
    expect(error).toBeInstanceOf(WebhookTargetError);
    expect(addresses).toEqual([]);
  });

  it("answers one public address to a caller that does not ask for all of them", () => {
    answer([{ address: "93.184.216.34", family: 4 }]);
    const callback = vi.fn();

    publicOnlyLookup("hooks.example.test", {}, callback);

    expect(callback).toHaveBeenCalledWith(null, "93.184.216.34", 4);
  });

  it("passes a resolver failure through", () => {
    dns.lookup.mockImplementation((_name: string, _options: unknown, callback: (err: Error) => void) => callback(Object.assign(new Error("getaddrinfo ENOTFOUND"), { code: "ENOTFOUND" })));
    const callback = vi.fn();

    publicOnlyLookup("nowhere.example.test", { all: true }, callback);

    expect(callback.mock.calls[0][0]).toMatchObject({ code: "ENOTFOUND" });
  });
});

describe("postWebhook: the connection and its answer", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("a 3xx answer is a failed delivery: the redirect is not followed (one connection only)", async () => {
    const connection = stubConnection({ status: 301, statusMessage: "Moved Permanently" });

    await expect(postWebhook("https://8.8.8.8/hook", request)).resolves.toEqual({ ok: false, status: 301, statusText: "Moved Permanently" });
    expect(connection).toHaveBeenCalledTimes(1);
  });

  it("a 2xx answer is a success", async () => {
    stubConnection({ status: 204, statusMessage: "No Content" });

    await expect(postWebhook("https://8.8.8.8/hook", request)).resolves.toEqual({ ok: true, status: 204, statusText: "No Content" });
  });

  it("a name is dialled through publicOnlyLookup, so the address that is checked is the one connected to", async () => {
    const connection = stubConnection({ status: 200, statusMessage: "OK" });

    await postWebhook("https://hooks.example.test/hook", request);

    const options = connection.mock.calls[0][1] as { lookup?: unknown };
    expect(options.lookup).toBe(publicOnlyLookup);
  });

  it("a network error rejects; it is not a delivery that answered", async () => {
    stubConnection({ error: new Error("ECONNRESET") });

    const error = await postWebhook("https://8.8.8.8/hook", request).then(() => null, (failure: unknown) => failure);
    expect(error).toBeInstanceOf(Error);
    expect((error as Error).message).toBe("ECONNRESET");
    expect(error).not.toBeInstanceOf(WebhookTargetError);
  });
});

describe("refuseEndpointUrl: the check when an endpoint is created or its URL changes", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it.each([
    ["http://8.8.8.8/hook", "Only https endpoints are accepted"],
    ["ftp://8.8.8.8/hook", "Only https endpoints are accepted"],
    ["not a url", "The endpoint URL is not a valid URL"],
  ])("refuses %s before any name is looked up", async (target, reason) => {
    await expect(refuseEndpointUrl(target)).resolves.toBe(reason);
    expect(dns.lookup).not.toHaveBeenCalled();
  });

  it.each([
    ["https://127.0.0.1/hook", "127.0.0.1 is not a public address"],
    ["https://[::1]/hook", "::1 is not a public address"],
    ["https://169.254.169.254/latest", "169.254.169.254 is not a public address"],
  ])("refuses the address literal in %s", async (target, reason) => {
    await expect(refuseEndpointUrl(target)).resolves.toBe(reason);
  });

  it("refuses a name that resolves to a non-public address", async () => {
    dns.lookup.mockImplementation((_name: string, _options: unknown, callback: (err: null, addresses: unknown) => void) =>
      callback(null, [{ address: "93.184.216.34", family: 4 }, { address: "10.0.0.7", family: 4 }])
    );

    const reason = await refuseEndpointUrl("https://hooks.example.test/hook");

    expect(reason).toContain("hooks.example.test resolves to a non-public address");
  });

  it("refuses localhost, which resolves to the loopback address", async () => {
    await expect(refuseEndpointUrl("https://localhost:9/hook")).resolves.toContain("non-public address");
  });

  it("accepts a name whose addresses are all public", async () => {
    dns.lookup.mockImplementation((_name: string, _options: unknown, callback: (err: null, addresses: unknown) => void) =>
      callback(null, [{ address: "93.184.216.34", family: 4 }])
    );

    await expect(refuseEndpointUrl("https://hooks.example.test/hook")).resolves.toBeNull();
  });

  it("accepts a name that does not resolve now: a delivery checks it again when it connects", async () => {
    dns.lookup.mockImplementation((_name: string, _options: unknown, callback: (err: Error) => void) =>
      callback(Object.assign(new Error("getaddrinfo ENOTFOUND"), { code: "ENOTFOUND" }))
    );

    await expect(refuseEndpointUrl("https://not-yet.example.test/hook")).resolves.toBeNull();
  });

  it("with the development opt-out, an http endpoint and a private address are accepted", async () => {
    vi.stubEnv("WEBHOOK_ALLOW_PRIVATE_TARGETS", "true");

    await expect(refuseEndpointUrl("http://127.0.0.1:3000/hook")).resolves.toBeNull();
    await expect(refuseEndpointUrl("https://10.0.0.5/hook")).resolves.toBeNull();
    await expect(refuseEndpointUrl("ftp://127.0.0.1/hook")).resolves.toBe("Only http and https endpoints are accepted");
  });

  it("the opt-out is on only for true or 1: any other value keeps the policy", async () => {
    vi.stubEnv("WEBHOOK_ALLOW_PRIVATE_TARGETS", "yes");

    await expect(refuseEndpointUrl("https://127.0.0.1/hook")).resolves.toBe("127.0.0.1 is not a public address");
  });
});

describe("postWebhook: the development opt-out", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
  });

  it("an http endpoint on a private address is connected to over http, without the destination lookup", async () => {
    vi.stubEnv("WEBHOOK_ALLOW_PRIVATE_TARGETS", "true");
    const connection = vi.spyOn(http, "request").mockImplementation(((_url: unknown, _options: unknown, callback?: (res: unknown) => void) => {
      const req = {
        on: () => req,
        end: () => callback?.({ statusCode: 202, statusMessage: "Accepted", resume: () => undefined }),
      };
      return req;
    }) as unknown as typeof http.request);

    await expect(postWebhook("http://127.0.0.1:3000/hook", request)).resolves.toEqual({ ok: true, status: 202, statusText: "Accepted" });

    expect(connection).toHaveBeenCalledTimes(1);
    expect((connection.mock.calls[0][1] as { lookup?: unknown }).lookup).toBeUndefined();
  });
});
