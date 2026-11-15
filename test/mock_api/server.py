#!/usr/bin/env python3
"""An offline Looker API 4.0 replay server for the tests (stdlib only).

It serves the hand-built instance in ``test/fixtures/looker-instance.json`` (documented
API 4.0 response shapes) and behaves like Looker where the worker depends on it:

* **Auth.** ``POST /api/4.0/login`` with form fields ``client_id=test-client-id`` and
  ``client_secret=test-client-secret`` mints an access token (``expires_in`` 3600);
  bad credentials get Looker's ``404 Not found``. Every other endpoint needs
  ``Authorization: Bearer <token>`` (or ``token <token>``), else ``401 Requires
  authentication``. ``POST /__expire_tokens`` revokes every token so re-login is tested.
* **Strict parameters.** Each route accepts only its documented query parameters; an
  unknown one is a 400 (real Looker ignores them, but strictness catches typos in
  pushdown). The inline query endpoint validates its JSON body keys, the model/explore
  and every field and filter name against a System Activity schema subset.
* **Search semantics.** Search parameters match case-insensitively with ``%``/``_`` LIKE
  wildcards, booleans as ``true``/``false``; ``fields`` projects top-level keys (except on
  endpoints listed in FULL_RECORDS, which return every key so masking is exercised);
  ``sorts``, ``limit`` and ``offset`` page.
* **System Activity.** ``POST /api/4.0/queries/run/json`` with ``model: system__activity``,
  ``view: history`` groups the fixture history (event times are offsets before server
  start) by the requested dimensions and computes ``history.count``,
  ``history.query_run_count``, ``history.dashboard_run_count`` (distinct dashboard
  sessions) and ``user.count`` (distinct users). Filters support ``A to B`` time ranges,
  ``NOT NULL`` / ``-NULL`` and comma-separated alternatives with ``^`` escapes.
* **Run endpoints.** ``GET /looks/{id}/run/json`` and ``/queries/{id}/run/json`` return
  ``query_results`` from the fixture, honouring ``limit``.
* **Rate limits.** The first ``/api/4.0/groups/search`` answers 429 with ``Retry-After: 1``
  and the first ``/api/4.0/roles`` answers 503, so the retry paths always run.
* **Introspection.** ``GET /__requests?path=/api/4.0/dashboards/search`` returns every
  recorded request to that path (``seq``, ``method``, ``path``, ``query`` and ``body`` as
  JSON strings) so SQL tests can assert exactly what was pushed down.

Usage::

    python3 test/mock_api/server.py            # prints PORT:<n> once listening
"""

from __future__ import annotations

import argparse
import contextlib
import datetime as dt
import json
import re
import secrets
import sys
import threading
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import parse_qs, unquote, urlparse

HERE = Path(__file__).resolve().parent
DATA = json.loads((HERE.parent / "fixtures" / "looker-instance.json").read_text())
CLIENT_ID = "test-client-id"
CLIENT_SECRET = "test-client-secret"
FIXTURE_ORIGIN = "https://acme.cloud.looker.com"
START = dt.datetime.now(dt.timezone.utc).replace(microsecond=0)

LOCK = threading.Lock()
REQUESTS: list[dict] = []
TOKENS: set[str] = set()
ONCE: set[str] = set()


class ApiError(Exception):
    def __init__(self, status: int, message: str, headers: dict | None = None):
        super().__init__(message)
        self.status, self.message, self.headers = status, message, headers or {}


def bad(message: str) -> ApiError:
    return ApiError(400, message)


# ------------------------------------------------------------------ search helpers

def like(pattern: str, value: object) -> bool:
    if value is None:
        return pattern.lower() == "null"
    rx = "".join(".*" if c == "%" else "." if c == "_" else re.escape(c) for c in pattern)
    return re.fullmatch(rx, str(value), re.IGNORECASE | re.DOTALL) is not None


def match_param(value: object, want: str) -> bool:
    if isinstance(value, bool):
        if want not in ("true", "false"):
            raise bad(f"boolean search parameter must be true or false, got {want!r}")
        return value == (want == "true")
    return like(want, value)


def search(items: list[dict], query: dict, searchable: dict[str, str]) -> list[dict]:
    """Filter by search params (param -> record key), then sort, then page."""
    out = items
    for param, key in searchable.items():
        if param in query:
            out = [i for i in out if match_param(i.get(key), query[param])]
    return out


