/**
 * Usage from Looker's System Activity model, read with `run_inline_query`
 * (`POST /api/4.0/queries/run/json`). An inline query is a read-only SELECT
 * against the `system__activity` LookML model: nothing is saved or changed.
 *
 * - `content_usage`: views per dashboard / Look per day (explore `history`).
 * - `query_history`: one row per query run with runtime, source, status, user and explore.
 *
 * WHERE filters become the inline query's `filters` (the date window, status,
 * source, model, explore, user, content ids). The window is read in chunks (one
 * inline query per chunk) whose position is the scan state, so a long window
 * resumes across processes and never asks for an unbounded result.
 */

import {
  constraintRecord,
  dateDay,
  defineTableFunction,
  float64,
  formatPushedFilters,
  int64,
  type TableDescriptor,
  timestampMicros,
  utf8,
} from "@query-farm/vgi";
import { log } from "../log.ts";
import type { Category } from "../meta.ts";
import { configFromSecrets, LookerError, lookerRequest, SECRET_TYPE } from "./client.ts";
import { type Constraint, constraintsOf, eqValues, filterAnyOf, filterRange, timeBounds } from "./pushdown.ts";
import {
  asBigInt,
  asDate,
  asNum,
  asStr,
  asTime,
  type Col,
  emitRows,
  type FnExample,
  outputSchemaOf,
  type Row,
  TOOL,
  tagsOf,
} from "./table.ts";

export const SYSTEM_ACTIVITY_MODEL = "system__activity";
/** Rows per inline query; a chunk that returns this many is refused (narrow the filter). */
export const INLINE_ROW_CAP = 50_000;
const DAY = 86_400_000;

/** A column read from one System Activity field of the inline query result. */
function f(
  name: string,
  doc: string,
  kind: "str" | "time" | "date" | "num" | "int",
  get: (r: Row) => unknown,
  nullable = true,
): Col {
  const types = {
    str: [utf8(), "VARCHAR", asStr],
    time: [timestampMicros("UTC"), "TIMESTAMP WITH TIME ZONE", asTime],
    date: [dateDay(), "DATE", asDate],
    num: [float64(), "DOUBLE", asNum],
    int: [int64(), "BIGINT", asBigInt],
  } as const;
  const [type, sqlType, conv] = types[kind];
  return { name, doc, type, sqlType, nullable, get: (r) => (conv as (v: unknown) => unknown)(get(r)) };
}
const k = (key: string) => (r: Row) => r[key];

/** One inline query of a phase. */
export interface InlineQuery {
  view: string;
  fields: string[];
  filters: Record<string, string>;
  sorts: string[];
  /** Per-phase values exposed to rows as `__ctx`. */
  ctx?: Record<string, string>;
}

/** The scan window from pushed bounds on `column`, defaulting to the last `defaultDays` days. */
export function scanWindow(
  constraints: Constraint[],
  column: string,
  isDate: boolean,
  anchorMs: number,
  defaultDays: number,
): [number, number] {
  const b = timeBounds(constraints, column, isDate);
  // Whole UTC days for DATE columns; whole seconds otherwise.
  const endOfToday = Math.floor(anchorMs / DAY) * DAY + DAY;
  const upper = b.upper ?? (isDate ? endOfToday : Math.ceil(anchorMs / 1000) * 1000 + 1000);
  const lower = b.lower ?? (isDate ? endOfToday - defaultDays * DAY : upper - defaultDays * DAY);
  return [lower, Math.max(lower, upper)];
}

interface ActivitySpec {
  name: string;
  description: string;
  title: string;
  category: Category;
  keywords: string;
  docLlm: string;
  docMd: string;
  pushdown: string;
  columns: Col[];
  key: string[];
  /** Fixed list of inline queries (read in order). */
  phases?: (constraints: Constraint[], anchorMs: number) => InlineQuery[];
  /** Or: a TIMESTAMPTZ window read newest-first in adaptive chunks. */
  windowed?: {
    column: string;
    defaultDays: number;
    chunkDays: number;
    query: (constraints: Constraint[], lo: number, hi: number) => InlineQuery;
  };
  /** Post-process one phase's rows (e.g. window-level aggregates). */
  finish?: (rows: Row[], q: InlineQuery) => Row[];
  examples: FnExample[];
}

