/**
 * The Looker API 4.0 collections exposed as catalog tables.
 *
 * Content tables share column names with the other BI workers (tool, id, title,
 * folder_path, owner, created_at, updated_at, last_viewed_at, view_count, url) so
 * dashboards, charts, folders, users and connections UNION across tools.
 */

import type { TableDescriptor } from "@query-farm/vgi";
import { lookerRequest } from "./client.ts";
import { maskDestinations, stripUrlCredentials, withFolderAndOwner } from "./lookups.ts";
import { boolValue, eqValues, searchEq, searchPrefix } from "./pushdown.ts";
import {
  asStr,
  C,
  type Col,
  defaultRows,
  defineLookerCatalogTable,
  getAllPages,
  type LookerTableSpec,
  type Row,
  type ScanContext,
} from "./table.ts";

type Q = Record<string, string | number | boolean | undefined>;

/** Search parameters for exact / prefix string pushdown on one column. */
function strParam(ctx: ScanContext, column: string, prefix = false): string | undefined {
  return searchEq(ctx.constraints, column) ?? (prefix ? searchPrefix(ctx.constraints, column) : undefined);
}
function boolParam(ctx: ScanContext, column: string): string | undefined {
  const b = boolValue(ctx.constraints, column);
  return b === undefined ? undefined : String(b);
}

const id = (doc: string) => C.str("id", doc, "id", false);
const owner = C.str("owner", "Display name of the user who owns (created) the object.", "__owner");
const folderPath = C.str(
  "folder_path",
  "Slash-separated folder path from the root, e.g. /Shared/Marketing.",
  "__folder_path",
);
const enc = encodeURIComponent;

// ------------------------------------------------------------------------ dashboards

const FILTER_FIELDS = [
  { name: "name", path: "name" },
  { name: "title", path: "title" },
  { name: "type", path: "type" },
  { name: "default_value", path: "default_value" },
  { name: "model", path: "model" },
  { name: "explore", path: "explore" },
  { name: "dimension", path: "dimension" },
  { name: "allow_multiple_values", path: "allow_multiple_values", kind: "bool" as const },
  { name: "required", path: "required", kind: "bool" as const },
];

export const dashboards: LookerTableSpec = {
  name: "dashboards",
  description: "User-defined Looker dashboards with folder path, owner, usage counters and dashboard filters.",
  title: "Looker Dashboards",
  category: "content",
  keywords: "looker, dashboards, content, bi, folders, owner, views, filters",
  docLlm:
    "One row per user-defined Looker dashboard (search_dashboards). Columns: tool ('looker'), id, title, " +
    "description, folder_id, folder_path (/Shared/…), owner, owner_id, created_at, updated_at, last_viewed_at, " +
    "last_accessed_at, view_count, favorite_count, url, slug, hidden, readonly, deleted, deleted_at, " +
    "refresh_interval, query_timezone, preferred_viewer, filters (list of dashboard filter structs: name, title, " +
    "type, default_value, model, explore, dimension). Join to dashboard_elements / charts on dashboard_id. " +
    "WHERE id / folder_id / owner_id / title (= or prefix) / deleted push down into the search.",
  docMd:
    "User-defined dashboards with the shared BI columns (`tool, id, title, folder_path, owner, created_at, " +
    "updated_at, last_viewed_at, view_count, url`) plus Looker-specific fields and the dashboard filters.",
  pushdown: "`id`, `folder_id`, `owner_id` and `title` (`=` or `LIKE 'x%'`) and `deleted` become search parameters.",
  columns: [
    C.tool(),
    id("Dashboard id."),
    C.str("title", "Dashboard title.", "title"),
    C.str("description", "Dashboard description.", "description"),
    C.str("folder_id", "Id of the folder holding the dashboard.", (r) => r.folder?.id ?? r.folder_id),
    folderPath,
    owner,
    C.str("owner_id", "Id of the user who created the dashboard.", "user_id"),
    C.time("created_at", "When the dashboard was created.", "created_at"),
    C.time("updated_at", "When the dashboard was last updated.", "updated_at"),
    C.time("last_viewed_at", "When the dashboard was last viewed.", "last_viewed_at"),
    C.time("last_accessed_at", "When the dashboard was last accessed (viewed or run via API).", "last_accessed_at"),
    C.bigint("view_count", "Number of times the dashboard has been viewed.", "view_count"),
    C.bigint("favorite_count", "Number of users who favorited the dashboard.", "favorite_count"),
    C.url("Web UI link to the dashboard.", (r) => (r.id != null ? `/dashboards/${enc(String(r.id))}` : null)),
    C.str("slug", "Dashboard slug (an alternative id used in URLs).", "slug"),
    C.bool("hidden", "Whether the dashboard is hidden from browse.", "hidden"),
    C.bool("readonly", "Whether the dashboard is read-only.", "readonly"),
    C.bool("deleted", "Whether the dashboard is soft-deleted (in Trash).", "deleted"),
    C.time("deleted_at", "When the dashboard was moved to Trash.", "deleted_at"),
    C.str("refresh_interval", "Auto-refresh interval, e.g. '1 hour'.", "refresh_interval"),
    C.str("query_timezone", "Timezone the dashboard's queries run in.", "query_timezone"),
    C.str("preferred_viewer", "Preferred viewer: dashboards-next or dashboards.", "preferred_viewer"),
    C.structList(
      "filters",
      "Dashboard filters: name, title, type, default value and the field they filter.",
      FILTER_FIELDS,
      "dashboard_filters",
    ),
  ],
  requests: (ctx) => [
    {
      path: "/dashboards/search",
      paged: true,
      query: {
        fields:
          "id,title,description,folder,folder_id,user_id,created_at,updated_at,last_viewed_at,last_accessed_at," +
          "view_count,favorite_count,slug,hidden,readonly,deleted,deleted_at,refresh_interval,query_timezone," +
          "preferred_viewer,dashboard_filters",
        sorts: "id",
        id: strParam(ctx, "id"),
        folder_id: strParam(ctx, "folder_id"),
        user_id: strParam(ctx, "owner_id"),
        title: strParam(ctx, "title", true),
        deleted: boolParam(ctx, "deleted"),
      } satisfies Q,
    },
  ],
  enrich: (ctx, rows) =>
    withFolderAndOwner(
      ctx.cfg,
      rows,
      (r) => r.folder?.id ?? r.folder_id,
      (r) => r.user_id,
    ),
  examples: [
    {
      description: "Most-viewed dashboards with their folder path",
      sql: "SELECT title, folder_path, owner, view_count FROM looker.main.dashboards WHERE NOT deleted ORDER BY view_count DESC LIMIT 10",
    },
    {
      description: "Dashboards nobody has opened in 90 days",
      sql: "SELECT id, title, owner, last_viewed_at FROM looker.main.dashboards WHERE last_viewed_at < now() - INTERVAL 90 DAY ORDER BY last_viewed_at",
    },
  ],
};

