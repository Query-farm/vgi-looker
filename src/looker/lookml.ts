/**
 * LookML metadata: models, explores, explore fields and the warehouse tables behind
 * each explore (lineage).
 *
 * Explore detail needs one `get_lookml_model_explore` call per explore. Pushed
 * `model_name` / `explore_name` filters restrict which explores are read; the list
 * of pending explores lives in the scan state so a long fan-out resumes.
 */

import type { TableDescriptor } from "@query-farm/vgi";
import { lookerRequest } from "./client.ts";
import { eqValues } from "./pushdown.ts";
import {
  asStr,
  C,
  defaultRows,
  defineLookerCatalogTable,
  getAllPages,
  type LookerTableSpec,
  type Row,
  type ScanContext,
} from "./table.ts";

const enc = encodeURIComponent;
const SEP = "::";

export const lookmlModels: LookerTableSpec = {
  name: "lookml_models",
  description: "LookML models: project, allowed connections and the explores they define.",
  title: "LookML Model Catalog",
  category: "lookml",
  keywords: "looker, lookml, models, explores, semantic layer",
  docLlm:
    "One row per LookML model (all_lookml_models). Columns: tool, name, label, project_name, " +
    "allowed_connections (list), unlimited_db_connections, has_content, explore_count, explores (list of " +
    "{name, label, description, group_label, hidden}). Explore details are in explores / explore_fields / " +
    "explore_tables.",
  docMd: "LookML models and their explore lists.",
  key: ["name"],
  columns: [
    C.tool(),
    C.str("name", "Model name.", "name", false),
    C.str("label", "Model label.", "label"),
    C.str("project_name", "LookML project defining the model.", "project_name"),
    C.strList("allowed_connections", "Connections the model may use.", "allowed_db_connection_names"),
    C.bool("unlimited_db_connections", "Model may use any connection.", "unlimited_db_connections"),
    C.bool("has_content", "Model has saved content.", "has_content"),
    C.int("explore_count", "Number of explores.", (r) => (Array.isArray(r.explores) ? r.explores.length : null)),
    C.structList(
      "explores",
      "Explores defined by the model.",
      [
        { name: "name", path: "name" },
        { name: "label", path: "label" },
        { name: "description", path: "description" },
        { name: "group_label", path: "group_label" },
        { name: "hidden", path: "hidden", kind: "bool" },
      ],
      "explores",
    ),
  ],
  requests: () => [
    {
      path: "/lookml_models",
      paged: true,
      query: {
        fields: "name,label,project_name,allowed_db_connection_names,unlimited_db_connections,has_content,explores",
      },
    },
  ],
  examples: [
    {
      description: "Explores per model",
      sql: "SELECT name, project_name, explore_count FROM looker.main.lookml_models ORDER BY explore_count DESC",
    },
    {
      description: "Hidden explores",
      sql: "SELECT m.name AS model, e.name AS explore FROM looker.main.lookml_models m, unnest(m.explores) AS t(e) WHERE e.hidden ORDER BY ALL",
    },
  ],
};

/** `model::explore` keys for the explores a scan needs (honours pushed model/explore filters). */
async function exploreKeys(ctx: ScanContext): Promise<string[]> {
  const models = eqValues(ctx.constraints, "model_name");
  const wanted = eqValues(ctx.constraints, "explore_name");
  let rows: Row[];
  if (models) {
    if (wanted) return models.flatMap((m) => wanted.map((e) => `${m}${SEP}${e}`));
    rows = [];
    for (const m of models) {
      const body = await lookerRequest(ctx.cfg, `/lookml_models/${enc(m)}`, {
        query: { fields: "name,explores" },
        notFoundNull: true,
      });
      if (body) rows.push(body as Row);
    }
  } else {
    rows = await getAllPages(ctx.cfg, "/lookml_models", { fields: "name,explores" });
  }
  const keys: string[] = [];
  for (const m of rows) {
    for (const e of Array.isArray(m.explores) ? (m.explores as Row[]) : []) {
      const name = asStr(e.name);
      if (name && (!wanted || wanted.includes(name))) keys.push(`${m.name}${SEP}${name}`);
    }
  }
  return keys;
}

function exploreRequest(key: string, fields: string) {
  const [model, explore] = key.split(SEP) as [string, string];
  return {
    path: `/lookml_models/${enc(model)}/explores/${enc(explore)}`,
    query: { fields },
    ctx: { model_name: model, explore_name: explore },
    notFoundEmpty: true,
  };
}

