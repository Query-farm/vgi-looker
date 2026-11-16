/**
 * Assemble the `looker` catalog: the API collections as tables, the run functions,
 * and the `looker` secret type.
 */

import { type CatalogDescriptor, field, schema, utf8, type VgiFunction } from "@query-farm/vgi";
import { ACTIVITY_TABLES } from "./looker/activity.ts";
import { SECRET_TYPE } from "./looker/client.ts";
import { LOOKML_TABLES } from "./looker/lookml.ts";
import { RESOURCE_TABLES } from "./looker/resources.ts";
import { RUN_FUNCTIONS } from "./looker/run.ts";
import { CATALOG_COMMENT, CATALOG_NAME, CATALOG_TAGS, SCHEMA_COMMENT, SCHEMA_TAGS, SOURCE_URL } from "./meta.ts";

export const FUNCTIONS: VgiFunction[] = RUN_FUNCTIONS;
export const TABLES = [...RESOURCE_TABLES, ...LOOKML_TABLES, ...ACTIVITY_TABLES];

const doc = (text: string) => new Map([["vgi_doc", text]]);

/** CREATE SECRET (TYPE looker, BASE_URL '…', CLIENT_ID '…', CLIENT_SECRET '…'). */
export const LOOKER_SECRET_TYPE = {
  name: SECRET_TYPE,
  description: "Looker instance API URL plus an API client id / client secret pair",
  schema: schema(
    [
      field(
        "base_url",
        utf8(),
        true,
        doc(
          "Looker API host, e.g. https://acme.cloud.looker.com or https://acme.looker.com:19999 (http:// only for 127.0.0.1/localhost).",
        ),
      ),
      field("client_id", utf8(), true, doc("API client id (Admin > Users > Edit Keys).")),
      field(
        "client_secret",
        utf8(),
        true,
        new Map([
          ["redact", "true"],
          ["vgi_doc", "API client secret paired with client_id."],
        ]),
      ),
      field("web_url", utf8(), true, doc("Optional web UI origin for url columns (default: base_url without :19999).")),
      field("page_size", utf8(), true, doc("Optional page size for search endpoints (default 500).")),
    ],
    new Map([["vgi_doc_url", "https://cloud.google.com/looker/docs/api-auth"]]),
  ),
};

interface Example {
  description: string;
  sql: string;
}

/** Publish each function's examples as `vgi.example_queries`; return them all for the schema. */
function stampExampleQueries(functions: VgiFunction[]): Example[] {
  const all: Example[] = [];
  for (const fn of functions) {
    const ex = (fn.meta.examples ?? []).map((e) => ({ description: e.description, sql: e.sql }));
    fn.meta.tags = { ...fn.meta.tags, "vgi.example_queries": JSON.stringify(ex) };
    all.push(...ex);
  }
  return all;
}

const ALL_EXAMPLES = [
  ...stampExampleQueries(FUNCTIONS),
  ...TABLES.flatMap((t) => JSON.parse(t.tags?.["vgi.example_queries"] ?? "[]") as Example[]),
];

export const CATALOG: CatalogDescriptor = {
  name: CATALOG_NAME,
  comment: CATALOG_COMMENT,
  sourceUrl: SOURCE_URL,
  tags: CATALOG_TAGS,
  secretTypes: [LOOKER_SECRET_TYPE],
  schemas: [
    {
      path: ["main"],
      comment: SCHEMA_COMMENT,
      functions: FUNCTIONS,
      tables: TABLES,
      tags: { ...SCHEMA_TAGS, "vgi.example_queries": JSON.stringify(ALL_EXAMPLES.slice(0, 12)) },
    },
  ],
};