// ------------------------------------------------------------- dashboard elements

function elementQuery(r: Row): Row | undefined {
  return r.query ?? r.result_maker?.query ?? r.look?.query ?? undefined;
}
function elementQueryId(r: Row): unknown {
  return r.query_id ?? r.result_maker?.query_id ?? r.look?.query_id ?? elementQuery(r)?.id;
}
function elementVis(r: Row): unknown {
  return r.result_maker?.vis_config?.type ?? elementQuery(r)?.vis_config?.type ?? null;
}
function elementListens(r: Row): Row[] | null {
  const fs = r.result_maker?.filterables;
  if (!Array.isArray(fs)) return null;
  return fs.flatMap((f: Row) => (Array.isArray(f.listen) ? f.listen : []));
}

const ELEMENT_FIELDS =
  "id,dashboard_id,title,title_text,type,subtitle_text,note_text,body_text,look_id,look,query_id,query," +
  "result_maker_id,result_maker,merge_result_id";

export const dashboardElements: LookerTableSpec = {
  name: "dashboard_elements",
  description: "Dashboard tiles (elements) with the look, query, model and explore each one runs.",
  title: "Looker Dashboard Elements",
  category: "content",
  keywords: "looker, dashboard elements, tiles, visualizations, query, explore, look",
  docLlm:
    "One row per dashboard element (tile) across all dashboards (search_dashboard_elements). Columns: tool, id, " +
    "dashboard_id, title, type (vis, text, button …), subtitle_text, note_text, body_text, look_id, query_id (the " +
    "tile's own query, its result maker's or its look's), result_maker_id, merge_result_id, model, explore, " +
    "fields (list of field names), vis_type, listens_to (which dashboard filters drive which field), url. Join " +
    "query_id to queries for the full query; dashboard_id to dashboards. WHERE dashboard_id / look_id push down.",
  docMd:
    "Dashboard tiles and the queries behind them. `query_id` is resolved from the tile, its result maker or " +
    "its look, so you can join `looker.main.queries`.",
  pushdown: "`dashboard_id`, `look_id` and `title` (`=`) become search parameters.",
  columns: [
    C.tool(),
    id("Dashboard element id."),
    C.str("dashboard_id", "Id of the dashboard the tile is on.", "dashboard_id"),
    C.str("title", "Tile title.", (r) => r.title ?? r.title_text),
    C.str("type", "Element type: vis, text, button, data_vis …", "type"),
    C.str("subtitle_text", "Tile subtitle.", "subtitle_text"),
    C.str("note_text", "Tile note.", "note_text"),
    C.str("body_text", "Body of a text tile.", "body_text"),
    C.str("look_id", "Id of the Look the tile shows, if any.", "look_id"),
    C.str("query_id", "Id of the query the tile runs (its own, its result maker's or its look's).", elementQueryId),
    C.str("result_maker_id", "Id of the tile's result maker.", "result_maker_id"),
    C.str("merge_result_id", "Id of the merged-results query, if any.", "merge_result_id"),
    C.str("model", "LookML model of the tile's query.", (r) => elementQuery(r)?.model),
    C.str("explore", "Explore (LookML view) of the tile's query.", (r) => elementQuery(r)?.view),
    C.strList("fields", "Fields the tile's query selects.", (r) => elementQuery(r)?.fields),
    C.str("vis_type", "Visualization type, e.g. looker_line.", elementVis),
    C.structList(
      "listens_to",
      "Dashboard filters this tile listens to and the field each one filters.",
      [
        { name: "dashboard_filter_name", path: "dashboard_filter_name" },
        { name: "field", path: "field" },
      ],
      elementListens,
    ),
    C.url("Web UI link to the tile's dashboard.", (r) =>
      r.dashboard_id != null ? `/dashboards/${enc(String(r.dashboard_id))}` : null,
    ),
  ],
  requests: (ctx) => [
    {
      path: "/dashboard_elements/search",
      query: {
        fields: ELEMENT_FIELDS,
        sorts: "id",
        dashboard_id: strParam(ctx, "dashboard_id"),
        look_id: strParam(ctx, "look_id"),
        title: strParam(ctx, "title"),
      } satisfies Q,
    },
  ],
  examples: [
    {
      description: "Which explores feed the most dashboard tiles",
      sql: "SELECT model, explore, count(*) AS tiles FROM looker.main.dashboard_elements WHERE explore IS NOT NULL GROUP BY ALL ORDER BY tiles DESC",
    },
    {
      description: "Tiles on one dashboard and the queries behind them",
      sql: "SELECT id, title, vis_type, query_id FROM looker.main.dashboard_elements WHERE dashboard_id = '1' ORDER BY id",
    },
  ],
};

// ------------------------------------------------------------------------------ looks

const LOOK_FIELDS =
  "id,title,description,folder,folder_id,user_id,created_at,updated_at,last_viewed_at,view_count," +
  "favorite_count,deleted,deleted_at,public,short_url,query_id,model,last_updater_id";