const modelCol = C.ctx("model_name", "LookML model.", "model_name");
const exploreCol = C.ctx(
  "explore_name",
  "Explore as named in the LookML model (the `view` of a query).",
  "explore_name",
);
const exploreUrl = C.url("Web UI link to the explore.", (r) =>
  r.__ctx?.model_name ? `/explore/${enc(r.__ctx.model_name)}/${enc(r.__ctx.explore_name ?? "")}` : null,
);
const countOf = (r: Row, k: string) => (Array.isArray(r.fields?.[k]) ? r.fields[k].length : null);

export const explores: LookerTableSpec = {
  name: "explores",
  description: "LookML explores: base view, sql_table_name, connection, joins and field counts.",
  title: "Looker Explores",
  category: "lookml",
  keywords: "looker, lookml, explores, views, joins, semantic layer",
  docLlm:
    "One row per explore (get_lookml_model_explore, one API call each). Columns: tool, model_name, " +
    "explore_name, label, description, group_label, hidden, view_name (base view), sql_table_name (base table; " +
    "NULL for derived tables), connection_name, project_name, join_count, dimension_count, measure_count, " +
    "tags, url. Filter WHERE model_name = '…' (and explore_name) to avoid reading every explore.",
  docMd: "Explore definitions. Filter on `model_name` / `explore_name` to limit the per-explore API calls.",
  pushdown: "`model_name` and `explore_name` (`=` / `IN`) limit which explores are read.",
  key: ["model_name", "explore_name"],
  columns: [
    C.tool(),
    modelCol,
    exploreCol,
    C.str("label", "Explore label.", "label"),
    C.str("description", "Explore description.", "description"),
    C.str("group_label", "Explore menu group.", "group_label"),
    C.bool("hidden", "Hidden from the explore menu.", "hidden"),
    C.str("view_name", "Base view of the explore.", "view_name"),
    C.str("sql_table_name", "Warehouse table of the base view (NULL for derived tables).", "sql_table_name"),
    C.str("connection_name", "Database connection.", "connection_name"),
    C.str("project_name", "LookML project.", "project_name"),
    C.int("join_count", "Number of joined views.", (r) => (Array.isArray(r.joins) ? r.joins.length : null)),
    C.int("dimension_count", "Number of dimensions.", (r) => countOf(r, "dimensions")),
    C.int("measure_count", "Number of measures.", (r) => countOf(r, "measures")),
    C.strList("tags", "Explore tags.", "tags"),
    exploreUrl,
  ],
  fanout: {
    parents: exploreKeys,
    child: (k) =>
      exploreRequest(
        k,
        "name,label,description,group_label,hidden,view_name,sql_table_name,connection_name,project_name,tags,joins,fields",
      ),
  },
  examples: [
    {
      description: "Explores of one model with their base tables",
      sql: "SELECT explore_name, view_name, sql_table_name, join_count FROM looker.main.explores WHERE model_name = 'thelook' ORDER BY explore_name",
    },
    {
      description: "Largest explores by field count",
      sql: "SELECT model_name, explore_name, dimension_count + measure_count AS fields FROM looker.main.explores ORDER BY fields DESC LIMIT 10",
    },
  ],
};

/** view alias → sql_table_name for the explore's base view and joins. */
function viewTables(e: Row): Map<string, string | null> {
  const m = new Map<string, string | null>();
  if (e.view_name) m.set(String(e.view_name), asStr(e.sql_table_name));
  if (e.name && !m.has(String(e.name))) m.set(String(e.name), asStr(e.sql_table_name));
  for (const j of Array.isArray(e.joins) ? (e.joins as Row[]) : []) {
    if (j.name) m.set(String(j.name), asStr(j.sql_table_name));
  }
  return m;
}

const CATEGORIES = ["dimensions", "measures", "filters", "parameters"] as const;