def sort_and_page(items: list[dict], query: dict) -> list[dict]:
    out = list(items)
    if "sorts" in query:
        for part in reversed(query["sorts"].split(",")):
            name, *rest = part.strip().split()
            desc = bool(rest and rest[0].lower() == "desc")
            out.sort(key=lambda r: (r.get(name) is None, int(r[name]) if str(r.get(name, "")).isdigit() else str(r.get(name))), reverse=desc)
    offset = int(query.get("offset", "0") or 0)
    if "limit" in query:
        limit = int(query["limit"])
        if limit < 1:
            raise bad("limit must be positive")
        return out[offset:offset + limit]
    return out[offset:]


def project(items: list[dict], query: dict) -> list[dict]:
    if "fields" not in query:
        return items
    keep = {f.strip() for f in query["fields"].split(",") if f.strip()}
    return [{k: v for k, v in i.items() if k in keep} for i in items]


PAGING = {"fields", "sorts", "limit", "offset", "page", "per_page", "filter_or"}


def make_search(collection: str, searchable: dict[str, str], full: bool = False, paged: bool = True):
    def fn(query: dict, _m: list[str]):
        items = search(DATA[collection], query, searchable)
        items = sort_and_page(items, query) if paged else items
        return items if full else project(items, query)
    allowed = set(searchable) | ({"fields", "sorts", "filter_or"} | (PAGING if paged else set()))
    return fn, allowed


# ------------------------------------------------------------------ system activity

def history_rows() -> list[dict]:
    rows = []
    for h in DATA["history"]:
        created = START - dt.timedelta(minutes=h["offset_minutes"])
        completed = created + dt.timedelta(seconds=h["completed_after_s"])
        rows.append({
            "history.id": h["id"],
            "history.created_time": created.strftime("%Y-%m-%d %H:%M:%S"),
            "history.created_date": created.strftime("%Y-%m-%d"),
            "history.completed_time": completed.strftime("%Y-%m-%d %H:%M:%S"),
            "history.runtime": h["runtime"],
            "history.status": h["status"],
            "history.source": h["source"],
            "history.result_source": h["result_source"],
            "history.connection_name": h["connection_name"],
            "history.dashboard_id": h["dashboard_id"],
            "history.dashboard_session": h["dashboard_session"],
            "history.message": h["message"],
            "dashboard.id": h["dashboard_id"],
            "dashboard.title": h["dashboard_title"],
            "look.id": h["look_id"],
            "look.title": h["look_title"],
            "query.id": h["query_id"],
            "query.model": h["model"],
            "query.view": h["view"],
            "user.id": h["user_id"],
            "user.email": h["user_email"],
            "__created": created,
        })
    return rows


DIMENSIONS = {
    "history.id", "history.created_time", "history.created_date", "history.completed_time", "history.runtime",
    "history.status", "history.source", "history.result_source", "history.connection_name",
    "history.dashboard_id", "history.dashboard_session", "history.message", "dashboard.id", "dashboard.title",
    "look.id", "look.title", "query.id", "query.model", "query.view", "user.id", "user.email",
}
MEASURES = {"history.count", "history.query_run_count", "history.dashboard_run_count", "user.count"}
INLINE_KEYS = {"model", "view", "fields", "filters", "sorts", "limit", "query_timezone", "pivots", "fill_fields",
               "filter_expression", "total", "row_total", "subtotals", "dynamic_fields", "column_limit", "vis_config"}


def split_alternatives(expr: str) -> list[str]:
    out, cur, i = [], "", 0
    while i < len(expr):
        c = expr[i]
        if c == "^" and i + 1 < len(expr):
            cur += expr[i + 1]
            i += 2
            continue
        if c == ",":
            out.append(cur.strip())
            cur = ""
        else:
            cur += c
        i += 1
    out.append(cur.strip())
    return out


def parse_dt(s: str) -> dt.datetime:
    s = s.strip()
    for fmt in ("%Y-%m-%d %H:%M:%S", "%Y-%m-%d %H:%M", "%Y-%m-%d", "%Y/%m/%d"):
        with contextlib.suppress(ValueError):
            return dt.datetime.strptime(s, fmt).replace(tzinfo=dt.timezone.utc)
    raise bad(f"unparsable date in filter: {s!r}")