export const looks: LookerTableSpec = {
  name: "looks",
  description: "Saved Looks with folder path, owner, query id and usage counters.",
  title: "Looker Looks",
  category: "content",
  keywords: "looker, looks, saved reports, content, folders, owner, views",
  docLlm:
    "One row per saved Look (search_looks). Columns: tool, id, title, description, folder_id, folder_path, owner, " +
    "owner_id, created_at, updated_at, last_viewed_at, view_count, favorite_count, url, query_id, model, public, " +
    "short_url, deleted, deleted_at, last_updater_id. Run a Look with run_look(id). WHERE id / title / folder_id " +
    "/ owner_id / query_id / deleted push down into the search.",
  docMd: "Saved Looks with the shared BI content columns; `run_look(id)` returns a Look's results.",
  pushdown:
    "`id`, `title` (`=` or prefix), `folder_id`, `owner_id`, `query_id` and `deleted` become search parameters.",
  columns: [
    C.tool(),
    id("Look id."),
    C.str("title", "Look title.", "title"),
    C.str("description", "Look description.", "description"),
    C.str("folder_id", "Id of the folder holding the Look.", (r) => r.folder?.id ?? r.folder_id),
    folderPath,
    owner,
    C.str("owner_id", "Id of the user who created the Look.", "user_id"),
    C.time("created_at", "When the Look was created.", "created_at"),
    C.time("updated_at", "When the Look was last updated.", "updated_at"),
    C.time("last_viewed_at", "When the Look was last viewed.", "last_viewed_at"),
    C.bigint("view_count", "Number of times the Look has been viewed.", "view_count"),
    C.bigint("favorite_count", "Number of users who favorited the Look.", "favorite_count"),
    C.url("Web UI link to the Look.", (r) => (r.id != null ? `/looks/${enc(String(r.id))}` : null)),
    C.str("query_id", "Id of the Look's query.", "query_id"),
    C.str("model", "LookML model the Look queries.", (r) => r.model?.id ?? r.model),
    C.bool("public", "Whether the Look has a public URL.", "public"),
    C.str("short_url", "Short relative URL of the Look.", "short_url"),
    C.bool("deleted", "Whether the Look is soft-deleted (in Trash).", "deleted"),
    C.time("deleted_at", "When the Look was moved to Trash.", "deleted_at"),
    C.str("last_updater_id", "Id of the user who last updated the Look.", "last_updater_id"),
  ],
  requests: (ctx) => [
    {
      path: "/looks/search",
      paged: true,
      query: {
        fields: LOOK_FIELDS,
        sorts: "id",
        id: strParam(ctx, "id"),
        title: strParam(ctx, "title", true),
        folder_id: strParam(ctx, "folder_id"),
        user_id: strParam(ctx, "owner_id"),
        query_id: strParam(ctx, "query_id"),
        deleted: boolParam(ctx, "deleted"),
      } satisfies Q,
    },
  ],
  enrich: (ctx, rows) =>
    withFolderAndOwner(
      ctx.cfg,
      rows,
      (r) => r.folder?.id ?? r.folder_id,
      (r) => r.user_id,
    ),
  examples: [
    {
      description: "Looks per folder",
      sql: "SELECT folder_path, count(*) AS looks, sum(view_count) AS views FROM looker.main.looks GROUP BY ALL ORDER BY views DESC",
    },
    {
      description: "Public Looks and who owns them",
      sql: "SELECT id, title, owner, short_url FROM looker.main.looks WHERE public ORDER BY id",
    },
  ],
};

// ----------------------------------------------------------------------------- charts

const isLook = (r: Row) => r.__ctx?.kind === "look";

export const charts: LookerTableSpec = {
  name: "charts",
  description: "Every chart in Looker: dashboard tiles and saved Looks, in the shared BI column layout.",
  title: "Looker Charts",
  category: "content",
  keywords: "looker, charts, tiles, looks, visualizations, bi, union",
  docLlm:
    "Dashboard tiles (chart_kind 'tile') and saved Looks (chart_kind 'look') in one table with the columns the " +
    "Tableau and Metabase workers also use: tool, chart_kind, id, title, dashboard_id, folder_path, owner, " +
    "created_at, updated_at, last_viewed_at, view_count, url, query_id, model, explore, vis_type. (chart_kind, " +
    "id) is the key: tile and Look ids overlap. Tiles have no owner or usage counters of their own (NULL); Looks " +
    "have no dashboard_id. Use it to inventory charts across BI tools; use dashboard_elements / looks for the " +
    "full Looker detail. WHERE chart_kind = 'tile' or 'look' skips the other half; dashboard_id pushes down.",
  docMd:
    "A unified chart inventory: dashboard tiles plus saved Looks, keyed by `(chart_kind, id)`, shaped to UNION " +
    "with the other BI workers' `charts` tables.",
  pushdown: "`chart_kind` selects which half is read; `dashboard_id` pushes into the tile search.",
  key: ["chart_kind", "id"],
  columns: [
    C.tool(),
    C.ctx("chart_kind", "'tile' (dashboard element) or 'look' (saved Look).", "kind"),
    id("Tile or Look id (unique within chart_kind)."),
    C.str("title", "Chart title.", (r) => r.title ?? r.title_text),
    C.str("dashboard_id", "Dashboard the tile is on (NULL for Looks).", (r) => (isLook(r) ? null : r.dashboard_id)),
    folderPath,
    owner,
    C.time("created_at", "When the chart was created (Looks only).", "created_at"),
    C.time("updated_at", "When the chart was last updated (Looks only).", "updated_at"),
    C.time("last_viewed_at", "When the chart was last viewed (Looks only).", "last_viewed_at"),
    C.bigint("view_count", "Number of views (Looks only).", "view_count"),
    C.url("Web UI link to the Look or the tile's dashboard.", (r) =>
      isLook(r)
        ? `/looks/${enc(String(r.id))}`
        : r.dashboard_id != null
          ? `/dashboards/${enc(String(r.dashboard_id))}`
          : null,
    ),
    C.str("query_id", "Id of the chart's query.", (r) => (isLook(r) ? r.query_id : elementQueryId(r))),
    C.str("model", "LookML model.", (r) => (isLook(r) ? (r.model?.id ?? r.model) : elementQuery(r)?.model)),
    C.str("explore", "Explore queried (tiles only; join queries for Looks).", (r) =>
      isLook(r) ? null : elementQuery(r)?.view,
    ),
    C.str("vis_type", "Visualization type (tiles only).", (r) => (isLook(r) ? null : elementVis(r))),
  ],
  requests: (ctx) => {
    const kinds = eqValues(ctx.constraints, "chart_kind");
    const out = [];
    if (!kinds || kinds.includes("tile")) {
      out.push({
        path: "/dashboard_elements/search",
        ctx: { kind: "tile" },
        query: { fields: ELEMENT_FIELDS, sorts: "id", dashboard_id: strParam(ctx, "dashboard_id") } satisfies Q,
      });
    }
    // A pushed dashboard_id excludes every Look (their dashboard_id is NULL).
    if ((!kinds || kinds.includes("look")) && !eqValues(ctx.constraints, "dashboard_id")) {
      out.push({
        path: "/looks/search",
        paged: true,
        ctx: { kind: "look" },
        query: { fields: LOOK_FIELDS, sorts: "id" } satisfies Q,
      });
    }
    return out;
  },
  enrich: (ctx, rows) =>
    rows[0]?.__ctx?.kind === "look"
      ? withFolderAndOwner(
          ctx.cfg,
          rows,
          (r) => r.folder?.id ?? r.folder_id,
          (r) => r.user_id,
        )
      : Promise.resolve(rows),
  examples: [
    {
      description: "Charts per explore across tiles and Looks",
      sql: "SELECT chart_kind, count(*) AS charts FROM looker.main.charts GROUP BY ALL ORDER BY chart_kind",
    },
    {
      description: "UNION-ready chart inventory",
      sql: "SELECT tool, chart_kind, id, title, url FROM looker.main.charts WHERE chart_kind = 'look' ORDER BY id",
    },
  ],
};

// --------------------------------------------------------------------------- queries

