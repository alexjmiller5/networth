# /// script
# requires-python = ">=3.12"
# dependencies = ["httpx"]
# ///
"""Mint this project's machine-creatable credentials (op-project-bootstrap
provision contract: --list prints mintable field names; --field NAME prints
ONLY the secret to stdout, progress on stderr).

Runs under whatever `op` auth the caller has; needs read access to the
AI Agent vault (admin CF key with User API Tokens: Edit). Idempotent per field.
"""

import json
import subprocess
import sys

import httpx

CF_ACCOUNT = "1e69de15e5dc3dddea6db7b3ae8087bc"
NAME = "networth"
# AI Agent vault Cloudflare API key, by ID (names are mutable, IDs aren't)
OP_CF_TOKEN = "op://4eeyrkqibibn7k4j6rz2fbzvxm/mxxpo6neiz3grdyrjj7rv7nume/credential"

FIELDS = ["api-token", "account-id", "LIFE_HUB_TOKEN"]


def log(msg: str) -> None:
    print(msg, file=sys.stderr)


def op_read(ref: str) -> str:
    return subprocess.run(
        ["op", "read", ref], capture_output=True, text=True, check=True
    ).stdout.strip()


def mint_deploy_token() -> str:
    """Project-scoped CF token for CI. Adjust `want` to what THIS site deploys
    (D1 Write, Workers KV Storage Write, ...). Token values are shown once,
    so delete any same-named token and recreate. More minter shapes (Resend
    send keys, Turnstile secrets, random tokens): see acl-price-watch."""
    c = httpx.Client(
        base_url="https://api.cloudflare.com/client/v4",
        headers={"Authorization": f"Bearer {op_read(OP_CF_TOKEN)}"},
    )
    token_name = f"{NAME}-deploy"
    tokens = c.get("/user/tokens", params={"per_page": 100}).raise_for_status().json()["result"]
    for t in tokens or []:
        if t["name"] == token_name:
            log(f"deleting existing token {token_name} (value not re-readable)")
            c.delete(f"/user/tokens/{t['id']}").raise_for_status()
    groups = c.get("/user/tokens/permission_groups").raise_for_status().json()["result"]
    want = {"Workers Scripts Write", "Workers R2 Storage Write"}
    ids = [{"id": g["id"]} for g in groups if g["name"] in want]
    assert len(ids) == len(want), f"permission groups not found: {want}"
    r = c.post(
        "/user/tokens",
        json={
            "name": token_name,
            "policies": [
                {
                    "effect": "allow",
                    "resources": {f"com.cloudflare.api.account.{CF_ACCOUNT}": "*"},
                    "permission_groups": ids,
                }
            ],
        },
    ).raise_for_status()
    log(f"✓ scoped deploy token '{token_name}' minted (Workers Scripts + R2)")
    return r.json()["result"]["value"]


def mint_hub_token() -> str:
    """Use the caller's configured life CLI/admin access, never another app's token."""
    def life_json(*args):
        result = subprocess.run(["life", "token", *args], capture_output=True, text=True)
        if result.returncode:
            raise RuntimeError("life token command failed; check the configured hub and admin access")
        return json.loads(result.stdout)

    if any(t["name"] == NAME and not t.get("revoked_at") for t in life_json("list")):
        raise RuntimeError("A networth hub token already exists. Restore its stored value before provisioning again.")
    result = life_json("create", NAME, "--scopes", "tables:read")
    if result.get("scopes") != "tables:read" or not result.get("token"):
        raise RuntimeError("Hub did not return a read-only token")
    log("Scoped read-only hub token minted")
    return result["token"]


MINTERS = {
    "api-token": mint_deploy_token,
    "account-id": lambda: CF_ACCOUNT,
    "LIFE_HUB_TOKEN": mint_hub_token,
}


def main() -> None:
    if sys.argv[1:] == ["--list"]:
        print("\n".join(FIELDS))
    elif len(sys.argv) == 3 and sys.argv[1] == "--field" and sys.argv[2] in FIELDS:
        print(MINTERS[sys.argv[2]]())
    else:
        sys.exit(f"usage: provision.py --list | --field {{{','.join(FIELDS)}}}")


if __name__ == "__main__":
    main()
