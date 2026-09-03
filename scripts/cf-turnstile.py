#!/usr/bin/env -S uv run --script
# /// script
# requires-python = ">=3.12"
# dependencies = ["httpx"]
# ///
"""Idempotent Cloudflare Turnstile widget provisioner (declarative-via-script).

Creates or updates ONE managed-mode widget for this site's hostname(s). The
desired state reads straight off the invocation:

  scripts/cf-turnstile.py --name <site> --domain example.com [--domain www.example.com]

Prints the sitekey (PUBLIC_TURNSTILE_SITE_KEY). The SECRET is printed ONLY on
first create - Cloudflare never re-shows it - so immediately store it as
TURNSTILE_SECRET_KEY in the project's 1P `<Project> ENV` item and add both to
`.env.tpl`. Re-runs converge domains and re-print the sitekey.

Auth: CLOUDFLARE_API_TOKEN env var if set (needs Account > Turnstile > Edit),
else the AI Agent Cloudflare API key from 1Password (by ID). Account:
CLOUDFLARE_ACCOUNT_ID env var, else the token's sole visible account.
"""

import argparse
import os
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


def main() -> None:
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("--name", required=True, help="widget name (use the project slug)")
    ap.add_argument("--domain", action="append", required=True, dest="domains")
    args = ap.parse_args()

    c = httpx.Client(headers={"Authorization": f"Bearer {api_token()}"}, timeout=30)

    account = os.environ.get("CLOUDFLARE_ACCOUNT_ID")
    if not account:
        accounts = unwrap(c.get(f"{API}/accounts"))
        if len(accounts) != 1:
            sys.exit("Multiple accounts visible - set CLOUDFLARE_ACCOUNT_ID")
        account = accounts[0]["id"]

    widgets = unwrap(c.get(f"{API}/accounts/{account}/challenges/widgets", params={"per_page": 50}))
    existing = next((w for w in widgets if w["name"] == args.name), None)

    if existing is None:
        w = unwrap(
            c.post(
                f"{API}/accounts/{account}/challenges/widgets",
                json={"name": args.name, "mode": "managed", "domains": sorted(set(args.domains))},
            )
        )
        print(f"created widget '{args.name}'")
        print(f"PUBLIC_TURNSTILE_SITE_KEY={w['sitekey']}")
        print(f"TURNSTILE_SECRET_KEY={w['secret']}  <- shown ONCE, store in 1P now")
        return

    want = sorted(set(existing["domains"]) | set(args.domains))
    if want != sorted(existing["domains"]):
        unwrap(
            c.put(
                f"{API}/accounts/{account}/challenges/widgets/{existing['sitekey']}",
                json={"name": args.name, "mode": existing["mode"], "domains": want},
            )
        )
        print(f"updated widget '{args.name}' domains -> {want}")
    else:
        print(f"widget '{args.name}' already converged")
    print(f"PUBLIC_TURNSTILE_SITE_KEY={existing['sitekey']}")
    print("(secret not re-shown by Cloudflare - it lives in the project's 1P ENV item)")


if __name__ == "__main__":
    main()
