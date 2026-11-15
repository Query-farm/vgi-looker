/**
 * Discovery metadata: the one file to edit when you rename or extend the worker.
 *
 * DuckDB, coding agents and the `vgi-lint` metadata checker all read these
 * tags. Keep every object documented and `make lint-explain` stays at 100.
 *
 * - Catalog-level tags (title, license, author, links, long description) live in
 *   `CATALOG_TAGS` below.
 * - Every function carries `objectTags(...)`: a title, a category from
 *   `SCHEMA_CATEGORIES`, search keywords, and LLM- and human-facing docs.
 */

import { field, type VgiDataType, type VgiField } from "@query-farm/vgi";

export const CATALOG_NAME = "looker";
export const VERSION = "0.1.0";

export const SOURCE_URL = "https://github.com/Query-farm/vgi-looker";

/**
 * Categories group functions in docs and agent tools. Every object's
 * `vgi.category` must name one of these.
 */
export const SCHEMA_CATEGORIES = [
  {
    name: "content",
    title: "Content",
    description: "Dashboards, tiles, Looks, unified charts, the queries behind them, and folders.",
  },
  {
    name: "usage",
    title: "Usage (System Activity)",
    description: "Content views per day and query run history from the System Activity model.",
  },
  { name: "admin", title: "Administration", description: "Users, groups, roles and database connections." },
  {
    name: "lookml",
    title: "LookML and Lineage",
    description: "LookML projects and branches, models, explores, fields and the warehouse tables behind them.",
  },
  {
    name: "delivery",
    title: "Schedules and Alerts",
    description: "Scheduled deliveries and alerts (recipients masked).",
  },
  { name: "results", title: "Results", description: "Run a saved Look or query and get typed rows." },
] as const;

export type Category = (typeof SCHEMA_CATEGORIES)[number]["name"];

/** Turn `"a, b, c"` into the JSON array string `vgi.keywords` requires. */
export function keywordsArray(keywords: string): string {
  return JSON.stringify(
    keywords
      .split(",")
      .map((k) => k.trim())
      .filter(Boolean),
  );
}

/** Build the standard per-object discovery tags. */
export function objectTags(opts: {
  title: string;
  category: Category;
  keywords: string;
  docLlm: string;
  docMd: string;
}): Record<string, string> {
  return {
    "vgi.title": opts.title,
    "vgi.category": opts.category,
    "vgi.keywords": keywordsArray(opts.keywords),
    "vgi.doc_llm": opts.docLlm,
    "vgi.doc_md": opts.docMd,
  };
}

/** Build an Arrow field whose `comment` shows up in DuckDB's `DESCRIBE` and agent tools. */
export function column(name: string, type: VgiDataType, comment: string, nullable = true): VgiField {
  return field(name, type, nullable, new Map([["comment", comment]]));
}

const SOURCES_MD =
  "### Sources and references\n\n" +
  "- [Looker API 4.0 reference](https://cloud.google.com/looker/docs/reference/looker-api/latest) — the endpoints this worker reads\n" +
  "- [API authentication](https://cloud.google.com/looker/docs/api-auth) — client id / secret login\n" +
  "- [System Activity](https://cloud.google.com/looker/docs/system-activity-pages) — the usage model behind content_usage and query_history\n" +
  "- [run_inline_query](https://cloud.google.com/looker/docs/reference/looker-api/latest/methods/Query/run_inline_query) and [filter expressions](https://cloud.google.com/looker/docs/filter-expressions)";

export const CATALOG_COMMENT =
  "Looker metadata and usage as SQL: dashboards, tiles, Looks, folders, users, connections, LookML explores and lineage, schedules, alerts and System Activity, read-only.";

export const CATALOG_DOC_LLM =
  "Read-only SQL access to a Looker instance (Looker (Google Cloud core) or original Looker) through API 4.0. " +
  "Reach for it to inventory BI content (dashboards, dashboard_elements tiles, looks, charts, queries, folders " +
  "with full paths), audit access (users without credentials, groups, roles, connections without passwords), " +
  "trace lineage from explores to warehouse tables (lookml_models, explores, explore_fields, explore_tables " +
  "with parsed sql_table_name for joining dbt or OpenLineage), review delivery (schedules and alerts with " +
  "recipients masked to counts and email domains), measure adoption and performance from System Activity " +
  "(content_usage: views per content per day; query_history: runtime, source, status per query), and fetch " +
  "results with run_look(id) / run_query(id). Everything needs a `looker` DuckDB secret: BASE_URL (API host, " +
  "e.g. https://acme.cloud.looker.com or https://acme.looker.com:19999), CLIENT_ID and CLIENT_SECRET (an API " +
  "key pair); optional WEB_URL and PAGE_SIZE. Content tables share columns with the Tableau and Metabase " +
  "workers (tool, id, title, folder_path, owner, created_at, updated_at, last_viewed_at, view_count, url) so " +
  "they UNION across BI tools. WHERE filters push down into Looker search parameters and System Activity " +
  "filters and are re-checked exactly. Docs: https://cloud.google.com/looker/docs/reference/looker-api/latest .";

export const CATALOG_DOC_MD =
  "# Looker\n\n" +
  "Query a Looker instance from DuckDB: dashboards and tiles, Looks, folders, users, groups, roles, " +
  "connections, LookML models / explores / fields, explore-to-table lineage, git branches, schedules, alerts, " +
  "and usage from System Activity. Read-only.\n\n" +
  "Create a `looker` secret with your API host (`BASE_URL`) and an API key pair (`CLIENT_ID`, " +
  "`CLIENT_SECRET`). Filters become Looker search parameters and System Activity filters; secrets such as " +
  "connection passwords, git credentials and schedule recipients are never returned.\n\n" +
  SOURCES_MD;

