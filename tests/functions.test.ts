// Unit tests. The SQL-level tests live in test/sql and run through DuckDB.

import { afterAll, beforeAll, expect, test } from "bun:test";
import { join } from "node:path";
import { inlineBody, scanWindow } from "../src/looker/activity.ts";
import {
  clearTokenCache,
  configFromSecrets,
  defaultWebUrl,
  type LookerConfig,
  lookerRequest,
  normalizeBaseUrl,
  retryAfterMs,
} from "../src/looker/client.ts";
import { parseTableName } from "../src/looker/lookml.ts";
import { buildFolderPaths, maskDestinations, stripUrlCredentials } from "../src/looker/lookups.ts";
import {
  type Constraint,
  filterAnyOf,
  filterLiteral,
  filterRange,
  searchEq,
  searchPrefix,
  timeBounds,
} from "../src/looker/pushdown.ts";
import { convert, kindOfField } from "../src/looker/run.ts";
import { asDate, asTime } from "../src/looker/table.ts";

const ROOT = join(import.meta.dir, "..");
const DAY = 86_400_000;

test("base_url: https required except loopback; trailing /api/4.0 and slashes dropped", () => {
  expect(normalizeBaseUrl("https://acme.cloud.looker.com/")).toBe("https://acme.cloud.looker.com");
  expect(normalizeBaseUrl("https://acme.looker.com:19999/api/4.0/")).toBe("https://acme.looker.com:19999");
  expect(normalizeBaseUrl("http://127.0.0.1:8080")).toBe("http://127.0.0.1:8080");
  expect(() => normalizeBaseUrl("http://acme.looker.com")).toThrow(/https/);
  expect(() => normalizeBaseUrl("https://u:p@acme.looker.com")).toThrow(/credentials/);
  expect(() => normalizeBaseUrl("nope")).toThrow(/not a URL/);
});

test("web url: original Looker's API port 19999 maps to the UI origin", () => {
  expect(defaultWebUrl("https://acme.looker.com:19999")).toBe("https://acme.looker.com");
  expect(defaultWebUrl("https://acme.cloud.looker.com")).toBe("https://acme.cloud.looker.com");
});

test("configFromSecrets: needs base_url and the API key pair; validates page_size", () => {
  expect(() => configFromSecrets({})).toThrow(/no looker secret/);
  expect(() => configFromSecrets({ s: { type: "looker", base_url: "https://a.cloud.looker.com" } })).toThrow(
    /client_id and client_secret/,
  );
  const s = { type: "looker", base_url: "https://a.cloud.looker.com", client_id: "i", client_secret: "x" };
  expect(configFromSecrets({ s }).pageSize).toBe(500);
  expect(configFromSecrets({ s: { ...s, page_size: "25" } }).pageSize).toBe(25);
  expect(() => configFromSecrets({ s: { ...s, page_size: "0" } })).toThrow(/page_size/);
});

test("retryAfterMs: seconds or HTTP date, bounded", () => {
  expect(retryAfterMs(new Headers({ "Retry-After": "2" }))).toBe(2000);
  expect(retryAfterMs(new Headers({ "Retry-After": "9999" }))).toBe(60_000);
  const now = Date.parse("2026-11-15T00:00:00Z");
  expect(retryAfterMs(new Headers({ "Retry-After": "Sun, 15 Nov 2026 00:00:03 GMT" }), now)).toBe(3000);
  expect(retryAfterMs(new Headers())).toBeUndefined();
});

test("Looker filter expressions: escapes, alternatives and UTC ranges", () => {
  expect(filterLiteral("a,b")).toBe("a^,b");
  expect(filterLiteral("50%_off")).toBe("50^%^_off");
  expect(filterLiteral("-x")).toBe("^-x");
  expect(filterLiteral("NULL")).toBe("^NULL");
  expect(filterAnyOf(["error", "killed"])).toBe("error,killed");
  expect(filterRange(Date.parse("2026-01-01T00:00:00Z"), Date.parse("2026-01-02T12:30:00Z"))).toBe(
    "2026-01-01 00:00:00 to 2026-01-02 12:30:00",
  );
});

