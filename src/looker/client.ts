/**
 * Looker API 4.0 client: login, token caching, rate limits and retries.
 *
 * - **Auth.** A `looker` DuckDB secret carries the instance `base_url` plus an API3
 *   `client_id` / `client_secret` pair. The client POSTs them to `/api/4.0/login`,
 *   caches the returned access token in process memory until shortly before
 *   `expires_in`, and sends it as `Authorization: Bearer <token>`. A 401 drops the
 *   cached token and logs in again once. Credentials and tokens never enter
 *   table-function state, URLs or error messages.
 * - **Rate limits.** 429 honours `Retry-After` (seconds or an HTTP date, bounded);
 *   5xx and network errors retry with exponential backoff.
 * - **Read-only.** Only GETs, plus two POSTs that do not change anything: `login`
 *   and `queries/run/json` (`run_inline_query`, which runs a SELECT against a
 *   LookML model and saves nothing).
 */

import { createHash } from "node:crypto";
import { secretOfType } from "@query-farm/vgi";
import { log } from "../log.ts";
import { VERSION } from "../meta.ts";

export const SECRET_TYPE = "looker";
export const API_PREFIX = "/api/4.0";
export const TIMEOUT_MS = 60_000;
export const MAX_ATTEMPTS = 5;
/** Longest single wait for a 429's Retry-After. */
export const MAX_RATE_WAIT_MS = 60_000;
export const DEFAULT_PAGE_SIZE = 500;
const USER_AGENT = `vgi-looker-worker/${VERSION}`;

export class LookerError extends Error {}

export interface LookerConfig {
  /** API origin (+ optional path prefix), e.g. https://acme.cloud.looker.com or https://acme.looker.com:19999 */
  baseUrl: string;
  /** Web UI origin used to build `url` columns. */
  webUrl: string;
  clientId: string;
  clientSecret: string;
  pageSize: number;
}

const LOOPBACK = new Set(["127.0.0.1", "localhost", "[::1]", "::1"]);

/** Normalize a Looker URL: https (http only for loopback fixtures); drop a trailing /api/4.0 and slashes. */
export function normalizeBaseUrl(raw: string, label = "base_url"): string {
  let url: URL;
  try {
    url = new URL(raw.trim());
  } catch {
    throw new LookerError(
      `looker secret: ${label} '${raw}' is not a URL (expected e.g. https://acme.cloud.looker.com)`,
    );
  }
  if (url.protocol !== "https:" && !(url.protocol === "http:" && LOOPBACK.has(url.hostname))) {
    throw new LookerError(
      `looker secret: ${label} must use https:// (http:// is accepted only for 127.0.0.1/localhost)`,
    );
  }
  if (url.username || url.password) throw new LookerError(`looker secret: ${label} must not contain credentials`);
  const path = url.pathname.replace(/\/+$/, "").replace(/\/api\/(?:3\.\d|4\.0)$/, "");
  return url.origin + path;
}

/**
 * The web UI origin for `url` columns. Original (self-hosted) Looker serves the API on
 * port 19999 and the UI on the default HTTPS port; Looker (Google Cloud core) uses one origin.
 */
export function defaultWebUrl(baseUrl: string): string {
  const u = new URL(baseUrl);
  if (u.port === "19999") u.port = "";
  return u.origin;
}

function str(v: unknown): string | undefined {
  return typeof v === "string" && v.trim() !== "" ? v.trim() : undefined;
}