export const queries: LookerTableSpec = {
  name: "queries",
  description: "The queries behind dashboard tiles and Looks: model, explore, fields, filters, sorts and limits.",
  title: "Looker Queries",
  category: "content",
  keywords: "looker, queries, explore, fields, filters, pivots, sorts, lineage",
  docLlm:
    "One row per Looker query (get_query). Looker has no endpoint that lists every query, so without a filter " +
    "this reads the query of every dashboard tile and Look (one API call each); filter WHERE id = '…' or id IN " +
    "(…) to read only those. Columns: tool, id, model, explore, fields, pivots, fill_fields, filters (list of " +
    "{field, value}), filter_expression, sorts, row_limit, column_limit, total, row_total, subtotals, " +
    "dynamic_fields (JSON: table calculations and custom fields), vis_type, vis_config (JSON), query_timezone, " +
    "slug, client_id, url (share URL). Run one with run_query(id).",
  docMd:
    "Query definitions. Without an `id` filter the worker reads every query referenced by a tile or Look, so " +
    "prefer `WHERE id IN (…)` or a join from `dashboard_elements`.",
  pushdown: "`id = …` / `id IN (…)` reads just those queries instead of every referenced one.",
  columns: [
    C.tool(),
    id("Query id."),
    C.str("model", "LookML model.", "model"),
    C.str("explore", "Explore (Looker calls it `view`).", "view"),
    C.strList("fields", "Selected fields (dimensions, measures, table calculations).", "fields"),
    C.strList("pivots", "Pivoted fields.", "pivots"),
    C.strList("fill_fields", "Fields with fill-in of missing values.", "fill_fields"),
    C.structList(
      "filters",
      "Filters as {field, value} using Looker filter expressions.",
      [
        { name: "field", path: "field" },
        { name: "value", path: "value" },
      ],
      (r) =>
        r.filters && typeof r.filters === "object"
          ? Object.entries(r.filters as Record<string, unknown>).map(([field, value]) => ({ field, value }))
          : null,
    ),
    C.str("filter_expression", "Custom filter expression.", "filter_expression"),
    C.strList("sorts", "Sort fields, e.g. 'orders.count desc'.", "sorts"),
    C.bigint("row_limit", "Maximum rows the query returns (Looker `limit`).", "limit"),
    C.bigint("column_limit", "Maximum number of pivot columns.", "column_limit"),
    C.bool("total", "Whether column totals are computed.", "total"),
    C.str("row_total", "Row totals mode (right / left / NULL).", "row_total"),
    C.strList("subtotals", "Subtotalled fields.", "subtotals"),
    C.json("dynamic_fields", "Table calculations and custom fields (JSON).", (r) => {
      const d = r.dynamic_fields;
      if (typeof d !== "string") return d ?? null;
      try {
        return JSON.parse(d);
      } catch {
        return d;
      }
    }),
    C.str("vis_type", "Visualization type.", (r) => r.vis_config?.type),
    C.json("vis_config", "Visualization settings (JSON).", "vis_config"),
    C.str("query_timezone", "Timezone the query runs in.", "query_timezone"),
    C.str("slug", "Query slug.", "slug"),
    C.str("client_id", "Query client id (used in explore URLs as qid).", "client_id"),
    C.str("url", "Share URL that opens the query in an explore.", (r) => r.share_url ?? r.url),
  ],
  fanout: {
    parents: async (ctx) => {
      const ids = eqValues(ctx.constraints, "id");
      if (ids) return ids;
      const out: string[] = [];
      const elements = defaultRows(
        await lookerRequest(ctx.cfg, "/dashboard_elements/search", {
          query: { fields: "id,query_id,result_maker,look", sorts: "id" },
        }),
      );
      for (const e of elements) {
        const q = asStr(elementQueryId(e));
        if (q) out.push(q);
      }
      for (const l of await getAllPages(ctx.cfg, "/looks/search", { fields: "id,query_id", sorts: "id" })) {
        const q = asStr(l.query_id);
        if (q) out.push(q);
      }
      return out;
    },
    child: (qid) => ({ path: `/queries/${enc(qid)}`, notFoundEmpty: true }),
  },
  examples: [
    {
      description: "Most-used explores across tile and Look queries",
      sql: "SELECT model, explore, count(*) AS queries FROM looker.main.queries GROUP BY ALL ORDER BY queries DESC",
    },
    {
      description: "Filters on the queries behind one dashboard",
      sql: "SELECT q.id, unnest(q.filters, recursive := true) FROM looker.main.queries q WHERE q.id IN (SELECT query_id FROM looker.main.dashboard_elements WHERE dashboard_id = '1')",
    },
  ],
};

// ---------------------------------------------------------------------------- folders

export const folders: LookerTableSpec = {
  name: "folders",
  description: "Content folders with their full path, parent, owner and type flags.",
  title: "Looker Folders",
  category: "content",
  keywords: "looker, folders, spaces, content, hierarchy, path",
  docLlm:
    "One row per content folder (search_folders). Columns: tool, id, title (folder name), parent_id, " +
    "folder_path (full path including the folder itself, e.g. /Shared/Marketing), owner, owner_id, created_at, " +
    "child_count, is_personal, is_personal_descendant, is_shared_root, is_users_root, is_embed, url. WHERE id / " +
    "title / parent_id / owner_id / is_shared_root / is_users_root push down.",
  docMd: "The folder tree. `folder_path` is the same path the content tables report.",
  pushdown: "`id`, `title` (`=` or prefix), `parent_id`, `owner_id`, `is_shared_root` and `is_users_root`.",
  columns: [
    C.tool(),
    id("Folder id."),
    C.str("title", "Folder name.", "name"),
    C.str("parent_id", "Id of the parent folder (NULL at the root).", "parent_id"),
    C.str("folder_path", "Full path of this folder, e.g. /Shared/Marketing.", "__folder_path"),
    owner,
    C.str("owner_id", "Id of the user who created the folder.", "creator_id"),
    C.time("created_at", "When the folder was created.", "created_at"),
    C.bigint("child_count", "Number of child folders.", "child_count"),
    C.bool("is_personal", "A user's personal folder.", "is_personal"),
    C.bool("is_personal_descendant", "Inside a personal folder.", "is_personal_descendant"),
    C.bool("is_shared_root", "The Shared root folder.", "is_shared_root"),
    C.bool("is_users_root", "The Users root folder.", "is_users_root"),
    C.bool("is_embed", "An embed folder.", "is_embed"),
    C.url("Web UI link to the folder.", (r) => (r.id != null ? `/folders/${enc(String(r.id))}` : null)),
  ],
  requests: (ctx) => [
    {
      path: "/folders/search",
      paged: true,
      query: {
        fields:
          "id,name,parent_id,creator_id,created_at,child_count,is_personal,is_personal_descendant," +
          "is_shared_root,is_users_root,is_embed",
        sorts: "id",
        id: strParam(ctx, "id"),
        name: strParam(ctx, "title", true),
        parent_id: strParam(ctx, "parent_id"),
        creator_id: strParam(ctx, "owner_id"),
        is_shared_root: boolParam(ctx, "is_shared_root"),
        is_users_root: boolParam(ctx, "is_users_root"),
      } satisfies Q,
    },
  ],
  enrich: (ctx, rows) =>
    withFolderAndOwner(
      ctx.cfg,
      rows,
      (r) => r.id,
      (r) => r.creator_id,
    ),
  examples: [
    {
      description: "Folders directly under Shared",
      sql: "SELECT f.title, f.folder_path, f.child_count FROM looker.main.folders f WHERE f.parent_id = (SELECT id FROM looker.main.folders WHERE is_shared_root) ORDER BY f.title",
    },
    {
      description: "Personal folders and their owners",
      sql: "SELECT title, owner, folder_path FROM looker.main.folders WHERE is_personal ORDER BY title",
    },
  ],
};