test("search params: exact values only when free of wildcards; prefixes from ranges", () => {
  const eq = (v: string): Constraint[] => [{ kind: "cmp", column: "title", op: "eq", value: v }];
  expect(searchEq(eq("Sales"), "title")).toBe("Sales");
  expect(searchEq(eq("Old_Finance"), "title")).toBeUndefined();
  expect(searchEq(eq("100%"), "title")).toBeUndefined();
  expect(searchPrefix([{ kind: "prefix", column: "title", value: "Mark" }], "title")).toBe("Mark%");
});

test("timeBounds: inclusive DATE upper bounds widen by a day; timestamps by a second", () => {
  const d = (op: "ge" | "le" | "lt", v: string): Constraint => ({ kind: "cmp", column: "c", op, value: v });
  expect(timeBounds([d("ge", "2026-01-01"), d("le", "2026-01-31")], "c", true)).toEqual({
    lower: Date.parse("2026-01-01T00:00:00Z"),
    upper: Date.parse("2026-02-01T00:00:00Z"),
  });
  expect(timeBounds([d("lt", "2026-01-31T10:00:00.500Z")], "c")).toEqual({
    lower: undefined,
    upper: Date.parse("2026-01-31T10:00:01Z"),
  });
});

test("scanWindow: defaults to whole UTC days ending today for DATE columns", () => {
  const anchor = Date.parse("2026-11-15T13:00:00Z");
  const [lo, hi] = scanWindow([], "view_date", true, anchor, 30);
  expect(hi).toBe(Date.parse("2026-11-16T00:00:00Z"));
  expect(hi - lo).toBe(30 * DAY);
});

test("inline query body targets System Activity in UTC with a row cap", () => {
  const b = inlineBody({ view: "history", fields: ["history.id"], filters: { "history.status": "error" }, sorts: [] });
  expect(b).toMatchObject({ model: "system__activity", view: "history", query_timezone: "UTC", limit: "50000" });
});

test("folder paths: built from parent links, cycle-safe", () => {
  const paths = buildFolderPaths([
    { id: "1", name: "Shared", parent_id: null },
    { id: "3", name: "Marketing", parent_id: "1" },
    { id: "4", name: "EMEA", parent_id: "3" },
    { id: "8", name: "Loop", parent_id: "9" },
    { id: "9", name: "Back", parent_id: "8" },
  ]);
  expect(paths.get("4")).toBe("/Shared/Marketing/EMEA");
  expect(paths.get("8")).toMatch(/Loop$/);
});

test("destinations are summarised, never exposed", () => {
  const m = maskDestinations(
    [
      { type: "email", format: "csv", address: "Ada@Example.com" },
      { type: "webhook", format: "json", address: "https://hooks.example.net/secret" },
    ],
    "address",
    "type",
    "format",
  );
  expect(m).toEqual({ count: 2, types: ["email", "webhook"], formats: ["csv", "json"], domains: ["example.com"] });
  expect(maskDestinations(null, "address", "type").count).toBeNull();
});

test("git remote URLs lose embedded credentials", () => {
  expect(stripUrlCredentials("https://bot:ghp_x@github.com/a/b.git")).toBe("https://github.com/a/b.git");
  expect(stripUrlCredentials("git@github.com:a/b.git")).toBe("git@github.com:a/b.git");
});

test("parseTableName: quoted, dotted and derived names", () => {
  expect(parseTableName("`proj.ds.orders`")).toEqual({ catalog: "proj", schema: "ds", table: "orders" });
  expect(parseTableName('"DB"."PUBLIC"."T"')).toEqual({ catalog: "DB", schema: "PUBLIC", table: "T" });
  expect(parseTableName("public.users")).toEqual({ catalog: null, schema: "public", table: "users" });
  expect(parseTableName(`\${orders.SQL_TABLE_NAME}`).table).toBeNull();
  expect(parseTableName("(SELECT 1)").table).toBeNull();
  expect(parseTableName(null).table).toBeNull();
});

