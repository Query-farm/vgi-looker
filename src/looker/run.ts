/**
 * `run_look(look_id)` and `run_query(query_id)`: the results of a saved Look or query.
 *
 * Binding reads the Look / query definition and the explore's field metadata, so
 * the result columns get real types: numbers become DOUBLE (counts BIGINT),
 * yes/no BOOLEAN, `date` DATE, `time` TIMESTAMP, everything else VARCHAR. Pivoted
 * measures and table calculations come back as JSON / VARCHAR. Running a Look or
 * query is read-only (`run_look` / `run_query` with `json`, never rebuilding PDTs).
 */

import {
  batchFromColumns,
  bool,
  dateDay,
  defineTableFunction,
  field,
  float64,
  int64,
  schema,
  secretOfType,
  timestampMicros,
  utf8,
  type VgiDataType,
  type VgiFunction,
  type VgiSchema,
} from "@query-farm/vgi";
import { column, objectTags } from "../meta.ts";
import { configFromSecrets, type LookerConfig, LookerError, lookerRequest, SECRET_TYPE } from "./client.ts";
import { asBigInt, asDate, asNum, asStr, asTime, type Row } from "./table.ts";

export const DEFAULT_ROW_LIMIT = 5000;

/** The result shape: one column per field of the saved query, typed from LookML. */
const DYNAMIC_COLUMNS_MD =
  "Columns are the saved query's fields, in order, named exactly as in Looker (`view.field`).\n\n" +
  "| Name | Type | Description |\n|---|---|---|\n" +
  "| `<view>.<dimension>` (number) | `DOUBLE` | Numeric dimension |\n" +
  "| `<view>.<measure>` (count, count_distinct) | `BIGINT` | Count measure |\n" +
  "| `<view>.<measure>` (sum, average, number …) | `DOUBLE` | Numeric measure |\n" +
  "| `<view>.<field>` (yesno) | `BOOLEAN` | Yes/no field |\n" +
  "| `<view>.<field>_date` / `_week` | `DATE` | Date timeframe |\n" +
  "| `<view>.<field>_time` / `_raw` | `TIMESTAMP` | Time in the query's timezone |\n" +
  "| `<view>.<field>` (other types) | `VARCHAR` | String, tier, month, location … |\n" +
  "| `<measure>` when the query pivots | `JSON` | Object keyed by pivot value |\n" +
  "| `<table_calculation>` / custom field | VARCHAR | Table calculation or custom dimension (`JSON` when pivoted; custom measures `DOUBLE`) |\n\n" +
  "Bound without a `looker` secret (no field metadata to read), the result is a single placeholder column:\n\n" +
  "| Name | Type | Description |\n|---|---|---|\n" +
  "| pending | VARCHAR | Placeholder; create a looker secret to get the real columns |";
export const MAX_ROW_LIMIT = 50_000;
const enc = encodeURIComponent;

type Kind = "str" | "double" | "bigint" | "bool" | "date" | "timestamp" | "json";

/** Map a LookML explore field to a result column kind. */
export function kindOfField(f: Row | undefined, pivoted: boolean): Kind {
  if (!f) return "str";
  const type = String(f.type ?? "");
  const isMeasure = f.category === "measure" || f.measure === true;
  if (pivoted && isMeasure) return "json";
  if (type === "yesno") return "bool";
  if (type === "count" || type === "count_distinct") return "bigint";
  if (f.is_numeric === true) return "double";
  if (type === "date_date" || type === "date_week" || type === "date") return "date";
  if (type === "date_time" || type === "date_raw") return "timestamp";
  return "str";
}

const TYPES: Record<Kind, () => VgiDataType> = {
  str: () => utf8(),
  double: () => float64(),
  bigint: () => int64(),
  bool: () => bool,
  date: () => dateDay(),
  timestamp: () => timestampMicros(),
  json: () => utf8(),
};

/** Convert one JSON result value to the column kind (unparseable → NULL). */
export function convert(kind: Kind, v: unknown): unknown {
  if (v === null || v === undefined) return null;
  switch (kind) {
    case "double":
      return asNum(v);
    case "bigint":
      return asBigInt(v);
    case "bool":
      return typeof v === "boolean" ? v : v === "Yes" || v === "yes" ? true : v === "No" || v === "no" ? false : null;
    case "date":
      return asDate(v);
    case "timestamp":
      // Looker returns wall-clock times in the query timezone: keep them as naive TIMESTAMP.
      return asTime(v);
    case "json":
      return JSON.stringify(v);
    default:
      return asStr(v);
  }
}

interface ResultColumn {
  name: string;
  kind: Kind;
  doc: string;
}

