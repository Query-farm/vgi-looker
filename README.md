<p align="center">
  <img src="https://query.farm/media-kit/products/vgi/vgi-logo.png" alt="Vector Gateway Interface (VGI)" width="320">
</p>

<p align="center"><em>A Query.Farm VGI worker for DuckDB.</em></p>

# Query Looker Dashboards, Explores, Lineage and Usage in DuckDB

> **vgi-looker** · a [Query.Farm](https://query.farm) VGI worker · written in TypeScript

[![CI](https://github.com/Query-farm/vgi-looker/actions/workflows/ci.yml/badge.svg)](https://github.com/Query-farm/vgi-looker/actions/workflows/ci.yml)
[![vgi worker: query.farm](https://query.farm/media-kit/shields/vgi-worker.svg)](https://query.farm)

Looker metadata and usage as SQL, read-only, through the
[Looker API 4.0](https://cloud.google.com/looker/docs/reference/looker-api/latest). Works
with Looker (Google Cloud core) and original (self-hosted or Looker-hosted) instances:
inventory dashboards, tiles and Looks; audit users, roles and connections; trace explores
back to warehouse tables; review schedules and alerts; and measure adoption and query
performance from [System Activity](https://cloud.google.com/looker/docs/system-activity-pages).

```sql
CREATE SECRET looker (TYPE looker,
    BASE_URL 'https://acme.cloud.looker.com',
    CLIENT_ID '…', CLIENT_SECRET '…');

-- Dashboards nobody opened in 90 days, with their folder.
SELECT title, folder_path, owner, last_viewed_at
FROM looker.main.dashboards
WHERE NOT deleted AND last_viewed_at < now() - INTERVAL 90 DAY
ORDER BY last_viewed_at;

-- Slowest explores this week (System Activity, filters pushed into the inline query).
SELECT model, explore, count(*) AS runs, avg(runtime_seconds) AS avg_s
FROM looker.main.query_history
WHERE created_at >= now() - INTERVAL 7 DAY AND result_source = 'query'
GROUP BY ALL ORDER BY avg_s DESC LIMIT 10;

-- Which warehouse tables feed which dashboards (join with dbt / OpenLineage on table names).
SELECT DISTINCT t.table_schema, t.table_name, d.title
FROM looker.main.explore_tables t
JOIN looker.main.dashboard_elements e ON e.model = t.model_name AND e.explore = t.explore_name
JOIN looker.main.dashboards d ON d.id = e.dashboard_id
WHERE t.model_name = 'thelook';
```

## Tables and functions

All objects live in `looker.main` and need a `looker` secret.

| Object | What it returns | Pushdown |
|---|---|---|
| `dashboards` | User-defined dashboards: folder path, owner, usage counters, dashboard filters | `id`, `folder_id`, `owner_id`, `title` (`=` / prefix), `deleted` |
| `dashboard_elements` | Tiles with the look / query / model / explore behind each, and which filters they listen to | `dashboard_id`, `look_id`, `title` |
| `looks` | Saved Looks: folder path, owner, query id, usage counters | `id`, `title`, `folder_id`, `owner_id`, `query_id`, `deleted` |
| `charts` | Tiles and Looks in one table (`chart_kind` 'tile' / 'look') | `chart_kind`, `dashboard_id` |
| `queries` | Query definitions: model, explore, fields, filters, sorts, pivots, table calculations | `id = / IN` (otherwise every query referenced by a tile or Look) |
| `folders` | The folder tree with full paths | `id`, `title`, `parent_id`, `owner_id`, `is_shared_root`, `is_users_root` |
| `users` | Users with role and group ids — never credentials | `id`, `email`, `first_name`, `last_name`, `is_disabled` |
| `groups` | Groups with member counts and external (SCIM / LDAP / SAML) ids | `id`, `name`, `external_group_id`, `externally_managed` |
| `roles` | Roles with their permission set and model set flattened into lists | — |
| `connections` | Database connections: dialect, host, database, schema — never passwords, certificates or JDBC parameters | — |
| `projects` | LookML projects with git settings (remote URL stripped of credentials) | — |
| `project_branches` | Git branches per project: production flag, ahead/behind, head commit | `project_id` |
| `lookml_models` | Models with their explores and allowed connections | — |
| `explores` | Explore definitions: base view, `sql_table_name`, connection, join and field counts | `model_name`, `explore_name` |
| `explore_fields` | Every dimension, measure, filter and parameter, with the table of its view | `model_name`, `explore_name` |
| `explore_tables` | Lineage: base view and joins with `sql_table_name` parsed into catalog / schema / table | `model_name`, `explore_name` |
| `schedules` | Scheduled plans; recipients reduced to counts, types, formats and email domains | `owner_id` |
| `alerts` | Alerts: field, condition, threshold, cron; recipients reduced to counts and domains | `is_disabled` |
| `content_usage` | System Activity: views per dashboard / Look per UTC day, distinct users, last view in window | `view_date` range (default 30 days), `content_type`, `content_id` |
| `query_history` | System Activity: one row per query run — runtime, status, source, model, explore, user | `created_at` range (default 7 days), `status`, `source`, `model`, `explore`, `user_email`, `connection_name`, `dashboard_id`, `look_id` |
| `run_look(look_id, row_limit := 5000)` | A saved Look's rows | — |
| `run_query(query_id, row_limit := 5000)` | A saved query's rows (e.g. a tile's `query_id`) | — |

Explore detail costs one API call per explore and `queries` one per query, so filter on
`model_name` / `explore_name` / `id` when you can.

### Shared BI columns (UNION across Looker, Tableau and Metabase)

The content tables use the column names the sibling BI workers (`vgi-tableau`,
`vgi-metabase`) use, so inventories UNION cleanly:

| Column | Type | Meaning in Looker |
|---|---|---|
| `tool` | `VARCHAR` | Always `'looker'` |
| `id` | `VARCHAR` | Looker id (connection name for `connections`) |
| `title` | `VARCHAR` | Dashboard / Look / tile title, folder or connection name |
| `folder_path` | `VARCHAR` | `/Shared/Marketing/EMEA` — the folder chain from the root |
| `owner` | `VARCHAR` | Display name of the creating user (`owner_id` holds the id) |
| `created_at` / `updated_at` | `TIMESTAMPTZ` | Creation / last update time |
| `last_viewed_at` | `TIMESTAMPTZ` | Last view (dashboards, Looks, Look charts) |
| `view_count` | `BIGINT` | Lifetime views reported by the API |
| `url` | `VARCHAR` | Link into the Looker web UI (from `WEB_URL`) |

| Table | Shared columns present |
|---|---|
| `dashboards`, `looks` | all of them |
| `charts` | all (tiles have NULL owner / timestamps / view_count — Looker keeps those per dashboard) |
| `folders` | `tool, id, title, folder_path, owner, created_at, url` |
| `queries` | `tool, id, url` |
| `users` | `tool, id, url` (+ `display_name`, `email`) |
| `connections` | `tool, id, title, created_at, url` — the `data_sources` of other tools |
| `content_usage` | `tool, url` (+ `content_type, content_id, title, view_date, view_count`) |

```sql
SELECT tool, id, title, folder_path, owner, view_count, url FROM looker.main.dashboards
UNION ALL BY NAME
SELECT tool, id, title, folder_path, owner, view_count, url FROM metabase.main.dashboards;
```

### `run_look` / `run_query` result types

Columns keep Looker's `view.field` names (quote them: `"orders.count"`) and take their
type from the explore's LookML metadata: numbers `DOUBLE`, `count` / `count_distinct`
`BIGINT`, `yesno` `BOOLEAN`, `date` / `week` `DATE`, `time` `TIMESTAMP` (query timezone),
everything else `VARCHAR`. With pivots, measures and table calculations are `JSON`
objects keyed by pivot value. Running a Look or query never rebuilds PDTs and saves nothing.

## Authentication

Create an [API key](https://cloud.google.com/looker/docs/api-auth) (Admin > Users > Edit
Keys) for a user whose role can see the content you want; System Activity tables also need
the `see_system_activity` permission.

```sql
CREATE SECRET looker (TYPE looker,
    BASE_URL 'https://acme.cloud.looker.com',   -- original Looker: 'https://acme.looker.com:19999'
    CLIENT_ID '…', CLIENT_SECRET '…',
    WEB_URL 'https://acme.looker.com',          -- optional: UI origin for url columns
    PAGE_SIZE '500');                           -- optional: search page size
```

The worker posts the key pair to `/api/4.0/login`, caches the access token in memory until
shortly before it expires, and logs in again after a 401. Credentials and tokens never
enter scan state, URLs, logs or error messages. `http://` is accepted only for
`127.0.0.1` / `localhost` (test fixtures).

## Pushdown, paging and rate limits

- `WHERE` predicates on the columns listed above become Looker search parameters
  (exact values; prefixes as `title=Mark%`; booleans) or, for System Activity, the inline
  query's `filters` (`history.created_time` ranges as `A to B` in UTC, `a,b` alternatives
  with `^` escapes). Values containing search wildcards are not pushed. DuckDB re-checks
  every predicate exactly, so pushdown only narrows what is fetched.
- Search endpoints page with `limit` + `offset`; per-explore, per-query and per-project
  fan-outs keep their pending ids in scan state. All cursors are serializable, so scans
  resume across processes over HTTP.
- `query_history` reads its window newest-first in inline queries of 7 days that shrink
  (down to an hour) when a chunk nears the 50,000-row cap and grow when chunks are sparse.
- 429 responses wait for `Retry-After`; 5xx and network errors back off exponentially.
- The only non-GET calls are `POST /login` and `POST /queries/run/json` (`run_inline_query`,
  a read-only SELECT against `system__activity`). Nothing is created, updated or deleted.

## Install

**Prerequisites:** [Bun](https://bun.sh) 1.3+ (for a source checkout).

```bash
git clone https://github.com/Query-farm/vgi-looker.git && cd vgi-looker
bun install --frozen-lockfile
```

**DuckDB 2.0:**

```sql
SET allow_extension_repositories = 'allowed';
CREATE EXTENSION REPOSITORY IF NOT EXISTS query_farm WITH PREFIX 'https://duckdb-extensions.query.farm';
INSTALL vgi FROM query_farm;
LOAD vgi FROM query_farm;
ATTACH 'looker' (TYPE vgi, LOCATION '/abs/path/to/vgi-looker/bin/vgi-looker-worker');
```

**Haybarn 2.0.1+** (`uvx haybarn-cli`; Haybarn 2.0.0 serves an older vgi extension that cannot attach this worker):

```sql
INSTALL vgi FROM community;
LOAD vgi;
ATTACH 'looker' (TYPE vgi, LOCATION '/abs/path/to/vgi-looker/bin/vgi-looker-worker');
```

`LOCATION` is the command DuckDB runs, so use an absolute path. Tagged releases ship
signed standalone executables (no Bun needed) for Linux, macOS (arm64) and Windows; point
`LOCATION` at the downloaded binary. The same binary serves HTTP with `--http --port 8000`
(see the `Dockerfile`).

## Testing

```bash
make test-unit                 # bun unit tests (filter escaping, windows, masking, typing, login/retry)
make test-sql                  # test/sql/looker.test through Haybarn 2.0 (stdio)
make test-sql TRANSPORT=http   # …over HTTP (also: launch)
make check                     # everything CI runs
```

No test touches the network or a real Looker instance. `test/mock_api/server.py` is a
stdlib-only replay server over a hand-built instance (`test/fixtures/looker-instance.json`,
shaped after the documented API 4.0 responses). It enforces login and bearer tokens,
rejects unknown query parameters and inline-query body keys, validates System Activity
field and filter names, implements search wildcards, `fields` projection and
`limit`/`offset` paging, aggregates fixture history for inline queries, and answers a 429
and a 503 once each so the retry paths always run. Connections, projects, schedules and
alerts come back with fake passwords, tokens and recipient addresses so the tests prove
none of them reach SQL. The SQL tests read its `/__requests` log to check exactly what was
pushed down.

The metadata check runs with `execute: false` in CI: every object needs a `looker` secret
for a live instance.

## Authorship & License

Written by [Query.Farm](https://query.farm). Released under the
[BSD Zero Clause License](LICENSE) (0BSD).

Copyright 2026 Query Farm LLC - https://query.farm
