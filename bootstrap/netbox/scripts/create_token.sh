#!/usr/bin/env bash
# Create a NetBox API token via the token provision endpoint.
#
# NetBox 4.5+ issues v2 tokens: the returned credential is "nbt_<key>.<secret>"
# (HMAC-signed; plaintext shown once at creation). Legacy v1 tokens are still
# accepted by NetBox 4.6 but will be removed in 4.7 — this script always
# provisions v2 tokens.
#
# Usage:
#   export NETBOX_TOKEN=$(./scripts/create_token.sh)
#
# Env:
#   NETBOX_URL       (default http://127.0.0.1:8081)
#   NETBOX_USER      (default: SUPERUSER_NAME from .env, else admin)
#   NETBOX_PASSWORD  (default: SUPERUSER_PASSWORD from .env)
#   TOKEN_DESC       (default bootstrap-export)
set -euo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

# Pull superuser credentials from the compose .env if present and not set.
if [[ -f "${ROOT}/.env" ]]; then
  # shellcheck disable=SC1090
  source <(grep -E '^(SUPERUSER_NAME|SUPERUSER_PASSWORD)=' "${ROOT}/.env" || true)
fi

export NETBOX_URL="${NETBOX_URL:-http://127.0.0.1:8081}"
export NETBOX_USER="${NETBOX_USER:-${SUPERUSER_NAME:-admin}}"
export NETBOX_PASSWORD="${NETBOX_PASSWORD:-${SUPERUSER_PASSWORD:?set NETBOX_PASSWORD or SUPERUSER_PASSWORD in .env}}"
export TOKEN_DESC="${TOKEN_DESC:-bootstrap-export}"

python3 - <<'PY'
import json
import os
import sys
import urllib.request
import urllib.error

url = os.environ["NETBOX_URL"].rstrip("/") + "/api/users/tokens/provision/"
payload = {
    "username": os.environ["NETBOX_USER"],
    "password": os.environ["NETBOX_PASSWORD"],
    "description": os.environ["TOKEN_DESC"],
}
req = urllib.request.Request(
    url,
    data=json.dumps(payload).encode(),
    headers={"Content-Type": "application/json"},
    method="POST",
)
try:
    with urllib.request.urlopen(req, timeout=30) as resp:
        data = json.load(resp)
except urllib.error.HTTPError as e:
    body = e.read().decode(errors="replace")
    print(f"token provision failed ({e.code}): {body}", file=sys.stderr)
    sys.exit(1)
except urllib.error.URLError as e:
    print(f"cannot reach {url}: {e.reason}", file=sys.stderr)
    sys.exit(1)

# v2 (NetBox 4.5+): full credential is nbt_<key>.<token>; v1: token is the key.
if data.get("version") == 2:
    print(f"nbt_{data['key']}.{data['token']}")
else:
    print(data.get("token") or data["key"])
PY