/** The result columns of a query definition, typed from the explore's field metadata. */
export async function resultColumns(cfg: LookerConfig, query: Row): Promise<ResultColumn[]> {
  const model = asStr(query.model);
  const view = asStr(query.view);
  const fields: string[] = Array.isArray(query.fields) ? query.fields.map(String) : [];
  const pivoted = Array.isArray(query.pivots) && query.pivots.length > 0;
  const meta = new Map<string, Row>();
  if (model && view) {
    const explore = (await lookerRequest(cfg, `/lookml_models/${enc(model)}/explores/${enc(view)}`, {
      query: { fields: "fields" },
      notFoundNull: true,
    })) as Row | null;
    for (const cat of ["dimensions", "measures", "filters", "parameters"]) {
      const list: unknown = explore?.fields?.[cat];
      for (const f of Array.isArray(list) ? (list as Row[]) : []) {
        meta.set(String(f.name), { ...f, category: cat === "measures" ? "measure" : cat.replace(/s$/, "") });
      }
    }
  }
  const dynamic = new Map<string, Row>();
  let dyn: unknown = query.dynamic_fields;
  if (typeof dyn === "string") {
    try {
      dyn = JSON.parse(dyn);
    } catch {
      dyn = [];
    }
  }
  for (const d of Array.isArray(dyn) ? (dyn as Row[]) : []) {
    const name = asStr(d.table_calculation ?? d.measure ?? d.dimension);
    if (name) dynamic.set(name, d);
  }
  // Pivoted dimensions become the keys of the pivoted measures' JSON objects, not columns.
  const seen = new Set<string>(pivoted ? (query.pivots as unknown[]).map(String) : []);
  const out: ResultColumn[] = [];
  for (const name of fields) {
    if (seen.has(name)) continue;
    seen.add(name);
    const m = meta.get(name);
    const d = dynamic.get(name);
    let kind: Kind;
    if (m) kind = kindOfField(m, pivoted);
    else if (d?.measure) kind = pivoted ? "json" : "double";
    else kind = pivoted && d?.table_calculation ? "json" : "str";
    const label = asStr(m?.label ?? d?.label) ?? name;
    out.push({ name, kind, doc: `${label}${m?.type ? ` (${m.type})` : d ? " (custom field)" : ""}` });
  }
  return out;
}

function schemaOf(cols: ResultColumn[]): VgiSchema {
  return schema(
    cols.map((c) =>
      c.kind === "json"
        ? field(
            c.name,
            utf8(),
            true,
            new Map([
              ["comment", c.doc],
              ["ARROW:extension:name", "arrow.json"],
            ]),
          )
        : column(c.name, TYPES[c.kind](), c.doc),
    ),
  );
}

/** Placeholder schema for the first bind pass (before the secret is resolved). */
const PENDING = schema([column("pending", utf8(), "Placeholder until the looker secret is resolved.")]);

interface RunArgs {
  id: string;
  row_limit: bigint | number;
}

function rowLimit(v: unknown): number {
  const n = Number(v ?? DEFAULT_ROW_LIMIT);
  if (!Number.isInteger(n) || n < 1 || n > MAX_ROW_LIMIT) {
    throw new LookerError(`row_limit must be between 1 and ${MAX_ROW_LIMIT}`);
  }
  return n;
}

function defineRun(opts: {
  name: string;
  idArg: string;
  noun: string;
  definition: (cfg: LookerConfig, id: string) => Promise<Row>;
  runPath: (id: string) => string;
  title: string;
  docLlm: string;
  docMd: string;
  keywords: string;
  examples: { description: string; sql: string }[];
}): VgiFunction {
  return defineTableFunction<RunArgs, { done: number }>({
    name: opts.name,
    description: `Run a saved ${opts.noun} (read-only) and return its rows, typed from the explore's field metadata.`,
    args: { [opts.idArg]: utf8(), row_limit: int64() } as never,
    argDocs: {
      [opts.idArg]: `Id of the ${opts.noun} to run.`,
      row_limit: `Maximum rows to return (1–${MAX_ROW_LIMIT}, default ${DEFAULT_ROW_LIMIT}).`,
    },
    argDefaults: { row_limit: DEFAULT_ROW_LIMIT },
    argConstraints: { row_limit: { ge: 1, le: MAX_ROW_LIMIT } },
    onBind: async (params) => {
      if (!params.resolvedSecretsProvided) return { outputSchema: PENDING, lookupSecretTypes: [SECRET_TYPE] };
      const args = params.args as unknown as Record<string, unknown>;
      const id = asStr(args[opts.idArg]);
      if (!id) throw new LookerError(`${opts.name}: ${opts.idArg} is required`);
      // Without a looker secret the columns cannot be known; bind a placeholder and let
      // the scan report the missing secret.
      if (!secretOfType(params.secrets as never, SECRET_TYPE)) return { outputSchema: PENDING };
      const cfg = configFromSecrets(params.secrets);
      const def = await opts.definition(cfg, id);
      const cols = await resultColumns(cfg, def);
      if (cols.length === 0) throw new LookerError(`${opts.name}: ${opts.noun} ${id} selects no fields`);
      return { outputSchema: schemaOf(cols) };
    },
    initialState: () => ({ done: 0 }),
    process: async (params, state, out) => {
      if (state.done) {
        out.finish();
        return;
      }
      state.done = 1;
      const cfg = configFromSecrets(params.secrets);
      const args = params.args as unknown as Record<string, unknown>;
      const id = asStr(args[opts.idArg]) ?? "";
      const body = await lookerRequest(cfg, opts.runPath(id), {
        query: { limit: rowLimit(args.row_limit), apply_formatting: false, apply_vis: false, cache: true },
      });
      if (!Array.isArray(body)) {
        const msg = asStr((body as Row | null)?.looker_error ?? (body as Row | null)?.message) ?? "unexpected response";
        throw new LookerError(`${opts.name}: ${msg}`);
      }
      const kinds = new Map<string, Kind>();
      for (const f of params.outputSchema.fields) {
        const comment = f.metadata?.get("ARROW:extension:name") === "arrow.json" ? "json" : undefined;
        const t = String(f.type);
        kinds.set(
          f.name,
          (comment ??
            (/^Utf8/i.test(t)
              ? "str"
              : /^Float/i.test(t)
                ? "double"
                : /^Int/i.test(t)
                  ? "bigint"
                  : /^Bool/i.test(t)
                    ? "bool"
                    : /^Date/i.test(t)
                      ? "date"
                      : /^Timestamp/i.test(t)
                        ? "timestamp"
                        : "str")) as Kind,
        );
      }
      const cols: Record<string, unknown[]> = {};
      for (const f of params.outputSchema.fields) {
        const kind = kinds.get(f.name) ?? "str";
        cols[f.name] = (body as Row[]).map((r) => convert(kind, r[f.name]));
      }
      if (body.length) out.emit(batchFromColumns(cols, params.outputSchema));
      out.finish();
    },
    tags: {
      domain: "business-intelligence",
      "vgi.result_dynamic_columns_md": DYNAMIC_COLUMNS_MD,
      ...objectTags({
        title: opts.title,
        category: "results",
        keywords: opts.keywords,
        docLlm: opts.docLlm,
        docMd: opts.docMd,
      }),
    },
    examples: opts.examples,
  });
}