/** Build the client config from the `looker` secret DuckDB resolved for this call. */
export function configFromSecrets(secrets: Record<string, Record<string, unknown>>): LookerConfig {
  const s = secretOfType(secrets as never, SECRET_TYPE) as Record<string, unknown> | undefined;
  if (!s) {
    throw new LookerError(
      "no looker secret: run CREATE SECRET (TYPE looker, BASE_URL 'https://<instance>.cloud.looker.com', " +
        "CLIENT_ID '<api client id>', CLIENT_SECRET '<api client secret>')",
    );
  }
  const base = str(s.base_url);
  if (!base) throw new LookerError("looker secret: base_url is required (e.g. https://acme.cloud.looker.com)");
  const clientId = str(s.client_id);
  const clientSecret = str(s.client_secret);
  if (!clientId || !clientSecret) {
    throw new LookerError("looker secret: client_id and client_secret (an API key pair) are required");
  }
  const baseUrl = normalizeBaseUrl(base);
  const web = str(s.web_url);
  let pageSize = DEFAULT_PAGE_SIZE;
  const ps = s.page_size;
  if (ps !== undefined && ps !== null && ps !== "") {
    const n = Number(ps);
    if (!Number.isInteger(n) || n < 1 || n > 10_000) {
      throw new LookerError("looker secret: page_size must be an integer between 1 and 10000");
    }
    pageSize = n;
  }
  return {
    baseUrl,
    webUrl: web ? normalizeBaseUrl(web, "web_url") : defaultWebUrl(baseUrl),
    clientId,
    clientSecret,
    pageSize,
  };
}

interface CachedToken {
  token: string;
  expiresAt: number;
}
const tokenCache = new Map<string, CachedToken>();

/** Cache key: instance + client id + a hash of the secret (never the secret itself). */
export function cacheKey(cfg: LookerConfig): string {
  return createHash("sha256").update([cfg.baseUrl, cfg.clientId, cfg.clientSecret].join("\u0000")).digest("hex");
}