// ------------------------------------------------------------------- users / groups / roles

export const users: LookerTableSpec = {
  name: "users",
  description: "Looker users with roles, groups and folders (no credentials).",
  title: "Looker Users",
  category: "admin",
  keywords: "looker, users, people, accounts, roles, groups, disabled",
  docLlm:
    "One row per Looker user (search_users), restricted to non-credential fields. Columns: tool, id, " +
    "display_name, email, first_name, last_name, is_disabled, is_service_account, role_ids, group_ids, " +
    "home_folder_id, personal_folder_id, locale, url. Join role_ids to roles.id and group_ids to groups.id with " +
    "unnest or list_contains. WHERE id / email / first_name / last_name / is_disabled push down.",
  docMd: "Users and their role and group memberships. Credential objects are never requested or returned.",
  pushdown: "`id`, `email`, `first_name`, `last_name` (`=`) and `is_disabled` become search parameters.",
  columns: [
    C.tool(),
    id("User id."),
    C.str(
      "display_name",
      "Full display name.",
      (r) => r.display_name ?? [r.first_name, r.last_name].filter(Boolean).join(" "),
    ),
    C.str("email", "Email address.", "email"),
    C.str("first_name", "Given name on the Looker account.", "first_name"),
    C.str("last_name", "Family name on the Looker account.", "last_name"),
    C.bool("is_disabled", "Whether the account is disabled.", "is_disabled"),
    C.bool("is_service_account", "Whether this is a service account.", "is_service_account"),
    C.strList("role_ids", "Ids of the roles assigned directly to the user.", "role_ids"),
    C.strList("group_ids", "Ids of the groups the user belongs to.", "group_ids"),
    C.str("home_folder_id", "Id of the user's home folder.", "home_folder_id"),
    C.str("personal_folder_id", "Id of the user's personal folder.", "personal_folder_id"),
    C.str("locale", "User locale.", "locale"),
    C.url("Admin page for the user.", (r) => (r.id != null ? `/admin/users/${enc(String(r.id))}/edit` : null)),
  ],
  requests: (ctx) => [
    {
      path: "/users/search",
      paged: true,
      query: {
        fields:
          "id,display_name,email,first_name,last_name,is_disabled,is_service_account,role_ids,group_ids," +
          "home_folder_id,personal_folder_id,locale",
        sorts: "id",
        id: strParam(ctx, "id"),
        email: strParam(ctx, "email"),
        first_name: strParam(ctx, "first_name"),
        last_name: strParam(ctx, "last_name"),
        is_disabled: boolParam(ctx, "is_disabled"),
      } satisfies Q,
    },
  ],
  examples: [
    {
      description: "Active users per role",
      sql: "SELECT r.name AS role, count(*) AS users FROM looker.main.users u, unnest(u.role_ids) AS t(role_id) JOIN looker.main.roles r ON r.id = t.role_id WHERE NOT u.is_disabled GROUP BY ALL ORDER BY users DESC",
    },
    {
      description: "Disabled accounts",
      sql: "SELECT id, email FROM looker.main.users WHERE is_disabled ORDER BY email",
    },
  ],
};

export const groups: LookerTableSpec = {
  name: "groups",
  description: "Looker user groups with member counts and external (SAML/LDAP/SCIM) mapping.",
  title: "Looker Groups",
  category: "admin",
  keywords: "looker, groups, teams, membership, scim, ldap, saml",
  docLlm:
    "One row per Looker group (search_groups). Columns: tool, id, name, user_count, externally_managed, " +
    "external_group_id, include_by_default, can_add_to_content_metadata, url. Users list their group_ids. " +
    "WHERE id / name / externally_managed / external_group_id push down.",
  docMd: "User groups; pair with `users.group_ids` for membership.",
  pushdown: "`id`, `name`, `external_group_id` (`=`) and `externally_managed`.",
  columns: [
    C.tool(),
    id("Group id."),
    C.str("name", "Group name.", "name"),
    C.bigint("user_count", "Number of users in the group.", "user_count"),
    C.bool("externally_managed", "Managed by an external system (SCIM/LDAP/SAML).", "externally_managed"),
    C.str("external_group_id", "Id of the group in the external system.", "external_group_id"),
    C.bool("include_by_default", "New users join the group by default.", "include_by_default"),
    C.bool("can_add_to_content_metadata", "Group can be given content access.", "can_add_to_content_metadata"),
    C.url("Admin page for the group.", (r) => (r.id != null ? `/admin/groups/${enc(String(r.id))}/edit` : null)),
  ],
  requests: (ctx) => [
    {
      path: "/groups/search",
      paged: true,
      query: {
        fields:
          "id,name,user_count,externally_managed,external_group_id,include_by_default,can_add_to_content_metadata",
        sorts: "id",
        id: strParam(ctx, "id"),
        name: strParam(ctx, "name"),
        external_group_id: strParam(ctx, "external_group_id"),
        externally_managed: boolParam(ctx, "externally_managed"),
      } satisfies Q,
    },
  ],
  examples: [
    {
      description: "Largest groups",
      sql: "SELECT name, user_count FROM looker.main.groups ORDER BY user_count DESC LIMIT 10",
    },
    {
      description: "Groups synced from an identity provider",
      sql: "SELECT name, external_group_id FROM looker.main.groups WHERE externally_managed ORDER BY name",
    },
  ],
};