interface State {
  phase: number;
  anchorMs: number;
  /** Windowed scans: exclusive upper end of the part not yet read (epoch ms). */
  hi: number;
  /** Windowed scans: current chunk length (0 = not started). */
  chunkMs: number;
}

/** Smallest chunk a windowed scan shrinks to before giving up. */
export const MIN_CHUNK_MS = 3_600_000;
/** Largest chunk a sparse windowed scan grows to. */
export const MAX_CHUNK_MS = 366 * 86_400_000;

/** Build the inline-query body for one phase. */
export function inlineBody(q: InlineQuery) {
  return {
    model: SYSTEM_ACTIVITY_MODEL,
    view: q.view,
    fields: q.fields,
    filters: q.filters,
    sorts: q.sorts,
    limit: String(INLINE_ROW_CAP),
    query_timezone: "UTC",
  };
}

function defineActivityTable(spec: ActivitySpec): TableDescriptor {
  const outSchema = outputSchemaOf(spec.columns);
  const fn = defineTableFunction<Record<string, never>, State>({
    name: `${spec.name}_scan`,
    description: spec.description,
    args: {},
    filterPushdown: true,
    autoApplyFilters: true,
    onBind: (params) =>
      params.resolvedSecretsProvided
        ? { outputSchema: outSchema }
        : { outputSchema: outSchema, lookupSecretTypes: [SECRET_TYPE] },
    initialState: () => ({ phase: 0, anchorMs: Date.now(), hi: 0, chunkMs: 0 }),
    process: async (params, state, out) => {
      const cfg = configFromSecrets(params.secrets);
      const constraints = constraintsOf(params.pushdownFilters);
      log.debug(`${spec.name}: pushed filters ${formatPushedFilters(params.pushdownFilters)}`);
      const run = async (q: InlineQuery): Promise<Row[]> => {
        const body = await lookerRequest(cfg, "/queries/run/json", {
          method: "POST",
          query: { apply_formatting: false, apply_vis: false, cache: true },
          json: inlineBody(q),
        });
        if (!Array.isArray(body)) {
          // Looker reports query errors inside a JSON object rather than an HTTP error.
          const msg =
            asStr((body as Row | null)?.looker_error ?? (body as Row | null)?.message) ?? "unexpected response";
          throw new LookerError(`System Activity query failed: ${msg}`);
        }
        return (body as Row[]).map((r) => ({ ...r, __ctx: q.ctx ?? {}, __web: cfg.webUrl }));
      };
      const emit = (rows: Row[]): boolean => {
        if (!rows.length) return false;
        emitRows(out, params.outputSchema, spec.columns, rows);
        return true;
      };

      if (spec.windowed) {
        // Walk the window newest-first in chunks; a chunk that hits the row cap is
        // retried smaller, down to MIN_CHUNK_MS.
        const w = spec.windowed;
        const [lower, upper] = scanWindow(constraints, w.column, false, state.anchorMs, w.defaultDays);
        if (state.chunkMs === 0) {
          state.hi = upper;
          state.chunkMs = w.chunkDays * DAY;
        }
        for (;;) {
          if (state.hi <= lower) {
            out.finish();
            return;
          }
          const lo = Math.max(lower, state.hi - state.chunkMs);
          const rows = await run(w.query(constraints, lo, state.hi));
          if (rows.length >= INLINE_ROW_CAP) {
            if (state.chunkMs <= MIN_CHUNK_MS) {
              throw new LookerError(
                `System Activity returned ${INLINE_ROW_CAP} rows for one hour; add filters (status, source, model …)`,
              );
            }
            state.chunkMs = Math.max(MIN_CHUNK_MS, Math.floor(state.chunkMs / 4));
            continue;
          }
          state.hi = lo;
          // Sparse chunks grow the next one (up to MAX_CHUNK_MS) so long windows need few queries.
          if (rows.length < INLINE_ROW_CAP / 4) state.chunkMs = Math.min(MAX_CHUNK_MS, state.chunkMs * 2);
          if (emit(rows)) return;
        }
      }

      const phases = spec.phases?.(constraints, state.anchorMs) ?? [];
      for (;;) {
        const q = phases[state.phase];
        if (!q) {
          out.finish();
          return;
        }
        state.phase += 1;
        let rows = await run(q);
        if (rows.length >= INLINE_ROW_CAP) {
          throw new LookerError(
            `System Activity returned ${INLINE_ROW_CAP} rows for one query; narrow the time window or add filters`,
          );
        }
        if (spec.finish) rows = spec.finish(rows, q);
        if (emit(rows)) return;
      }
    },
    tags: tagsOf(spec),
    examples: spec.examples,
  });
  const record = (id: string, kind: "NOT_NULL" | "PRIMARY_KEY", cols: string[][]) =>
    constraintRecord({
      schemaPath: ["main"],
      table: spec.name,
      id,
      kind,
      columns: cols,
      enforcement: "ENFORCED",
      validation: "ALL_ROWS",
    });
  return {
    name: spec.name,
    comment: spec.description,
    columns: outSchema,
    function: fn,
    constraints: [
      ...spec.key.map((c) => record(`${c}_not_null`, "NOT_NULL", [[c]])),
      record(
        "pk",
        "PRIMARY_KEY",
        spec.key.map((c) => [c]),
      ),
    ],
    tags: { ...tagsOf(spec), "vgi.example_queries": JSON.stringify(spec.examples) },
  };
}

