#!/usr/bin/env -S uv run --script
# /// script
# requires-python = ">=3.12"
# dependencies = ["httpx"]
# ///
"""Idempotent R2 bucket provisioner (declarative-via-script).

wrangler.jsonc is the declaration: this script reads its `r2_buckets` bindings
(bucket_name + preview_bucket_name) and creates any bucket that doesn't exist
yet. Re-running converges; it never deletes or modifies existing buckets.

  scripts/cf-r2.py                 ensure every declared bucket exists
  scripts/cf-r2.py --dry-run       print the plan, change nothing
  scripts/cf-r2.py --parse-only    just print the bucket names found in config

Auth: CLOUDFLARE_API_TOKEN env var if set (needs Account > Workers R2
Storage: Edit), else the AI Agent Cloudflare API key from 1Password (by ID).
Account: CLOUDFLARE_ACCOUNT_ID env var, else the token's sole visible account.
"""

import argparse
import json
import os
import pathlib
import subprocess
import sys

import httpx

API = "https://api.cloudflare.com/client/v4"
OP_TOKEN_REF = "op://4eeyrkqibibn7k4j6rz2fbzvxm/mxxpo6neiz3grdyrjj7rv7nume/credential"


def api_token() -> str:
    if tok := os.environ.get("CLOUDFLARE_API_TOKEN"):
        return tok
    return subprocess.run(
        ["op", "read", OP_TOKEN_REF], capture_output=True, text=True, check=True
    ).stdout.strip()


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
    # trailing commas: ", }" / ", ]" are legal JSONC but not JSON
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


def declared_buckets(config: pathlib.Path) -> list[str]:
    cfg = json.loads(strip_jsonc(config.read_text()))
    names = []
    for b in cfg.get("r2_buckets", []):
        for key in ("bucket_name", "preview_bucket_name"):
            if (name := b.get(key)) and name not in names:
                names.append(name)
    return names


def main() -> None:
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument(
        "--config",
        type=pathlib.Path,
        default=pathlib.Path(__file__).parent.parent / "wrangler.jsonc",
    )
    ap.add_argument("--parse-only", action="store_true", help="print declared bucket names, no API")
    ap.add_argument("--dry-run", action="store_true", help="print the plan, change nothing")
    args = ap.parse_args()

    wanted = declared_buckets(args.config)
    if args.parse_only:
        print("\n".join(wanted) or "(no r2_buckets declared)")
        return
    if not wanted:
        print(f"no r2_buckets declared in {args.config} - nothing to do")
        return

    c = httpx.Client(headers={"Authorization": f"Bearer {api_token()}"}, timeout=30)

    account = os.environ.get("CLOUDFLARE_ACCOUNT_ID")
    if not account:
        accounts = unwrap(c.get(f"{API}/accounts"))
        if len(accounts) != 1:
            sys.exit("Multiple accounts visible - set CLOUDFLARE_ACCOUNT_ID")
        account = accounts[0]["id"]

    existing = {
        b["name"]
        for b in unwrap(c.get(f"{API}/accounts/{account}/r2/buckets", params={"per_page": 100}))[
            "buckets"
        ]
    }

    for name in wanted:
        if name in existing:
            print(f"'{name}' already converged")
        elif args.dry_run:
            print(f"WOULD CREATE bucket '{name}'")
        else:
            unwrap(c.post(f"{API}/accounts/{account}/r2/buckets", json={"name": name}))
            print(f"created bucket '{name}'")


if __name__ == "__main__":
    main()
