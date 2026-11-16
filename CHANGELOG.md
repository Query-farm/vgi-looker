# Changelog

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

Targets: @query-farm/vgi 0.50 · VGI protocol 3.3 · Haybarn 2.0.0rc11 · vgi-lint-check 2.x (unpinned)