export const runLook = defineRun({
  name: "run_look",
  idArg: "look_id",
  noun: "Look",
  definition: async (cfg, id) => {
    const look = (await lookerRequest(cfg, `/looks/${enc(id)}`, { query: { fields: "id,query" } })) as Row | null;
    if (!look?.query) throw new LookerError(`run_look: Look ${id} has no query`);
    return look.query as Row;
  },
  runPath: (id) => `/looks/${enc(id)}/run/json`,
  title: "Run a Look",
  keywords: "looker, run look, results, report, data",
  docLlm:
    "`run_look(look_id VARCHAR, row_limit := 5000)` runs a saved Look read-only and returns its rows. Columns are " +
    'the Look\'s fields named exactly as in Looker (view.field — quote them: "orders.count"), typed from the ' +
    "explore's LookML metadata: numbers `DOUBLE`, count/count_distinct `BIGINT`, yesno `BOOLEAN`, date `DATE`, " +
    "time `TIMESTAMP` (in the query's timezone), others `VARCHAR`; pivoted measures are `JSON` objects keyed by " +
    "pivot value; table calculations `VARCHAR`. Find Look ids in looks.",
  docMd:
    "Run a Look and get typed rows. Field names keep Looker's `view.field` form, so quote them in SQL. " +
    "`row_limit` caps the rows (default 5000).",
  examples: [
    {
      description: "Profile every column of Look 42 (min, max, distinct and null counts)",
      sql: "SUMMARIZE SELECT * FROM looker.main.run_look('42', row_limit := 100)",
    },
    {
      description: "How many rows a Look returns",
      sql: "SELECT count(*) AS result_rows FROM looker.main.run_look('42')",
    },
  ],
});

export const runQuery = defineRun({
  name: "run_query",
  idArg: "query_id",
  noun: "query",
  definition: async (cfg, id) => {
    const q = (await lookerRequest(cfg, `/queries/${enc(id)}`)) as Row | null;
    if (!q) throw new LookerError(`run_query: query ${id} not found`);
    return q;
  },
  runPath: (id) => `/queries/${enc(id)}/run/json`,
  title: "Run a Query",
  keywords: "looker, run query, results, tile, data",
  docLlm:
    "`run_query(query_id VARCHAR, row_limit := 5000)` runs a saved Looker query read-only (e.g. a dashboard tile's " +
    "query_id from dashboard_elements) and returns its rows, typed like run_look: columns are the query's " +
    "view.field names (quote them), numbers `DOUBLE`, counts `BIGINT`, yesno `BOOLEAN`, dates `DATE`, times `TIMESTAMP`.",
  docMd: "Run a saved query (such as a tile's `query_id`) and get typed rows.",
  examples: [
    {
      description: "Profile the columns behind a dashboard tile's query",
      sql: "SUMMARIZE SELECT * FROM looker.main.run_query('101', row_limit := 50)",
    },
    {
      description: "Count the rows a query returns",
      sql: "SELECT count(*) AS result_rows FROM looker.main.run_query('101')",
    },
  ],
});

export const RUN_FUNCTIONS: VgiFunction[] = [runLook, runQuery];