test("result typing from LookML field metadata", () => {
  expect(kindOfField({ type: "count", is_numeric: true, category: "measure" }, false)).toBe("bigint");
  expect(kindOfField({ type: "sum", is_numeric: true, category: "measure" }, false)).toBe("double");
  expect(kindOfField({ type: "sum", is_numeric: true, category: "measure" }, true)).toBe("json");
  expect(kindOfField({ type: "yesno" }, false)).toBe("bool");
  expect(kindOfField({ type: "date_date" }, false)).toBe("date");
  expect(kindOfField({ type: "date_time" }, false)).toBe("timestamp");
  expect(kindOfField({ type: "date_month" }, false)).toBe("str");
  expect(convert("bool", "Yes")).toBe(true);
  expect(convert("bigint", "12")).toBe(12n);
  expect(convert("double", "x")).toBeNull();
  expect(asDate("2026-11-12")).toBe(Date.UTC(2026, 10, 12) / DAY);
  expect(asTime("2026-11-12 10:00:00")).toBe(BigInt(Date.parse("2026-11-12T10:00:00Z")) * 1000n);
});

// ------------------------------------------------- client against the replay server

let server: ReturnType<typeof Bun.spawn> | undefined;
let base = "";

beforeAll(async () => {
  server = Bun.spawn(["python3", join(ROOT, "test/mock_api/server.py")], { stdout: "pipe", stderr: "ignore" });
  const reader = (server.stdout as ReadableStream<Uint8Array>).getReader();
  let text = "";
  while (!/PORT:\d+/.test(text)) {
    const { value, done } = await reader.read();
    if (done) throw new Error("replay server exited");
    text += new TextDecoder().decode(value);
  }
  base = `http://127.0.0.1:${text.match(/PORT:(\d+)/)?.[1]}`;
  reader.releaseLock();
});

afterAll(() => {
  server?.kill();
});

const cfg = (): LookerConfig => ({
  baseUrl: base,
  webUrl: base,
  clientId: "test-client-id",
  clientSecret: "test-client-secret",
  pageSize: 500,
});

async function logins(): Promise<number> {
  const r = await fetch(`${base}/__requests?path=/api/4.0/login`);
  return ((await r.json()) as unknown[]).length;
}

test("client: logs in once, caches the token, re-logs in after a 401", async () => {
  clearTokenCache();
  const before = await logins();
  await lookerRequest(cfg(), "/roles", { query: { fields: "id" } }); // 503 once, then retried
  await lookerRequest(cfg(), "/projects", { query: { fields: "id" } });
  expect((await logins()) - before).toBe(1);
  // Revoke every token server-side: the next call gets a 401, logs in again and succeeds.
  await fetch(`${base}/__expire_tokens`, { method: "POST" });
  const projects = (await lookerRequest(cfg(), "/projects", { query: { fields: "id" } })) as unknown[];
  expect(projects.length).toBe(2);
  expect((await logins()) - before).toBe(2);
});

test("client: honours 429 Retry-After and reports HTTP errors with the status", async () => {
  clearTokenCache();
  const t0 = Date.now();
  const groups = (await lookerRequest(cfg(), "/groups/search", { query: { fields: "id" } })) as unknown[];
  expect(groups.length).toBe(3);
  expect(Date.now() - t0).toBeGreaterThanOrEqual(900);
  await expect(lookerRequest(cfg(), "/queries/999")).rejects.toThrow(/HTTP 404/);
  expect(await lookerRequest(cfg(), "/queries/999", { notFoundNull: true })).toBeNull();
  await expect(lookerRequest({ ...cfg(), clientSecret: "bad" }, "/projects")).rejects.toThrow(/login failed.*404/);
});
