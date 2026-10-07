#!/usr/bin/env -S uv run --script
# /// script
# requires-python = ">=3.12"
# dependencies = ["httpx"]
# ///
"""Idempotent D1 database provisioner (declarative-via-script).

wrangler.jsonc is the declaration: this script reads its `d1_databases`
bindings (database_name + database_id) and creates any database that doesn't
exist yet, then reports the id wrangler.jsonc must carry. Re-running converges;
it never deletes. Schema lives in migrations/ (`wrangler d1 migrations apply`).

  scripts/cf-d1.py                 ensure every declared database exists
  scripts/cf-d1.py --dry-run       print the plan, change nothing
  scripts/cf-d1.py --parse-only    just print the names found in config

Auth: CLOUDFLARE_API_TOKEN env var (needs Account > D1: Edit).
Account: CLOUDFLARE_ACCOUNT_ID env var, else the token's sole visible account.
"""

import argparse
import json
import os
import pathlib
import sys

import httpx

API = "https://api.cloudflare.com/client/v4"


def api_token() -> str:
    if tok := os.environ.get("CLOUDFLARE_API_TOKEN"):
        return tok
    sys.exit("Set CLOUDFLARE_API_TOKEN for the owning project's provisioning identity")


def unwrap(r: httpx.Response) -> dict | list:
    r.raise_for_status()
    body = r.json()
    if not body.get("success"):
        sys.exit(f"Cloudflare API error: {body.get('errors')}")
    return body["result"]


def strip_jsonc(text: str) -> str:
    """JSONC -> JSON: drop // and /* */ comments (string-safe) + trailing commas."""
    out, i, n = [], 0, len(text)
    in_str = False
    while i < n:
        ch = text[i]
        if in_str:
            out.append(ch)
            if ch == "\\" and i + 1 < n:
                out.append(text[i + 1])
                i += 1
            elif ch == '"':
                in_str = False
        elif ch == '"':
            in_str = True
            out.append(ch)
        elif ch == "/" and i + 1 < n and text[i + 1] == "/":
            while i < n and text[i] != "\n":
                i += 1
            continue
        elif ch == "/" and i + 1 < n and text[i + 1] == "*":
            i = text.find("*/", i + 2)
            if i == -1:
                break
            i += 2
            continue
        else:
            out.append(ch)
        i += 1
    cleaned, j = [], 0
    s = "".join(out)
    while j < len(s):
        if s[j] == ",":
            k = j + 1
            while k < len(s) and s[k] in " \t\r\n":
                k += 1
            if k < len(s) and s[k] in "}]":
                j += 1
                continue
        cleaned.append(s[j])
        j += 1
    return "".join(cleaned)


def declared(config: pathlib.Path) -> dict[str, str]:
    """database_name -> declared database_id (may be a CHANGEME placeholder)."""
    cfg = json.loads(strip_jsonc(config.read_text()))
    return {
        d["database_name"]: d.get("database_id", "")
        for d in cfg.get("d1_databases", [])
    }


def main() -> None:
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument(
        "--config",
        type=pathlib.Path,
        default=pathlib.Path(__file__).parent.parent / "wrangler.jsonc",
    )
    ap.add_argument(
        "--parse-only", action="store_true", help="print declared names, no API"
    )
    ap.add_argument(
        "--dry-run", action="store_true", help="print the plan, change nothing"
    )
    args = ap.parse_args()

    wanted = declared(args.config)
    if args.parse_only:
        print("\n".join(wanted) or "(no d1_databases declared)")
        return
    if not wanted:
        print(f"no d1_databases declared in {args.config} - nothing to do")
        return

    c = httpx.Client(headers={"Authorization": f"Bearer {api_token()}"}, timeout=30)
    account = os.environ.get("CLOUDFLARE_ACCOUNT_ID")
    if not account:
        accounts = unwrap(c.get(f"{API}/accounts"))
        if len(accounts) != 1:
            sys.exit("Multiple accounts visible - set CLOUDFLARE_ACCOUNT_ID")
        account = accounts[0]["id"]

    existing = {
        d["name"]: d["uuid"]
        for d in unwrap(
            c.get(f"{API}/accounts/{account}/d1/database", params={"per_page": 100})
        )
    }
    drift = False
    for name, declared_id in wanted.items():
        if name in existing:
            uuid = existing[name]
            print(f"'{name}' exists ({uuid})")
        elif args.dry_run:
            print(f"WOULD CREATE '{name}'")
            continue
        else:
            uuid = unwrap(
                c.post(f"{API}/accounts/{account}/d1/database", json={"name": name})
            )["uuid"]
            print(f"created '{name}' ({uuid})")
        if declared_id != uuid:
            drift = True
            print(
                f"  -> set database_id to {uuid} in {args.config.name} (declared: {declared_id or 'none'})"
            )
    if drift:
        sys.exit(1)


if __name__ == "__main__":
    main()