export const roles: LookerTableSpec = {
  name: "roles",
  description: "Roles: permission set (with its permissions) and model set (with its models).",
  title: "Looker Roles",
  category: "admin",
  keywords: "looker, roles, permissions, permission sets, model sets, access",
  docLlm:
    "One row per Looker role (all_roles). Columns: tool, id, name, permission_set_id, permission_set_name, " +
    "permissions (list), model_set_id, model_set_name, models (list), user_count, url. Users carry role_ids. " +
    "Use list_contains(permissions, 'admin') etc. to audit access.",
  docMd: "Roles with their permission and model sets flattened into lists.",
  columns: [
    C.tool(),
    id("Role id."),
    C.str("name", "Role name.", "name"),
    C.str("permission_set_id", "Id of the permission set the role grants.", "permission_set.id"),
    C.str("permission_set_name", "Name of the permission set the role grants.", "permission_set.name"),
    C.strList("permissions", "Permissions granted.", "permission_set.permissions"),
    C.str("model_set_id", "Id of the model set the role applies to.", "model_set.id"),
    C.str("model_set_name", "Name of the model set the role applies to.", "model_set.name"),
    C.strList("models", "LookML models the role applies to.", "model_set.models"),
    C.bigint("user_count", "Number of users with the role.", "user_count"),
    C.url("Admin page for the role.", (r) => (r.id != null ? `/admin/roles/${enc(String(r.id))}/edit` : null)),
  ],
  requests: () => [{ path: "/roles", query: { fields: "id,name,permission_set,model_set,user_count" } }],
  examples: [
    {
      description: "Roles that grant admin",
      sql: "SELECT name, user_count FROM looker.main.roles WHERE list_contains(permissions, 'administer') ORDER BY name",
    },
    {
      description: "Permissions per role",
      sql: "SELECT name, len(permissions) AS permission_count, models FROM looker.main.roles ORDER BY permission_count DESC",
    },
  ],
};

// ------------------------------------------------------------------------ connections

export const connections: LookerTableSpec = {
  name: "connections",
  description:
    "Database connections (the data sources): dialect, host, database, schema; never passwords or certificates.",
  title: "Looker Connections",
  category: "admin",
  keywords: "looker, connections, data sources, database, dialect, warehouse, bigquery, snowflake",
  docLlm:
    "One row per database connection (all_connections) — Looker's data sources. Columns: tool, id (connection " +
    "name), title (same), dialect (e.g. bigquery_standard_sql, snowflake), dialect_label, host, port, database, " +
    "schema, username, ssl, verify_ssl, tmp_db_name (PDT scratch schema), pdts_enabled, max_connections, " +
    "uses_oauth, created_at, owner_id, example, url. Passwords, certificates, file contents, JDBC parameters and " +
    "after-connect statements are never requested or returned. Join explores.connection_name to id.",
  docMd:
    "Connections to warehouses. Equivalent to the `data_sources` table of other BI workers. Secrets are " +
    "excluded: the worker asks Looker only for non-sensitive fields and never emits a password or certificate.",
  columns: [
    C.tool(),
    C.str("id", "Connection name (Looker's connection id).", "name", false),
    C.str("title", "Connection name.", "name"),
    C.str("dialect", "SQL dialect name.", (r) => r.dialect_name ?? r.dialect?.name),
    C.str("dialect_label", "Human-readable dialect.", "dialect.label"),
    C.str("host", "Database host (or BigQuery project).", "host"),
    C.int("port", "TCP port of the database server (NULL when the dialect has none).", "port"),
    C.str("database", "Database name (or BigQuery dataset project).", "database"),
    C.str("schema", "Default schema.", "schema"),
    C.str("username", "Database user name (not a secret; the password is never returned).", "username"),
    C.bool("ssl", "SSL enabled.", "ssl"),
    C.bool("verify_ssl", "SSL certificate verification enabled.", "verify_ssl"),
    C.str("tmp_db_name", "Scratch schema for persistent derived tables.", "tmp_db_name"),
    C.bool("pdts_enabled", "Persistent derived tables enabled.", "pdts_enabled"),
    C.int("max_connections", "Maximum concurrent database connections Looker opens (pool size).", "max_connections"),
    C.bool("uses_oauth", "Users authenticate with OAuth.", "uses_oauth"),
    C.time("created_at", "When the connection was created.", "created_at"),
    C.str("owner_id", "Id of the user who created the connection.", "user_id"),
    C.bool("example", "A Looker example connection.", "example"),
    C.url("Admin page for the connection.", (r) =>
      r.name != null ? `/admin/connections/${enc(String(r.name))}/edit` : null,
    ),
  ],
  requests: () => [
    {
      path: "/connections",
      query: {
        fields:
          "name,dialect_name,dialect,host,port,database,schema,username,ssl,verify_ssl,tmp_db_name,pdts_enabled," +
          "max_connections,uses_oauth,created_at,user_id,example",
      },
    },
  ],
  examples: [
    {
      description: "Connections per dialect",
      sql: "SELECT dialect, count(*) AS connections FROM looker.main.connections GROUP BY ALL ORDER BY connections DESC",
    },
    {
      description: "Explores per connection",
      sql: "SELECT c.id, c.dialect, count(e.explore_name) AS explores FROM looker.main.connections c LEFT JOIN looker.main.explores e ON e.connection_name = c.id GROUP BY ALL ORDER BY explores DESC",
    },
  ],
};

// --------------------------------------------------------------------- projects / git

export const projects: LookerTableSpec = {
  name: "projects",
  description: "LookML projects with git configuration (remote, production branch, PR mode); no git credentials.",
  title: "LookML Projects",
  category: "lookml",
  keywords: "looker, lookml, projects, git, branches, deploy",
  docLlm:
    "One row per LookML project (all_projects). Columns: tool, id, name, uses_git, git_remote_url (any " +
    "user:password@ removed), git_service_name, production_branch, pull_request_mode, validation_required, " +
    "git_release_mgmt_enabled, allow_warnings, is_example, dependency_status, url. Git usernames, passwords and " +
    "deploy secrets are never returned. Models link via lookml_models.project_name; branches via " +
    "project_branches.",
  docMd: "LookML projects and their git setup. Credentials are excluded and remote URLs are stripped of user info.",
  columns: [
    C.tool(),
    id("Project id."),
    C.str("name", "Project name.", "name"),
    C.bool("uses_git", "Project is backed by git.", "uses_git"),
    C.str("git_remote_url", "Git remote URL (credentials removed).", (r) => stripUrlCredentials(r.git_remote_url)),
    C.str("git_service_name", "Git service, e.g. github.", "git_service_name"),
    C.str("production_branch", "Production branch name (NULL = default branch).", "git_production_branch_name"),
    C.str("pull_request_mode", "Pull request mode: off, links, recommended, required.", "pull_request_mode"),
    C.bool("validation_required", "LookML must validate before commit.", "validation_required"),
    C.bool("git_release_mgmt_enabled", "Advanced deploy mode is on.", "git_release_mgmt_enabled"),
    C.bool("allow_warnings", "Commits allowed with LookML warnings.", "allow_warnings"),
    C.bool("is_example", "A Looker example project.", "is_example"),
    C.str("dependency_status", "Remote dependency status.", "dependency_status"),
    C.url("IDE link to the project.", (r) => (r.id != null ? `/projects/${enc(String(r.id))}` : null)),
  ],
  requests: () => [
    {
      path: "/projects",
      query: {
        fields:
          "id,name,uses_git,git_remote_url,git_service_name,git_production_branch_name,pull_request_mode," +
          "validation_required,git_release_mgmt_enabled,allow_warnings,is_example,dependency_status",
      },
    },
  ],
  examples: [
    {
      description: "Projects that do not require pull requests",
      sql: "SELECT name, pull_request_mode, production_branch FROM looker.main.projects WHERE uses_git AND pull_request_mode <> 'required' ORDER BY name",
    },
    {
      description: "Models per project",
      sql: "SELECT p.name, count(m.name) AS models FROM looker.main.projects p LEFT JOIN looker.main.lookml_models m ON m.project_name = p.id GROUP BY ALL ORDER BY models DESC",
    },
  ],
};

