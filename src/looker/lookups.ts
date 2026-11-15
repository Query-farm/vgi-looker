/**
 * Small per-process lookups that enrich content rows: folder paths and owner names.
 *
 * Both are read with paged searches restricted to a few fields and cached in process
 * memory for a minute per Looker instance + API client. They are never put in scan
 * state; a process that serves a resumed scan simply loads them again.
 */

import { cacheKey, type LookerConfig } from "./client.ts";
import { asStr, getAllPages, type Row } from "./table.ts";

const TTL_MS = 60_000;

interface Cached<T> {
  at: number;
  value: Promise<T>;
}
const folderCache = new Map<string, Cached<Map<string, string>>>();
const userCache = new Map<string, Cached<Map<string, string>>>();

/** Forget cached lookups (tests). */
export function clearLookupCache(): void {
  folderCache.clear();
  userCache.clear();
}

function cached<T>(cache: Map<string, Cached<T>>, cfg: LookerConfig, load: () => Promise<T>): Promise<T> {
  const key = cacheKey(cfg);
  const hit = cache.get(key);
  if (hit && Date.now() - hit.at < TTL_MS) return hit.value;
  const value = load();
  cache.set(key, { at: Date.now(), value });
  value.catch(() => cache.delete(key));
  return value;
}

/** Build `/Shared/Marketing/EMEA`-style paths from (id, name, parent_id) rows. */
export function buildFolderPaths(
  folders: { id: string; name: string; parent_id: string | null }[],
): Map<string, string> {
  const byId = new Map(folders.map((f) => [f.id, f]));
  const paths = new Map<string, string>();
  const resolve = (id: string, depth: number): string => {
    const known = paths.get(id);
    if (known !== undefined) return known;
    const f = byId.get(id);
    if (!f) return "";
    // Guard against cycles or absurd depth in malformed data.
    const parent = f.parent_id && depth < 64 && byId.has(f.parent_id) ? resolve(f.parent_id, depth + 1) : "";
    const p = `${parent}/${f.name}`;
    paths.set(id, p);
    return p;
  };
  for (const f of folders) resolve(f.id, 0);
  return paths;
}

/** folder id → path, for every folder this API user can see. */
export function folderPaths(cfg: LookerConfig): Promise<Map<string, string>> {
  return cached(folderCache, cfg, async () => {
    const rows = await getAllPages(cfg, "/folders/search", { fields: "id,name,parent_id", sorts: "id" });
    return buildFolderPaths(
      rows.map((r) => ({ id: String(r.id), name: asStr(r.name) ?? "", parent_id: asStr(r.parent_id) })),
    );
  });
}

/** user id → display name (or email), for owner columns. */
export function userNames(cfg: LookerConfig): Promise<Map<string, string>> {
  return cached(userCache, cfg, async () => {
    const rows = await getAllPages(cfg, "/users/search", {
      fields: "id,display_name,first_name,last_name,email",
      sorts: "id",
    });
    return new Map(
      rows.map((r) => [
        String(r.id),
        asStr(r.display_name) ?? ([r.first_name, r.last_name].filter(Boolean).join(" ") || (asStr(r.email) ?? "")),
      ]),
    );
  });
}

/** Attach `__folder_path` (from `folderOf(row)`) and `__owner` (from `ownerOf(row)`) to rows. */
export async function withFolderAndOwner(
  cfg: LookerConfig,
  rows: Row[],
  folderOf: ((r: Row) => unknown) | null,
  ownerOf: ((r: Row) => unknown) | null,
): Promise<Row[]> {
  const [paths, names] = await Promise.all([
    folderOf ? folderPaths(cfg) : Promise.resolve(null),
    ownerOf ? userNames(cfg) : Promise.resolve(null),
  ]);
  return rows.map((r) => {
    const fid = folderOf ? asStr(folderOf(r)) : null;
    const uid = ownerOf ? asStr(ownerOf(r)) : null;
    return {
      ...r,
      __folder_path: fid && paths ? (paths.get(fid) ?? null) : null,
      __owner: uid && names ? (names.get(uid) ?? null) : null,
    };
  });
}

/**
 * Summarise delivery destinations without exposing them: how many there are, their
 * types and formats, and the distinct email domains (never the addresses, webhook
 * URLs or action parameters).
 */
export function maskDestinations(
  dests: unknown,
  addressKey: string,
  typeKey: string,
  formatKey?: string,
): { count: number | null; types: string[] | null; formats: string[] | null; domains: string[] | null } {
  if (!Array.isArray(dests)) return { count: null, types: null, formats: null, domains: null };
  const types = new Set<string>();
  const formats = new Set<string>();
  const domains = new Set<string>();
  for (const d of dests as Record<string, unknown>[]) {
    const t = asStr(d?.[typeKey]);
    if (t) types.add(t);
    const f = formatKey ? asStr(d?.[formatKey]) : null;
    if (f) formats.add(f);
    const a = asStr(d?.[addressKey]);
    const m = a?.match(/@([A-Za-z0-9.-]+)\s*$/);
    if (m?.[1]) domains.add(m[1].toLowerCase());
  }
  return {
    count: dests.length,
    types: [...types].sort(),
    formats: formatKey ? [...formats].sort() : null,
    domains: [...domains].sort(),
  };
}

/** Drop any `user:password@` from a git remote URL. */
export function stripUrlCredentials(v: unknown): string | null {
  const s = asStr(v);
  if (!s) return null;
  return s.replace(/^([a-z][a-z0-9+.-]*:\/\/)[^/@\s]*@/i, "$1");
}