export const exploreFields: LookerTableSpec = {
  name: "explore_fields",
  description: "Dimensions, measures, filters and parameters of each explore, with view, SQL and the view's table.",
  title: "Looker Explore Fields",
  category: "lookml",
  keywords: "looker, lookml, fields, dimensions, measures, parameters, sql, semantic layer",
  docLlm:
    "One row per field of each explore. Columns: tool, model_name, explore_name, field_name (view.field), " +
    "category (dimension / measure / filter / parameter), type (string, number, count, sum, date_date, yesno …), " +
    "label, label_short, description, view (alias), view_label, sql_table_name (warehouse table of the field's " +
    "view, from the explore's base view or join), sql (LookML SQL), hidden, primary_key, is_numeric, " +
    "is_timeframe, dimension_group, tags, source_file. Filter on model_name / explore_name: each explore is one " +
    "API call.",
  docMd: "Every field of every explore with the warehouse table behind its view.",
  pushdown: "`model_name` and `explore_name` (`=` / `IN`) limit which explores are read.",
  key: ["model_name", "explore_name", "field_name"],
  columns: [
    C.tool(),
    modelCol,
    exploreCol,
    C.str("field_name", "Fully qualified field name (view.field).", "name", false),
    C.str("category", "dimension, measure, filter or parameter.", "__category"),
    C.str("type", "LookML type, e.g. string, number, count_distinct, date_date, yesno.", "type"),
    C.str("label", "Field label.", "label"),
    C.str("label_short", "Short label (without view label).", "label_short"),
    C.str("description", "Field description.", "description"),
    C.str("view", "View alias the field belongs to.", "view"),
    C.str("view_label", "Group label the field picker shows the field under.", "view_label"),
    C.str("sql_table_name", "Warehouse table of the field's view (NULL for derived tables).", "__sql_table_name"),
    C.str("sql", "LookML SQL of the field.", "sql"),
    C.bool("hidden", "Hidden from the field picker.", "hidden"),
    C.bool("primary_key", "Primary key of its view.", "primary_key"),
    C.bool("is_numeric", "Numeric field.", "is_numeric"),
    C.bool("is_timeframe", "A dimension_group timeframe.", "is_timeframe"),
    C.str("dimension_group", "Dimension group it belongs to.", "dimension_group"),
    C.strList("tags", "Field tags.", "tags"),
    C.str("source_file", "LookML file defining the field.", "source_file"),
  ],
  fanout: {
    parents: exploreKeys,
    child: (k) => exploreRequest(k, "name,view_name,sql_table_name,joins,fields"),
  },
  rows: (body) => {
    if (!body || typeof body !== "object") return [];
    const e = body as Row;
    const tables = viewTables(e);
    const out: Row[] = [];
    for (const cat of CATEGORIES) {
      for (const f of Array.isArray(e.fields?.[cat]) ? (e.fields[cat] as Row[]) : []) {
        out.push({
          ...f,
          __category: cat.replace(/s$/, ""),
          __sql_table_name: f.view ? (tables.get(String(f.view)) ?? null) : null,
        });
      }
    }
    return out;
  },
  examples: [
    {
      description: "Measures of one explore",
      sql: "SELECT field_name, type, sql FROM looker.main.explore_fields WHERE model_name = 'thelook' AND explore_name = 'orders' AND category = 'measure' ORDER BY field_name",
    },
    {
      description: "Fields per warehouse table",
      sql: "SELECT sql_table_name, count(*) AS fields FROM looker.main.explore_fields WHERE model_name = 'thelook' GROUP BY ALL ORDER BY fields DESC",
    },
  ],
};

/** Split `db.schema.table` (with `` ` `` / `"` / `[]` quoting) into parts; NULL when it isn't a plain name. */
export function parseTableName(v: string | null): {
  catalog: string | null;
  schema: string | null;
  table: string | null;
} {
  const none = { catalog: null, schema: null, table: null };
  if (!v) return none;
  const s = v.trim().replace(/;$/, "");
  if (/[\s(){}$]/.test(s.replace(/"[^"]*"|`[^`]*`|\[[^\]]*\]/g, "x"))) return none; // SQL or Liquid, not a name
  const parts: string[] = [];
  const re = /`([^`]*)`|"([^"]*)"|\[([^\]]*)\]|([^.`"[\]]+)/g;
  let m: RegExpExecArray | null = re.exec(s);
  while (m) {
    const p = m[1] ?? m[2] ?? m[3] ?? m[4] ?? "";
    // A backticked BigQuery name may hold the whole dotted path.
    parts.push(...(m[1] !== undefined ? p.split(".") : [p]));
    m = re.exec(s);
  }
  if (parts.length === 0 || parts.length > 3) return none;
  const [a, b, c] = parts;
  if (parts.length === 1) return { catalog: null, schema: null, table: a ?? null };
  if (parts.length === 2) return { catalog: null, schema: a ?? null, table: b ?? null };
  return { catalog: a ?? null, schema: b ?? null, table: c ?? null };
}

