import { requestExternal, WebhookTargetError } from "@/lib/webhook-transport";
import { DeliveryError, type Credentials } from "./contracts";

export function retryDelay(headers: Record<string, string | string[] | undefined>): number | undefined {
  const value = String(headers["retry-after"] ?? "");
  const seconds = Number(value);
  const delay = value ? (Number.isFinite(seconds) ? seconds * 1000 : Date.parse(value) - Date.now())
    : headers["x-ratelimit-remaining"] === "0" ? Number(headers["x-ratelimit-reset"]) * 1000 - Date.now() : NaN;
  return Number.isFinite(delay) ? Math.min(Math.max(delay, 1000), 3600000) : undefined;
}

export function authHeaders(credentials: Credentials): Record<string, string> {
  if (credentials.authType === "bearer") return { Authorization: `Bearer ${credentials.token}` };
  if (credentials.authType === "basic") return { Authorization: `Basic ${Buffer.from(`${credentials.username}:${credentials.password}`).toString("base64")}` };
  if (credentials.authType === "github-app") throw new DeliveryError("GitHub App credentials can only be used with GitHub");
  return {};
}

export async function externalJson<T>(url: string, method: "GET" | "POST" | "PATCH", headers: Record<string, string>, payload?: unknown, allow404 = false): Promise<T | null> {
  let response: Awaited<ReturnType<typeof requestExternal>>;
  try {
    response = await requestExternal(url, { method, headers: { Accept: "application/json", ...headers, ...(payload === undefined ? {} : { "Content-Type": "application/json" }) }, body: payload === undefined ? undefined : JSON.stringify(payload) });
  } catch (error) {
    if (error instanceof WebhookTargetError) throw new DeliveryError(error.message);
    // Provider text can reflect request data. Never persist it or credentials in a delivery error.
    throw new DeliveryError("The destination response was interrupted; reconcile the delivery before repeating it", true, method !== "GET");
  }
  if (allow404 && response.status === 404) return null;
  if (response.status < 200 || response.status >= 300) {
    const delay = retryDelay(response.headers);
    throw new DeliveryError(`Destination returned HTTP ${response.status}`, response.status === 429 || response.status >= 500 || (response.status === 403 && delay !== undefined),
      method !== "GET" && response.status >= 500, delay);
  }
  if (!response.body) return {} as T;
  try { return JSON.parse(response.body) as T; } catch { throw new DeliveryError("Destination returned invalid JSON", false, method !== "GET"); }
}