// --------------------------------------------------------------------- content_usage

export const CONTENT_USAGE_DEFAULT_DAYS = 30;
const enc = encodeURIComponent;

export const contentUsageSpec: ActivitySpec = {
  name: "content_usage",
  description: "Views per dashboard and Look per day, from System Activity (history).",
  title: "Looker Content Usage",
  category: "usage",
  keywords: "looker, usage, views, adoption, system activity, dashboards, looks, popularity",
  docLlm:
    "Daily usage of each dashboard and Look from Looker's System Activity (`system__activity` model, `history` " +
    "explore) via a read-only inline query. One row per (content_type, content_id, view_date). Columns: tool, " +
    "content_type ('dashboard' or 'look'), content_id, title, view_date (UTC day), view_count (dashboard runs, " +
    "or runs of the Look from the Look page), user_count (distinct users that day), last_view_date (latest day " +
    "with a view in the scanned window), url. The window comes from WHERE view_date bounds (default: the last 30 " +
    "days; System Activity keeps ~90 days). content_type and content_id filters push down. Needs the API user to " +
    "have the see_system_activity permission.",
  docMd:
    "Per-day views of dashboards and Looks from System Activity. Filter `view_date` to choose the window " +
    "(default last 30 days).",
  pushdown:
    "`view_date` bounds become the `history.created_time` filter (default last 30 days); `content_type` picks " +
    "the dashboard and/or Look query; `content_id = / IN` filters `dashboard.id` / `look.id`.",
  key: ["content_type", "content_id", "view_date"],
  columns: [
    { ...f("tool", "The BI tool: always 'looker'.", "str", () => TOOL, false) },
    f("content_type", "'dashboard' or 'look'.", "str", (r) => r.__ctx?.kind, false),
    f("content_id", "Dashboard or Look id.", "str", (r) => r[`${r.__ctx?.kind}.id`], false),
    f("title", "Dashboard or Look title.", "str", (r) => r[`${r.__ctx?.kind}.title`]),
    f("view_date", "UTC day of the views.", "date", k("history.created_date"), false),
    f("view_count", "Views that day (dashboard runs / Look page runs).", "int", (r) =>
      r.__ctx?.kind === "dashboard" ? r["history.dashboard_run_count"] : r["history.query_run_count"],
    ),
    f("user_count", "Distinct users who viewed it that day.", "int", k("user.count")),
    f("last_view_date", "Latest day with a view of this content in the scanned window.", "date", k("__last")),
    {
      ...f("url", "Web UI link to the content.", "str", (r) => {
        const kind = r.__ctx?.kind;
        const id = r[`${kind}.id`];
        return id == null || !r.__web
          ? null
          : `${r.__web}/${kind === "dashboard" ? "dashboards" : "looks"}/${enc(String(id))}`;
      }),
    },
  ],
  phases: (cs, anchorMs) => {
    const [lower, upper] = scanWindow(cs, "view_date", true, anchorMs, CONTENT_USAGE_DEFAULT_DAYS);
    if (upper <= lower) return [];
    const kinds = eqValues(cs, "content_type");
    const ids = eqValues(cs, "content_id");
    const window = filterRange(lower, upper);
    const out: InlineQuery[] = [];
    for (const kind of ["dashboard", "look"] as const) {
      if (kinds && !kinds.includes(kind)) continue;
      const filters: Record<string, string> = {
        "history.created_time": window,
        [`${kind}.id`]: ids ? filterAnyOf(ids) : "NOT NULL",
      };
      if (kind === "look") filters["history.source"] = "look";
      out.push({
        view: "history",
        fields:
          kind === "dashboard"
            ? ["history.created_date", "dashboard.id", "dashboard.title", "history.dashboard_run_count", "user.count"]
            : ["history.created_date", "look.id", "look.title", "history.query_run_count", "user.count"],
        filters,
        sorts: [`${kind}.id`, "history.created_date"],
        ctx: { kind },
      });
    }
    return out;
  },
  finish: (rows, q) => {
    const kind = q.ctx?.kind;
    const last = new Map<string, string>();
    for (const r of rows) {
      const id = String(r[`${kind}.id`]);
      const d = asStr(r["history.created_date"]) ?? "";
      if (d > (last.get(id) ?? "")) last.set(id, d);
    }
    return rows.map((r) => ({ ...r, __last: last.get(String(r[`${kind}.id`])) ?? null }));
  },
  examples: [
    {
      description: "Top dashboards by views over the last 30 days",
      sql: "SELECT content_id, title, sum(view_count) AS views, max(user_count) AS peak_daily_users FROM looker.main.content_usage WHERE content_type = 'dashboard' GROUP BY ALL ORDER BY views DESC LIMIT 10",
    },
    {
      description: "Daily dashboard views for one week",
      sql: "SELECT view_date, sum(view_count) AS views FROM looker.main.content_usage WHERE view_date >= DATE '2026-11-01' AND view_date < DATE '2026-11-08' GROUP BY ALL ORDER BY view_date",
    },
  ],
};

