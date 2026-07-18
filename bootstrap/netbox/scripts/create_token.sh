#!/usr/bin/env bash
# Create a NetBox API token for the superuser via django shell (docker day-0).
set -euo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "${ROOT}"

TOKEN_DESC="${TOKEN_DESC:-bootstrap-export}"
CONTAINER="${NETBOX_CONTAINER:-$(docker compose ps -q netbox)}"

if [[ -z "${CONTAINER}" ]]; then
  echo "NetBox container not running. docker compose up -d first." >&2
  exit 1
fi

docker compose exec -T netbox /opt/netbox/venv/bin/python /opt/netbox/netbox/manage.py shell <<'PY'
from users.models import Token, User
import secrets
u = User.objects.filter(is_superuser=True).first()
if not u:
    raise SystemExit("no superuser")
key = secrets.token_hex(20)
Token.objects.filter(user=u, description="bootstrap-export").delete()
t = Token(user=u, key=key, description="bootstrap-export", write_enabled=True)
t.save()
print(key)
PY
