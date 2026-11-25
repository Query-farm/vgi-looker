# Changelog

## 0.2.0 (2026-11-25)

- VGI protocol 3.4: bump @query-farm/vgi to 0.52 and @query-farm/vgi-rpc to 0.30. **Requires the
  3.4 vgi extension**: DuckDB 2.0 (`INSTALL vgi FROM query_farm`) or Haybarn 2.0.1+; Haybarn 2.0.0
  still serves the 3.3 extension, which cannot attach this worker.
- The Docker image supports Orchard hosted mode (`VGI_ORCHARD_HOSTED=1`): HTTP only, Orchard Pass
  authentication, large values through the Orchard blob vendor; the HEALTHCHECK uses `HEAD /health`.
- CI and `make` run the SQL tests on haybarn-unittest 2.0.1rc3.

## 0.1.2 (2026-11-16)

- Bump @query-farm/vgi to 0.50.1.
- CI tooling (haybarn-unittest, lint helpers) runs on Python 3.14.

## 0.1.1

- Catalog and schema docs are overviews instead of object lists, and schemas have their own one-line comments (vgi-lint 2.8: VGI173, VGI102).

## 0.1.0

Initial release: Looker API 4.0 metadata and usage as SQL (read-only).

- Content: `dashboards`, `dashboard_elements`, `looks`, `charts`, `queries`, `folders`.
- Admin: `users` (no credentials), `groups`, `roles`, `connections` (no passwords/certificates).
- LookML: `projects`, `project_branches`, `lookml_models`, `explores`, `explore_fields`,
  `explore_tables` (sql_table_name lineage).
- Delivery: `schedules`, `alerts` (recipients masked to counts and email domains).
- System Activity via read-only inline queries: `content_usage`, `query_history`.
- `run_look(look_id)` / `run_query(query_id)` with types from LookML field metadata.
- `looker` secret (BASE_URL, CLIENT_ID, CLIENT_SECRET, optional WEB_URL / PAGE_SIZE).

Targets: @query-farm/vgi 0.50 · VGI protocol 3.3 · Haybarn 2.0.1rc3 · vgi-lint-check 2.x (unpinned)