// --------------------------------------------------------------------- query_history

export const QUERY_HISTORY_DEFAULT_DAYS = 7;
const QH_FIELDS = [
  "history.id",
  "history.created_time",
  "history.completed_time",
  "history.runtime",
  "history.status",
  "history.source",
  "history.result_source",
  "history.connection_name",
  "history.dashboard_id",
  "history.message",
  "look.id",
  "query.id",
  "query.model",
  "query.view",
  "user.id",
  "user.email",
];

export const queryHistorySpec: ActivitySpec = {
  name: "query_history",
  description: "Every query Looker ran: runtime, source, status, user, model and explore, from System Activity.",
  title: "Looker Query History",
  category: "usage",
  keywords: "looker, query history, performance, runtime, system activity, slow queries, errors",
  docLlm:
    "One row per query run from Looker's System Activity (`system__activity` model, `history` explore) via a " +
    "read-only inline query. Columns: tool, history_id, created_at, completed_at, runtime_seconds, status " +
    "(complete, error, killed, running …), source (dashboard, explore, api4, scheduled_task, look, …), " +
    "result_source (query, cache, …), connection_name, dashboard_id, look_id, query_id, model, explore, " +
    "user_id, user_email, message (error text). The window comes from WHERE created_at bounds (default: the " +
    "last 7 days), read newest-first in 7-day inline queries (smaller when a chunk is large). status, source, model, explore, user_email, " +
    "connection_name, dashboard_id and look_id filters (= / IN) push down. Needs see_system_activity.",
  docMd:
    "Query runs with runtimes, for performance and adoption analysis. Filter `created_at` to choose the window " +
    "(default last 7 days).",
  pushdown:
    "`created_at` bounds become the `history.created_time` filter (default last 7 days; read newest-first in 7-day chunks that shrink when a chunk " +
    "nears the 50,000-row cap); `status`, `source`, `model`, `explore`, `user_email`, `connection_name`, `dashboard_id` and " +
    "`look_id` (`=` / `IN`) become inline-query filters.",
  key: ["history_id"],
  columns: [
    f("tool", "The BI tool: always 'looker'.", "str", () => TOOL, false),
    f("history_id", "System Activity history id.", "str", k("history.id"), false),
    f("created_at", "When the query started (UTC).", "time", k("history.created_time")),
    f("completed_at", "When the query finished (UTC).", "time", k("history.completed_time")),
    f("runtime_seconds", "Query runtime in seconds.", "num", k("history.runtime")),
    f("status", "complete, error, killed, running, cache_only_miss …", "str", k("history.status")),
    f(
      "source",
      "Where the query came from: dashboard, explore, api4, scheduled_task, look, sql_runner …",
      "str",
      k("history.source"),
    ),
    f("result_source", "query (ran in the database) or cache.", "str", k("history.result_source")),
    f("connection_name", "Database connection.", "str", k("history.connection_name")),
    f("dashboard_id", "Dashboard that ran it, if any.", "str", k("history.dashboard_id")),
    f("look_id", "Look that ran it, if any.", "str", k("look.id")),
    f("query_id", "Query id (join queries.id).", "str", k("query.id")),
    f("model", "LookML model.", "str", k("query.model")),
    f("explore", "Explore queried (System Activity `query.view`).", "str", k("query.view")),
    f("user_id", "User who ran it.", "str", k("user.id")),
    f("user_email", "Email of the user who ran it.", "str", k("user.email")),
    f("message", "Error or status message.", "str", k("history.message")),
  ],
  windowed: {
    column: "created_at",
    defaultDays: QUERY_HISTORY_DEFAULT_DAYS,
    chunkDays: 7,
    query: (cs, lo, hi) => {
      const filters: Record<string, string> = { "history.created_time": filterRange(lo, hi) };
      const push = (column: string, field: string) => {
        const vs = eqValues(cs, column);
        if (vs?.length) filters[field] = filterAnyOf(vs);
      };
      push("status", "history.status");
      push("source", "history.source");
      push("model", "query.model");
      push("explore", "query.view");
      push("user_email", "user.email");
      push("connection_name", "history.connection_name");
      push("dashboard_id", "history.dashboard_id");
      push("look_id", "look.id");
      return { view: "history", fields: QH_FIELDS, filters, sorts: ["history.created_time desc"] };
    },
  },
  examples: [
    {
      description: "Slowest explores over the last 7 days",
      sql: "SELECT model, explore, count(*) AS runs, avg(runtime_seconds) AS avg_s, max(runtime_seconds) AS max_s FROM looker.main.query_history WHERE result_source = 'query' GROUP BY ALL ORDER BY avg_s DESC LIMIT 10",
    },
    {
      description: "Errors by source in a fixed window",
      sql: "SELECT source, count(*) AS errors FROM looker.main.query_history WHERE status = 'error' AND created_at >= TIMESTAMPTZ '2026-11-01' AND created_at < TIMESTAMPTZ '2026-11-08' GROUP BY ALL ORDER BY errors DESC",
    },
  ],
};

export const ACTIVITY_TABLES: TableDescriptor[] = [contentUsageSpec, queryHistorySpec].map(defineActivityTable);
export const ACTIVITY_SPECS = [contentUsageSpec, queryHistorySpec];