export const projectBranches: LookerTableSpec = {
  name: "project_branches",
  description: "Git branches of each LookML project: production flag, ahead/behind counts, last commit time.",
  title: "Looker Project Git Branches",
  category: "lookml",
  keywords: "looker, lookml, git, branches, commits, development mode",
  docLlm:
    "One row per git branch per LookML project (all_git_branches, as seen by the API user). Columns: tool, " +
    "project_id, name, is_production, personal, readonly, is_local, is_remote, remote, remote_name, " +
    "ahead_count, behind_count, commit_at, ref, remote_ref, owner_name, error, message. WHERE project_id = / IN " +
    "reads only those projects; otherwise one API call per project.",
  docMd: "Git branches per project, one API call per project unless `project_id` is filtered.",
  pushdown: "`project_id = …` / `IN (…)` reads only those projects.",
  key: ["project_id", "name"],
  columns: [
    C.tool(),
    C.ctx("project_id", "LookML project id.", "project_id"),
    C.str("name", "Branch name.", "name", false),
    C.bool("is_production", "The production branch.", "is_production"),
    C.bool("personal", "A personal (dev) branch.", "personal"),
    C.bool("readonly", "Read-only for the API user.", "readonly"),
    C.bool("is_local", "Exists locally on the Looker instance.", "is_local"),
    C.bool("is_remote", "Exists on the remote.", "is_remote"),
    C.str("remote", "Remote name.", "remote"),
    C.str("remote_name", "Branch name on the remote.", "remote_name"),
    C.bigint("ahead_count", "Number of local commits not yet pushed to the remote.", "ahead_count"),
    C.bigint("behind_count", "Number of remote commits not yet pulled.", "behind_count"),
    C.time("commit_at", "Time of the branch's head commit.", "commit_at"),
    C.str("ref", "Head commit SHA.", "ref"),
    C.str("remote_ref", "Remote head commit SHA.", "remote_ref"),
    C.str("owner_name", "Owner of a personal branch.", "owner_name"),
    C.str("error", "Git error, if any.", "error"),
    C.str("message", "Git status message.", "message"),
  ],
  fanout: {
    parents: async (ctx) =>
      eqValues(ctx.constraints, "project_id") ??
      defaultRows(await lookerRequest(ctx.cfg, "/projects", { query: { fields: "id" } }))
        .map((p) => asStr(p.id))
        .filter((x): x is string => !!x),
    child: (pid) => ({ path: `/projects/${enc(pid)}/git_branches`, ctx: { project_id: pid }, notFoundEmpty: true }),
  },
  examples: [
    {
      description: "Stale branches behind production",
      sql: "SELECT project_id, name, behind_count, commit_at FROM looker.main.project_branches WHERE behind_count > 0 ORDER BY behind_count DESC",
    },
    {
      description: "Production branch head per project",
      sql: "SELECT project_id, name, ref, commit_at FROM looker.main.project_branches WHERE is_production ORDER BY project_id",
    },
  ],
};

// ----------------------------------------------------------------- schedules / alerts

export const schedules: LookerTableSpec = {
  name: "schedules",
  description:
    "Scheduled deliveries of dashboards, Looks and queries; recipients summarised as counts and email domains.",
  title: "Looker Schedules",
  category: "delivery",
  keywords: "looker, schedules, scheduled plans, deliveries, email, crontab, datagroup",
  docLlm:
    "One row per scheduled plan, across all users (all_scheduled_plans with all_users=true). Columns: tool, id, " +
    "title (name), owner, owner_id, enabled, content_type (dashboard / look / lookml_dashboard / query), " +
    "dashboard_id, look_id, lookml_dashboard_id, query_id, crontab, datagroup, timezone, run_once, " +
    "run_as_recipient, require_results, require_no_results, require_change, send_all_results, include_links, " +
    "created_at, updated_at, last_run_at, next_run_at, destination_count, destination_types, " +
    "destination_formats, recipient_domains, url. Recipient addresses, webhook URLs and destination " +
    "parameters are never returned — only counts, types and email domains. WHERE owner_id pushes down.",
  docMd: "Schedules with recipients masked to counts and email domains, for delivery audits.",
  pushdown: "`owner_id = …` becomes the `user_id` parameter.",
  columns: [
    C.tool(),
    id("Scheduled plan id."),
    C.str("title", "Schedule name.", "name"),
    C.str("owner", "Display name of the schedule's owner.", "user.display_name"),
    C.str("owner_id", "Id of the schedule's owner.", "user_id"),
    C.bool("enabled", "Whether the schedule is enabled.", "enabled"),
    C.str("content_type", "What is delivered: dashboard, look, lookml_dashboard or query.", (r) =>
      r.dashboard_id
        ? "dashboard"
        : r.look_id
          ? "look"
          : r.lookml_dashboard_id
            ? "lookml_dashboard"
            : r.query_id
              ? "query"
              : null,
    ),
    C.str("dashboard_id", "Delivered dashboard id.", "dashboard_id"),
    C.str("look_id", "Delivered Look id.", "look_id"),
    C.str("lookml_dashboard_id", "Delivered LookML dashboard id.", "lookml_dashboard_id"),
    C.str("query_id", "Delivered query id.", "query_id"),
    C.str("crontab", "Cron schedule (NULL when triggered by a datagroup).", "crontab"),
    C.str("datagroup", "Datagroup that triggers the schedule.", "datagroup"),
    C.str("timezone", "Timezone of the crontab.", "timezone"),
    C.bool("run_once", "One-off delivery.", "run_once"),
    C.bool("run_as_recipient", "Runs with each recipient's permissions.", "run_as_recipient"),
    C.bool("require_results", "Only send when there are results.", "require_results"),
    C.bool("require_no_results", "Only send when there are no results.", "require_no_results"),
    C.bool("require_change", "Only send when results changed.", "require_change"),
    C.bool("send_all_results", "Send all results (not just the row limit).", "send_all_results"),
    C.bool("include_links", "Include links back to Looker.", "include_links"),
    C.time("created_at", "When the schedule was created.", "created_at"),
    C.time("updated_at", "When the schedule was last updated.", "updated_at"),
    C.time("last_run_at", "When the schedule last ran.", "last_run_at"),
    C.time("next_run_at", "When the schedule runs next.", "next_run_at"),
    C.int("destination_count", "Number of destinations.", (r) => maskDest(r).count),
    C.strList(
      "destination_types",
      "Destination types: email, action_hub, s3, sftp, webhook …",
      (r) => maskDest(r).types,
    ),
    C.strList("destination_formats", "Delivery formats: csv, wysiwyg_pdf, inline_json …", (r) => maskDest(r).formats),
    C.strList(
      "recipient_domains",
      "Distinct email domains of the recipients (never the addresses).",
      (r) => maskDest(r).domains,
    ),
    C.url("Web UI link to the delivered content.", (r) =>
      r.dashboard_id
        ? `/dashboards/${enc(String(r.dashboard_id))}`
        : r.look_id
          ? `/looks/${enc(String(r.look_id))}`
          : null,
    ),
  ],
  requests: (ctx) => [
    {
      path: "/scheduled_plans",
      query: {
        all_users: true,
        user_id: strParam(ctx, "owner_id"),
        fields:
          "id,name,user_id,user,enabled,dashboard_id,look_id,lookml_dashboard_id,query_id,crontab,datagroup,timezone," +
          "run_once,run_as_recipient,require_results,require_no_results,require_change,send_all_results," +
          "include_links,created_at,updated_at,last_run_at,next_run_at,scheduled_plan_destination",
      } satisfies Q,
    },
  ],
  examples: [
    {
      description: "Schedules sending outside the company domain",
      sql: "SELECT id, title, owner, recipient_domains FROM looker.main.schedules WHERE enabled AND NOT list_has_all(['example.com'], recipient_domains) ORDER BY id",
    },
    {
      description: "Deliveries per format",
      sql: "SELECT format, count(*) AS schedules FROM (SELECT unnest(destination_formats) AS format FROM looker.main.schedules) GROUP BY ALL ORDER BY schedules DESC",
    },
  ],
};