export const SCHEMA_DOC_LLM =
  "Looker API 4.0 collections as tables, plus two result functions. Content: dashboards, dashboard_elements, " +
  "looks, charts (tiles + Looks), queries, folders. Admin: users, groups, roles, connections. LookML: projects, " +
  "project_branches, lookml_models, explores, explore_fields, explore_tables. Delivery: schedules, alerts. " +
  "Usage: content_usage, query_history (System Activity; filter the date column to pick the window). Results: " +
  "run_look(look_id), run_query(query_id). Per-explore and per-query tables make one API call per item, so " +
  "filter model_name / explore_name / id when you can. All objects need a `looker` secret.";

export const SCHEMA_DOC_MD =
  "## main\n\n" +
  "Looker content, administration, LookML lineage, delivery and System Activity usage as tables; " +
  "`run_look` and `run_query` return typed results.\n\n" +
  "All objects need a `looker` secret; filters push down into Looker search parameters and System Activity " +
  "inline-query filters.";

export const AGENT_TEST_TASKS = [
  { name: "most_viewed_dashboards", prompt: "Which three Looker dashboards have the most views?" },
  { name: "marketing_folder_dashboards", prompt: "List the titles of dashboards in the /Shared/Marketing folder." },
  { name: "tiles_per_explore", prompt: "How many dashboard tiles query each explore?" },
  { name: "public_looks", prompt: "Which Looks are public?" },
  { name: "disabled_users", prompt: "Which Looker users are disabled? Give their emails." },
  { name: "admin_users", prompt: "Which users hold the Admin role?" },
  { name: "connection_dialects", prompt: "What database dialect does each Looker connection use?" },
  { name: "orders_lineage", prompt: "Which warehouse tables does the thelook orders explore read?" },
  { name: "measures_of_orders", prompt: "List the measures of the thelook orders explore." },
  { name: "external_schedules", prompt: "Which schedules send to email domains other than example.com?" },
  { name: "project_pr_mode", prompt: "Which LookML projects do not require pull requests?" },
  { name: "query_errors", prompt: "How many Looker queries ended in error over the last 7 days, by source?" },
  { name: "disabled_alerts", prompt: "Which Looker alerts are disabled, and why?" },
  { name: "chart_counts", prompt: "How many charts are there of each kind (dashboard tiles vs saved Looks)?" },
  {
    name: "dashboard_views_30d",
    prompt: "How many times was each dashboard viewed in the last 30 days, per System Activity?",
  },
  { name: "hidden_explores", prompt: "Which explores of the thelook model are hidden?" },
  { name: "shared_subfolders", prompt: "Which folders sit directly under the Shared folder?" },
  { name: "external_groups", prompt: "Which Looker groups are managed by an external identity provider?" },
  { name: "model_projects", prompt: "Which LookML project defines each model?" },
  { name: "behind_branches", prompt: "Which LookML git branches are behind their remote, and by how many commits?" },
  { name: "query_101_filters", prompt: "What filters does Looker query 101 apply?" },
  { name: "look_21_results", prompt: "Run Look 21 and give the total of its orders count." },
  { name: "query_103_us", prompt: "Run query 103: how many buyers are in the US?" },
];

/** Bind-only probes: each binds the table and shows its columns without fetching (LIMIT 0). */
export const EXECUTABLE_EXAMPLES = [
  {
    name: "dashboards_columns",
    description: "The dashboards columns (binds only; create a looker secret and drop LIMIT 0 for rows)",
    sql: "SELECT tool, id, title, folder_path, owner, view_count, url FROM looker.main.dashboards LIMIT 0",
  },
  {
    name: "query_history_columns",
    description: "The query_history columns (binds only; create a looker secret and drop LIMIT 0 for rows)",
    sql: "SELECT created_at, runtime_seconds, status, source, explore FROM looker.main.query_history LIMIT 0",
  },
];

export const CATALOG_TAGS: Record<string, string> = {
  "vgi.title": "Looker BI Metadata",
  "vgi.subtitle": "Looker dashboards, Looks, explores, lineage, schedules and System Activity usage as SQL tables.",
  "vgi.doc_llm": CATALOG_DOC_LLM,
  "vgi.doc_md": CATALOG_DOC_MD,
  "vgi.source_url": SOURCE_URL,
  "vgi.icon_url": "https://query.farm/media-kit/products/vgi/vgi-logo.png",
  "vgi.license": "0BSD",
  "vgi.author": "Query Farm LLC",
  "vgi.copyright": "Copyright 2026 Query Farm LLC - https://query.farm",
  "vgi.keywords": keywordsArray(
    "looker, bi, business intelligence, dashboards, looks, lookml, explores, lineage, system activity, usage, google cloud",
  ),
  "vgi.support_contact": `${SOURCE_URL}/issues`,
  "vgi.support_policy_url": `${SOURCE_URL}#support`,
  // Public analyst tasks for `vgi-lint simulate`; private graders live in vgi-agent-tests.yaml.
  "vgi.agent_test_tasks": JSON.stringify(AGENT_TEST_TASKS),
  "vgi.executable_examples": JSON.stringify(EXECUTABLE_EXAMPLES),
};

export const SCHEMA_TAGS: Record<string, string> = {
  "vgi.title": "Looker API",
  domain: "business-intelligence",
  "vgi.keywords": keywordsArray("looker, dashboards, looks, explores, lineage, users, schedules, system activity"),
  "vgi.doc_llm": SCHEMA_DOC_LLM,
  "vgi.doc_md": SCHEMA_DOC_MD,
  "vgi.categories": JSON.stringify(SCHEMA_CATEGORIES),
};
