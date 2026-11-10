import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createServer, type Server, type RequestListener } from "node:http";
import { createHmac } from "node:crypto";
import { freezeArtifact } from "@/lib/deployments/artifact";
import { deliverPrepared } from "@/lib/deployments/adapters";
import { DeliveryError, WorkflowSettingsSchema, type PreparedPlan } from "@/lib/deployments/contracts";
import { requestExternal } from "@/lib/webhook-transport";
import { externalJson, retryDelay } from "@/lib/deployments/http";

const servers: Server[] = [];
const oldPrivate = process.env.WEBHOOK_ALLOW_PRIVATE_TARGETS;
beforeEach(() => { process.env.WEBHOOK_ALLOW_PRIVATE_TARGETS = "true"; });
afterEach(async () => {
  if (oldPrivate === undefined) delete process.env.WEBHOOK_ALLOW_PRIVATE_TARGETS; else process.env.WEBHOOK_ALLOW_PRIVATE_TARGETS = oldPrivate;
  await Promise.all(servers.splice(0).map((s) => new Promise<void>((resolve) => { s.closeAllConnections(); s.close(() => resolve()); })));
});
async function endpoint(handler: RequestListener) {
  const server = createServer(handler); servers.push(server);
  await new Promise<void>((resolve, reject) => { server.once("error", reject); server.listen(0, "127.0.0.1", resolve); });
  return `http://127.0.0.1:${(server.address() as { port: number }).port}`;
}
function plan(url: string): PreparedPlan {
  return { bundle: freezeArtifact({ id: "root", name: "Account", tenant: "paypal", domain: "identity", product: "accounts", schema: "account" }, "json-schema", { version: 2, status: "published", output: '{"type":"object"}', generatedAt: "now", entityVersion: 1 }), connectionConfig: { url, baseBranch: "main", supportsIdempotency: true }, settings: WorkflowSettingsSchema.parse({}), environment: "staging", workflowRevision: 1, validation: [] };
}
describe("HTTP deployment transport", () => {
  it("honors provider rate-limit delays without treating ordinary permission errors as retryable", async () => {
    const rateLimited = await endpoint((_req, res) => { res.writeHead(403, { "Retry-After": "5" }); res.end(); });
    await expect(externalJson(rateLimited, "GET", {})).rejects.toMatchObject({ retryable: true, uncertain: false, retryAfterMs: 5000 });
    const denied = await endpoint((_req, res) => { res.writeHead(403); res.end(); });
    await expect(externalJson(denied, "GET", {})).rejects.toMatchObject({ retryable: false });
    expect(retryDelay({ "retry-after": new Date(Date.now() + 30000).toUTCString() })).toBeGreaterThan(28000);
    expect(retryDelay({ "x-ratelimit-remaining": "0", "x-ratelimit-reset": String(Math.floor(Date.now() / 1000) + 15) })).toBeGreaterThan(13000);
  });
  it("sends the exact schema/version envelope with a stable idempotency key and HMAC signature", async () => {
    const deliveries: { body: string; key: string; signature: string }[] = [];
    const url = await endpoint((req, res) => { let body = ""; req.on("data", (c) => { body += c; }); req.on("end", () => { deliveries.push({ body, key: String(req.headers["idempotency-key"]), signature: String(req.headers["x-webhook-signature"]) }); res.writeHead(202); res.end('{"doNotPersist":"token-secret"}'); }); });
    const frozen = plan(url);
    const credentials = { authType: "bearer" as const, token: "token-secret", signingSecret: "signing-secret" };
    expect(await deliverPrepared("run-1", "http", frozen, credentials, "intent-1")).toEqual({ outcome: "accepted", httpStatus: 202 });
    await deliverPrepared("run-1", "http", frozen, credentials, "intent-1");
    expect(deliveries[0]).toEqual(deliveries[1]);
    expect(deliveries[0].key).toBe("intent-1");
    expect(deliveries[0].signature).toBe(`sha256=${createHmac("sha256", "signing-secret").update(deliveries[0].body).digest("hex")}`);
    expect(JSON.parse(deliveries[0].body)).toMatchObject({ payloadVersion: "1", artifact: { version: 2, files: [{ content: '{"type":"object"}' }] } });
    expect(deliveries[0].body).not.toContain("token-secret");
  });
  it("does not follow redirects and classifies server errors as uncertain", async () => {
    const redirect = await endpoint((_req, res) => { res.writeHead(302, { Location: "http://127.0.0.1:1/private" }); res.end(); });
    await expect(deliverPrepared("run", "http", plan(redirect), { authType: "none" }, "intent")).rejects.toMatchObject({ retryable: false, uncertain: false });
    const failure = await endpoint((_req, res) => { res.writeHead(503); res.end(); });
    try { await deliverPrepared("run", "http", plan(failure), { authType: "none" }, "intent"); throw new Error("Expected failure"); }
    catch (e) { expect(e).toBeInstanceOf(DeliveryError); expect(e).toMatchObject({ retryable: true, uncertain: true }); }
  });
  it("bounds response bodies and blocks private addresses outside development opt-in", async () => {
    const url = await endpoint((_req, res) => { res.end("x".repeat(200)); });
    await expect(requestExternal(url, { method: "GET", maxBytes: 20 })).rejects.toThrow(/size limit/);
    delete process.env.WEBHOOK_ALLOW_PRIVATE_TARGETS;
    await expect(requestExternal(url.replace("http:", "https:"), { method: "GET" })).rejects.toThrow(/not public/);
  });
});