def filter_pred(field: str, expr: str):
    e = expr.strip()
    if field in ("history.created_time", "history.created_date"):
        m = re.fullmatch(r"(.+?)\s+to\s+(.+)", e)
        if not m:
            raise bad(f"unsupported date filter for {field}: {expr!r} (expected 'A to B')")
        lo, hi = parse_dt(m[1]), parse_dt(m[2])
        return lambda r: lo <= r["__created"] < hi
    if e.upper() in ("NOT NULL", "-NULL"):
        return lambda r: r[field] is not None
    if e.upper() == "NULL":
        return lambda r: r[field] is None
    alts = split_alternatives(e)
    if any(a.startswith("-") for a in alts):
        raise bad("negated filters are not supported by the replay server")
    return lambda r: r[field] is not None and str(r[field]).lower() in {a.lower() for a in alts}


def run_inline(body: object) -> list[dict]:
    if not isinstance(body, dict):
        raise bad("request body must be a JSON object")
    unknown = set(body) - INLINE_KEYS
    if unknown:
        raise bad(f"unknown query body key(s): {sorted(unknown)}")
    if body.get("model") != "system__activity" or body.get("view") != "history":
        raise ApiError(404, f"Not found: model {body.get('model')!r} explore {body.get('view')!r}")
    if body.get("query_timezone") not in (None, "UTC"):
        raise bad("replay server only supports query_timezone UTC")
    fields = body.get("fields") or []
    bad_fields = [f for f in fields if f not in DIMENSIONS | MEASURES]
    if bad_fields or not fields:
        raise bad(f"unknown field(s) for system__activity::history: {bad_fields}")
    rows = history_rows()
    for field, expr in (body.get("filters") or {}).items():
        if field not in DIMENSIONS:
            raise bad(f"unknown filter field {field!r}")
        pred = filter_pred(field, str(expr))
        rows = [r for r in rows if pred(r)]
    dims = [f for f in fields if f in DIMENSIONS]
    meas = [f for f in fields if f in MEASURES]
    groups: dict[tuple, list[dict]] = {}
    for r in rows:
        groups.setdefault(tuple(r[d] for d in dims), []).append(r)
    out = []
    for key, members in groups.items():
        row = dict(zip(dims, key))
        for m in meas:
            if m in ("history.count", "history.query_run_count"):
                row[m] = len(members)
            elif m == "history.dashboard_run_count":
                row[m] = len({x["history.dashboard_session"] for x in members if x["history.dashboard_session"]})
            elif m == "user.count":
                row[m] = len({x["user.id"] for x in members if x["user.id"] is not None})
        out.append(row)
    for s in reversed(body.get("sorts") or []):
        name, *rest = s.split()
        if name not in fields:
            raise bad(f"sort field {name!r} is not selected")
        out.sort(key=lambda r: (r[name] is None, r[name] if r[name] is not None else 0), reverse=bool(rest and rest[0] == "desc"))
    limit = int(body.get("limit") or 5000)
    return out[:limit]


# ----------------------------------------------------------------------- routes

def get_one(collection: str, key: str = "id"):
    def fn(query: dict, m: list[str]):
        for i in DATA[collection]:
            if str(i.get(key)) == m[1]:
                return project([i], query)[0]
        raise ApiError(404, "Not found")
    return fn


def model_one(query: dict, m: list[str]):
    for i in DATA["lookml_models"]:
        if i["name"] == m[1]:
            return project([i], query)[0]
    raise ApiError(404, "Not found")


def explore_one(query: dict, m: list[str]):
    e = DATA["explores"].get(f"{m[1]}::{m[2]}")
    if e is None:
        raise ApiError(404, "Not found")
    return project([e], query)[0]


def query_one(query: dict, m: list[str]):
    q = DATA["queries"].get(m[1])
    if q is None:
        raise ApiError(404, "Not found")
    return q


def look_with_query(query: dict, m: list[str]):
    for look in DATA["looks"]:
        if look["id"] == m[1]:
            full = {**look, "query": DATA["queries"].get(look["query_id"])}
            return project([full], query)[0]
    raise ApiError(404, "Not found")


def results_for(qid: str | None, query: dict) -> list[dict]:
    rows = DATA["query_results"].get(str(qid))
    if rows is None:
        raise ApiError(404, "Not found")
    if query.get("apply_formatting") not in (None, "false") or query.get("rebuild_pdts") not in (None, "false"):
        raise bad("the replay server only serves unformatted results without PDT rebuilds")
    return rows[: int(query.get("limit", "5000"))]


def run_look(query: dict, m: list[str]):
    for look in DATA["looks"]:
        if look["id"] == m[1]:
            return results_for(look["query_id"], query)
    raise ApiError(404, "Not found")


def run_query(query: dict, m: list[str]):
    return results_for(m[1], query)