/** Forget cached tokens (tests). */
export function clearTokenCache(): void {
  tokenCache.clear();
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Wait time from a Retry-After header (seconds or HTTP date), bounded. */
export function retryAfterMs(headers: Headers, now = Date.now()): number | undefined {
  const v = headers.get("Retry-After");
  if (!v) return undefined;
  if (/^\d+(\.\d+)?$/.test(v.trim())) return Math.min(Number(v) * 1000, MAX_RATE_WAIT_MS);
  const t = Date.parse(v);
  return Number.isNaN(t) ? undefined : Math.min(Math.max(0, t - now), MAX_RATE_WAIT_MS);
}

/** Looker errors are `{message, documentation_url, errors?: [{field, code, message}]}`. */
async function errorSummary(res: Response): Promise<string> {
  const text = await res.text();
  try {
    const j = JSON.parse(text) as { message?: string; errors?: { field?: string; message?: string }[] };
    const parts = [j.message, ...(j.errors ?? []).map((e) => [e.field, e.message].filter(Boolean).join(": "))];
    return parts.filter(Boolean).join(" - ") || text.slice(0, 300);
  } catch {
    return text.slice(0, 300);
  }
}

/** POST /login with the API key pair → access token (cached until near expiry). */
async function accessToken(cfg: LookerConfig): Promise<string> {
  const key = cacheKey(cfg);
  const hit = tokenCache.get(key);
  if (hit && hit.expiresAt > Date.now() + 60_000) return hit.token;
  const body = new URLSearchParams({ client_id: cfg.clientId, client_secret: cfg.clientSecret });
  for (let attempt = 1; ; attempt++) {
    let res: Response;
    try {
      res = await fetch(`${cfg.baseUrl}${API_PREFIX}/login`, {
        method: "POST",
        headers: {
          Accept: "application/json",
          "Content-Type": "application/x-www-form-urlencoded",
          "User-Agent": USER_AGENT,
        },
        body,
        signal: AbortSignal.timeout(TIMEOUT_MS),
      });
    } catch (err) {
      if (attempt >= MAX_ATTEMPTS) throw new LookerError(`Looker login failed: ${(err as Error).message}`);
      await sleep(250 * 2 ** attempt);
      continue;
    }
    if (res.ok) {
      const j = (await res.json()) as { access_token?: string; expires_in?: number };
      if (!j.access_token) throw new LookerError("Looker login response had no access_token");
      tokenCache.set(key, { token: j.access_token, expiresAt: Date.now() + (j.expires_in ?? 3600) * 1000 });
      return j.access_token;
    }
    if ((res.status === 429 || res.status >= 500) && attempt < MAX_ATTEMPTS) {
      const wait = res.status === 429 ? (retryAfterMs(res.headers) ?? 1000 * attempt) : 250 * 2 ** attempt;
      await res.body?.cancel();
      await sleep(wait);
      continue;
    }
    // Looker answers bad credentials with 404 "Not found".
    const hint = res.status === 404 || res.status === 401 ? " (check client_id / client_secret)" : "";
    throw new LookerError(`Looker login failed with HTTP ${res.status}${hint}: ${await errorSummary(res)}`);
  }
}

export interface RequestOptions {
  method?: "GET" | "POST";
  query?: Record<string, string | number | boolean | undefined | null>;
  /** JSON body (POST only). */
  json?: unknown;
  /** A 404 yields `null` instead of an error. */
  notFoundNull?: boolean;
}

/** Build an API URL from a path below /api/4.0 and query parameters (empty values dropped). */
export function apiUrl(cfg: LookerConfig, path: string, query?: RequestOptions["query"]): string {
  const qs = new URLSearchParams();
  for (const [k, v] of Object.entries(query ?? {})) {
    if (v !== undefined && v !== null && v !== "") qs.set(k, String(v));
  }
  const q = qs.toString();
  return `${cfg.baseUrl}${API_PREFIX}${path}${q ? `?${q}` : ""}`;
}

/** Call one Looker API 4.0 endpoint and parse the JSON response. */
export async function lookerRequest(cfg: LookerConfig, path: string, opts: RequestOptions = {}): Promise<unknown> {
  const method = opts.method ?? "GET";
  const url = apiUrl(cfg, path, opts.query);
  let reauthed = false;
  for (let attempt = 1; ; attempt++) {
    let res: Response;
    try {
      const headers: Record<string, string> = {
        Accept: "application/json",
        Authorization: `Bearer ${await accessToken(cfg)}`,
        "User-Agent": USER_AGENT,
      };
      if (opts.json !== undefined) headers["Content-Type"] = "application/json";
      res = await fetch(url, {
        method,
        headers,
        body: opts.json !== undefined ? JSON.stringify(opts.json) : undefined,
        signal: AbortSignal.timeout(TIMEOUT_MS),
      });
    } catch (err) {
      if (err instanceof LookerError) throw err;
      if (attempt >= MAX_ATTEMPTS) throw new LookerError(`${method} ${redact(url)} failed: ${(err as Error).message}`);
      await sleep(250 * 2 ** attempt);
      continue;
    }
    if (res.ok) {
      const text = await res.text();
      return text ? JSON.parse(text) : null;
    }
    if (res.status === 404 && opts.notFoundNull) {
      await res.body?.cancel();
      return null;
    }
    if (res.status === 401 && !reauthed) {
      // The token expired or was revoked early: log in again once.
      reauthed = true;
      tokenCache.delete(cacheKey(cfg));
      await res.body?.cancel();
      continue;
    }
    const retryable = res.status === 429 || res.status >= 500;
    if (!retryable || attempt >= MAX_ATTEMPTS) {
      throw new LookerError(`${method} ${redact(url)} failed with HTTP ${res.status}: ${await errorSummary(res)}`);
    }
    await res.body?.cancel();
    const delay = res.status === 429 ? (retryAfterMs(res.headers) ?? 1000 * attempt) : 250 * 2 ** attempt;
    log.debug(`looker: HTTP ${res.status} for ${redact(url)}; retry ${attempt} in ${delay} ms`);
    await sleep(delay);
  }
}

/** Show the API path + query of a URL in errors (credentials are never in a URL). */
function redact(url: string): string {
  const u = new URL(url);
  return `${u.pathname}${u.search}`;
}