function maskDest(r: Row) {
  return maskDestinations(r.scheduled_plan_destination, "address", "type", "format");
}
function maskAlertDest(r: Row) {
  return maskDestinations(r.destinations, "email_address", "destination_type");
}

export const alerts: LookerTableSpec = {
  name: "alerts",
  description:
    "Dashboard-tile alerts: field, condition, threshold, schedule and owner; recipients as counts and domains.",
  title: "Looker Alerts",
  category: "delivery",
  keywords: "looker, alerts, thresholds, conditions, notifications, monitoring",
  docLlm:
    "One row per alert across all owners (search_alerts with all_owners=true). Columns: tool, id, title " +
    "(custom_title), description, owner, owner_id, dashboard_element_id, lookml_dashboard_id, field_name, " +
    "field_title, comparison_type (GREATER_THAN, INCREASES_BY …), threshold, cron, is_disabled, " +
    "disabled_reason, is_public, followable, investigative_content_type, investigative_content_id, " +
    "destination_count, destination_types, recipient_domains. Email addresses and action parameters are never " +
    "returned. WHERE is_disabled pushes down.",
  docMd: "Alerts with recipients masked to counts and email domains.",
  pushdown: "`is_disabled = true/false` becomes the `disabled` parameter.",
  columns: [
    C.tool(),
    id("Alert id."),
    C.str("title", "Custom alert title.", "custom_title"),
    C.str("description", "Alert description.", "description"),
    C.str("owner", "Display name of the alert's owner.", "owner_display_name"),
    C.str("owner_id", "Id of the alert's owner.", "owner_id"),
    C.str("dashboard_element_id", "Dashboard tile the alert watches.", "dashboard_element_id"),
    C.str("lookml_dashboard_id", "LookML dashboard the alert watches.", "lookml_dashboard_id"),
    C.str("field_name", "Field the alert evaluates.", "field.name"),
    C.str("field_title", "Title of the field the alert evaluates.", "field.title"),
    C.str("comparison_type", "Condition: EQUAL_TO, GREATER_THAN, INCREASES_BY …", "comparison_type"),
    C.num(
      "threshold",
      "Value the field is compared with, in the field's own units (or percent for INCREASES_BY / DECREASES_BY).",
      "threshold",
    ),
    C.str("cron", "How often the alert is checked (cron).", "cron"),
    C.bool("is_disabled", "Whether the alert is disabled.", "is_disabled"),
    C.str("disabled_reason", "Why the alert was disabled.", "disabled_reason"),
    C.bool("is_public", "Visible to other users.", "is_public"),
    C.bool("followable", "Other users can follow it.", "followable"),
    C.str("investigative_content_type", "Linked content type (dashboard).", "investigative_content_type"),
    C.str("investigative_content_id", "Linked content id.", "investigative_content_id"),
    C.int("destination_count", "Number of destinations.", (r) => maskAlertDest(r).count),
    C.strList("destination_types", "Destination types: EMAIL, ACTION_HUB.", (r) => maskAlertDest(r).types),
    C.strList(
      "recipient_domains",
      "Distinct email domains of the recipients (never the addresses).",
      (r) => maskAlertDest(r).domains,
    ),
  ],
  requests: (ctx) => [
    {
      path: "/alerts/search",
      paged: true,
      query: { all_owners: true, disabled: boolParam(ctx, "is_disabled") } satisfies Q,
    },
  ],
  examples: [
    {
      description: "Disabled alerts and why",
      sql: "SELECT id, title, owner, disabled_reason FROM looker.main.alerts WHERE is_disabled ORDER BY id",
    },
    {
      description: "Alerts per watched field",
      sql: "SELECT field_name, comparison_type, count(*) AS alerts FROM looker.main.alerts GROUP BY ALL ORDER BY alerts DESC",
    },
  ],
};

export const RESOURCE_SPECS: LookerTableSpec[] = [
  dashboards,
  dashboardElements,
  looks,
  charts,
  queries,
  folders,
  users,
  groups,
  roles,
  connections,
  projects,
  projectBranches,
  schedules,
  alerts,
];

export const RESOURCE_TABLES: TableDescriptor[] = RESOURCE_SPECS.map(defineLookerCatalogTable);

export type { Col };