def git_branches(query: dict, m: list[str]):
    if m[1] not in DATA["git_branches"]:
        raise ApiError(404, "Not found")
    return DATA["git_branches"][m[1]]


def scheduled_plans(query: dict, _m: list[str]):
    if query.get("all_users") != "true" and "user_id" not in query:
        raise bad("expected all_users=true or user_id")
    items = DATA["scheduled_plans"]
    if "user_id" in query:
        items = [p for p in items if p["user_id"] == query["user_id"]]
    return items  # full records: the worker must mask destinations itself


def alerts_search(query: dict, _m: list[str]):
    if query.get("all_owners") != "true":
        raise bad("expected all_owners=true")
    items = DATA["alerts"]
    if "disabled" in query:
        items = [a for a in items if match_param(a["is_disabled"], query["disabled"])]
    return sort_and_page(items, query)


RUN_PARAMS = {"limit", "apply_formatting", "apply_vis", "cache", "image_width", "image_height",
              "generate_drill_links", "force_production", "cache_only", "path_prefix", "rebuild_pdts",
              "server_table_calcs"}

ROUTES = [
    (r"/api/4\.0/dashboards/search", *make_search("dashboards", {
        "id": "id", "slug": "slug", "title": "title", "description": "description", "folder_id": "folder_id",
        "user_id": "user_id", "deleted": "deleted", "view_count": "view_count"})),
    (r"/api/4\.0/dashboard_elements/search", *make_search("dashboard_elements", {
        "dashboard_id": "dashboard_id", "look_id": "look_id", "title": "title", "deleted": "deleted"}, paged=False)),
    (r"/api/4\.0/looks/search", *make_search("looks", {
        "id": "id", "title": "title", "description": "description", "folder_id": "folder_id",
        "user_id": "user_id", "view_count": "view_count", "deleted": "deleted", "query_id": "query_id"})),
    (r"/api/4\.0/looks/([^/]+)", look_with_query, {"fields"}),
    (r"/api/4\.0/looks/([^/]+)/run/json", run_look, RUN_PARAMS),
    (r"/api/4\.0/queries/([^/]+)", query_one, {"fields"}),
    (r"/api/4\.0/queries/([^/]+)/run/json", run_query, RUN_PARAMS),
    (r"/api/4\.0/folders/search", *make_search("folders", {
        "id": "id", "name": "name", "parent_id": "parent_id", "creator_id": "creator_id",
        "is_shared_root": "is_shared_root", "is_users_root": "is_users_root"})),
    (r"/api/4\.0/users/search", *make_search("users", {
        "id": "id", "first_name": "first_name", "last_name": "last_name", "email": "email",
        "is_disabled": "is_disabled", "embed_user": "embed_user", "verified_looker_employee": "verified_looker_employee"})),
    (r"/api/4\.0/groups/search", *make_search("groups", {
        "id": "id", "name": "name", "external_group_id": "external_group_id",
        "externally_managed": "externally_managed", "externally_orphaned": "externally_orphaned"})),
    (r"/api/4\.0/roles", *make_search("roles", {}, paged=False)),
    (r"/api/4\.0/connections", *make_search("connections", {}, full=True, paged=False)),
    (r"/api/4\.0/projects", *make_search("projects", {}, full=True, paged=False)),
    (r"/api/4\.0/projects/([^/]+)/git_branches", git_branches, set()),
    (r"/api/4\.0/lookml_models", *make_search("lookml_models", {})),
    (r"/api/4\.0/lookml_models/([^/]+)", model_one, {"fields"}),
    (r"/api/4\.0/lookml_models/([^/]+)/explores/([^/]+)", explore_one, {"fields", "add_drills_metadata"}),
    (r"/api/4\.0/scheduled_plans", scheduled_plans, {"user_id", "fields", "all_users"}),
    (r"/api/4\.0/alerts/search", alerts_search, {"limit", "offset", "group_by", "fields", "disabled", "frequency",
                                                 "condition_met", "last_run_start", "last_run_end", "all_owners"}),
]