export const exploreTables: LookerTableSpec = {
  name: "explore_tables",
  description: "Lineage: the warehouse tables (sql_table_name) behind each explore's base view and joins.",
  title: "Looker Explore Lineage",
  category: "lookml",
  keywords: "looker, lineage, sql_table_name, warehouse tables, joins, dbt, openlineage",
  docLlm:
    "One row per view used by an explore: the base view (role 'base') and every join (role 'join'). Columns: " +
    "tool, model_name, explore_name, view_name (alias), source_view (the LookML view, i.e. join `from`), role, " +
    "join_type, relationship, sql_on, sql_table_name (raw), table_catalog, table_schema, table_name (parsed " +
    "from sql_table_name; NULL for derived tables or templated names), connection_name. Join table_schema / " +
    "table_name with dbt models or OpenLineage datasets to trace a dashboard back to its sources. Filter on " +
    "model_name / explore_name: each explore is one API call.",
  docMd:
    "Explore → warehouse table lineage from `sql_table_name`. Derived tables have no `sql_table_name` and show " +
    "NULL table parts.",
  pushdown: "`model_name` and `explore_name` (`=` / `IN`) limit which explores are read.",
  key: ["model_name", "explore_name", "view_name"],
  columns: [
    C.tool(),
    modelCol,
    exploreCol,
    C.str("view_name", "View alias in the explore.", "__view", false),
    C.str("source_view", "LookML view the alias reads (join `from`).", "__from"),
    C.str("role", "'base' for the explore's base view, 'join' for joined views.", "__role"),
    C.str("join_type", "Join type (left_outer, inner, full_outer, cross).", "type"),
    C.str("relationship", "Join relationship (many_to_one …).", "relationship"),
    C.str("sql_on", "Join condition.", "sql_on"),
    C.str("sql_table_name", "sql_table_name as written in LookML.", "sql_table_name"),
    C.str("table_catalog", "Database / project part of sql_table_name.", "__catalog"),
    C.str("table_schema", "Schema / dataset part of sql_table_name.", "__schema"),
    C.str("table_name", "Table part of sql_table_name.", "__table"),
    C.str("connection_name", "Database connection of the explore.", "__connection"),
  ],
  fanout: {
    parents: exploreKeys,
    child: (k) => exploreRequest(k, "name,view_name,sql_table_name,connection_name,joins"),
  },
  rows: (body) => {
    if (!body || typeof body !== "object") return [];
    const e = body as Row;
    const conn = asStr(e.connection_name);
    const mk = (r: Row, view: string, from: string, role: string): Row => {
      const p = parseTableName(asStr(r.sql_table_name));
      return {
        ...r,
        __view: view,
        __from: from,
        __role: role,
        __catalog: p.catalog,
        __schema: p.schema,
        __table: p.table,
        __connection: conn,
      };
    };
    const base = String(e.view_name ?? e.name);
    const out: Row[] = [
      mk(
        { sql_table_name: e.sql_table_name, type: null, relationship: null, sql_on: null },
        String(e.name ?? base),
        base,
        "base",
      ),
    ];
    for (const j of Array.isArray(e.joins) ? (e.joins as Row[]) : []) {
      out.push(mk(j, String(j.name), String(j.from ?? j.name), "join"));
    }
    return out;
  },
  examples: [
    {
      description: "Warehouse tables used by one model",
      sql: "SELECT DISTINCT table_schema, table_name FROM looker.main.explore_tables WHERE model_name = 'thelook' AND table_name IS NOT NULL ORDER BY ALL",
    },
    {
      description: "Which dashboards depend on a table (via tile queries)",
      sql: "SELECT DISTINCT d.title FROM looker.main.explore_tables t JOIN looker.main.dashboard_elements e ON e.model = t.model_name AND e.explore = t.explore_name JOIN looker.main.dashboards d ON d.id = e.dashboard_id WHERE t.table_name = 'orders' ORDER BY d.title",
    },
  ],
};

export const LOOKML_SPECS: LookerTableSpec[] = [lookmlModels, explores, exploreFields, exploreTables];
export const LOOKML_TABLES: TableDescriptor[] = LOOKML_SPECS.map(defineLookerCatalogTable);

export { defaultRows };