class Handler(BaseHTTPRequestHandler):
    protocol_version = "HTTP/1.1"

    def log_message(self, format: str, *args: object) -> None:  # noqa: A002 - stdlib signature
        """Log to stderr only, so stdout carries nothing except the ``PORT:`` line."""
        sys.stderr.write("looker_mock: " + (format % args) + "\n")

    def _send(self, status: int, body: object, headers: dict | None = None) -> None:
        payload = json.dumps(body).encode()
        self.send_response(status)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(payload)))
        for k, v in (headers or {}).items():
            self.send_header(k, v)
        self.end_headers()
        self.wfile.write(payload)

    def _error(self, e: ApiError) -> None:
        self._send(e.status, {"message": e.message, "documentation_url": "https://cloud.google.com/looker/docs/"}, e.headers)

    def _record(self, method: str, path: str, query: dict, body: object = None) -> None:
        with LOCK:
            REQUESTS.append({"seq": len(REQUESTS) + 1, "method": method, "path": path,
                             "query": json.dumps(query, sort_keys=True),
                             "body": None if body is None else json.dumps(body, sort_keys=True)})

    def _auth(self) -> None:
        h = self.headers.get("Authorization", "")
        m = re.fullmatch(r"(?:Bearer|token) (\S+)", h)
        with LOCK:
            ok = bool(m) and m[1] in TOKENS
        if not ok:
            raise ApiError(401, "Requires authentication.")

    def _read_body(self) -> bytes:
        return self.rfile.read(int(self.headers.get("Content-Length", "0") or 0))

    def do_POST(self) -> None:
        url = urlparse(self.path)
        query = {k: v[-1] for k, v in parse_qs(url.query, keep_blank_values=True).items()}
        raw = self._read_body()
        try:
            if url.path == "/__expire_tokens":
                with LOCK:
                    TOKENS.clear()
                self._send(200, {"ok": True})
                return
            if url.path == "/api/4.0/login":
                form = {k: v[0] for k, v in parse_qs(raw.decode()).items()}
                self._record("POST", url.path, {k: v for k, v in {**query, **form}.items() if k == "client_id"})
                if form.get("client_id") != CLIENT_ID or form.get("client_secret") != CLIENT_SECRET:
                    raise ApiError(404, "Not found")
                token = secrets.token_urlsafe(24)
                with LOCK:
                    TOKENS.add(token)
                self._send(200, {"access_token": token, "token_type": "Bearer", "expires_in": 3600, "refresh_token": None})
                return
            if url.path == "/api/4.0/queries/run/json":
                self._auth()
                try:
                    body = json.loads(raw or b"null")
                except ValueError:
                    raise bad("request body is not JSON") from None
                self._record("POST", url.path, query, body)
                unknown = set(query) - RUN_PARAMS
                if unknown:
                    raise bad(f"unknown query parameter(s): {sorted(unknown)}")
                self._send(200, run_inline(body))
                return
            raise ApiError(404, "Not found")
        except ApiError as e:
            self._error(e)

    def do_GET(self) -> None:
        url = urlparse(self.path)
        query = {k: v[-1] for k, v in parse_qs(url.query, keep_blank_values=True).items()}
        if url.path == "/health":
            self._send(200, {"status": "ok"})
            return
        if url.path == "/__requests":
            with LOCK:
                rows = [r for r in REQUESTS if not query.get("path") or r["path"] == query["path"]]
            self._send(200, rows)
            return
        try:
            for pattern, fn, allowed in ROUTES:
                m = re.fullmatch(pattern, url.path)
                if not m:
                    continue
                self._auth()
                self._record("GET", url.path, query)
                unknown = set(query) - allowed
                if unknown:
                    raise bad(f"unknown query parameter(s): {sorted(unknown)}")
                for key, status in (("/api/4.0/groups/search", 429), ("/api/4.0/roles", 503)):
                    if url.path == key:
                        with LOCK:
                            first = key not in ONCE
                            ONCE.add(key)
                        if first and status == 429:
                            raise ApiError(429, "Too many requests", {"Retry-After": "1"})
                        if first:
                            raise ApiError(503, "Service unavailable")
                self._send(200, fn(query, [m[0], *(unquote(g) for g in m.groups())]))
                return
            raise ApiError(404, "Not found")
        except ApiError as e:
            self._error(e)


def main() -> None:
    """Serve until interrupted, printing ``PORT:<n>`` once bound."""
    parser = argparse.ArgumentParser(description=__doc__.split("\n", 1)[0])
    parser.add_argument("--port", type=int, default=0, help="port to bind (default: any free port)")
    args = parser.parse_args()
    server = ThreadingHTTPServer(("127.0.0.1", args.port), Handler)
    print(f"PORT:{server.server_address[1]}", flush=True)
    with contextlib.suppress(KeyboardInterrupt):
        server.serve_forever()


if __name__ == "__main__":
    main()
