# NetBox — Source of Truth

NetBox owns **DCIM, IPAM, inventory, and cabling** for the AI cluster. Git holds schema + seed + export tooling; live assignments (MACs, BMC IPs after scan, cable labels) live in NetBox.

> Pinned to **NetBox v4.6.5** (`docker-compose.yaml`, `platform/apps/netbox`). Notable 4.5/4.6 behaviors this tooling accounts for:
>
> - **v2 API tokens** (`nbt_<key>.<secret>`, Bearer auth) — require `API_TOKEN_PEPPER_1` set in `.env`; legacy v1 tokens still work but are removed in NetBox 4.7.
> - **MAC addresses are first-class objects** — interfaces get a `MACAddress` assigned and marked primary; the old `mac_address` write field is read-only.
> - **Prefixes are generically scoped** (`scope_type`/`scope_id`), no direct `site` FK.
> - **VLANs attach to a site-scoped VLAN group** — direct VLAN→site assignment is deprecated.

```
  bootstrap/netbox/seed/site.yaml   ← design intent (versioned)
           │
           ▼ import_seed.py
        NetBox (seed docker → later K8s)
           │
           ├─ export_inventory.py → inventory/cluster.yaml
           ├─ export_cabling.py   → docs/cabling.md + CSV
           ├─ export_ipam.py      → IP pool facts / Metal3 hints
           └─ export_dnsmasq.py   → seed static leases
```

## Lifecycle

| Phase | Where NetBox runs | Purpose |
| ----- | ----------------- | ------- |
| **Day-0** | Docker Compose on `seed01` | Enter/import design; export inventory before CAPI |
| **Day-2** | Flux `platform-netbox` on cluster | HA Postgres + NetBox; seed instance decommissioned or replica |

**Rule:** never treat `inventory/cluster.yaml` as authoritative. It is always regenerated from NetBox (`# generated: do not edit`).

## Quick start (seed host)

```bash
cd bootstrap/netbox
cp env.example .env   # set SECRET_KEY, API_TOKEN_PEPPER_1, SUPERUSER_*
docker compose up -d
# wait until http://seed:8081 healthy (first boot migrates; can take ~3 min)

export NETBOX_URL=http://127.0.0.1:8081
export NETBOX_TOKEN=$(./scripts/create_token.sh)   # v2 token: nbt_<key>.<secret>

python3 scripts/import_seed.py
python3 scripts/export_inventory.py -o ../inventory/cluster.yaml
python3 scripts/export_cabling.py -o ../../docs/cabling.md --csv ../../docs/cabling.csv
```

Then continue bootstrap:

```bash
bash ../scripts/00-seed-host.sh      # uses exported inventory
BMC_USERNAME=… BMC_PASSWORD=… bash ../scripts/02-apply-cluster.sh
```

## Data model (this cluster)

| NetBox object | Cluster meaning |
| ------------- | --------------- |
| Site | `lab` (or production site name) |
| Location / Rack | `GPU-1`, `GPU-2`, `BOOT`, `STOR` |
| Device role | `gpu-worker`, `control-plane`, `utility`, `rail-leaf`, `spine`, `oob-switch`, `storage` |
| Device type | B200 server, 7060DX5-32, 7060DX5-64S, 7010TX-48, … |
| Platform | `ubuntu-24.04`, `eos` |
| Interface | `mgmt0`, `bmc`, `rail0`…`rail7`, `EthernetN` on switches |
| MAC address | Discrete MACAddress objects, primary per interface (4.2+ model) |
| Cable | Host↔leaf rail, leaf↔spine, BMC↔OOB, mgmt |
| Prefix | Mgmt, OOB, fabric underlay, K8s pod/service — site-scoped via `scope_type` |
| IP address | Primary mgmt, BMC, VIP, service endpoints |
| VLAN group | Site-scoped group holding all cluster VLANs |
| VLAN | mgmt (10), oob (20), fabric underlay / RoCE VRFs — in the site VLAN group |
| Cluster type + Cluster | Kubernetes `ai-cluster` |
| Virtual chassis (opt) | MLAG OOB pair |
| Custom fields | `k8s_role`, `gpu_count`, `rail_index`, `redfish_url` |

Custom fields defined in seed import (idempotent).

## Credentials

- NetBox API token → Vault after platform is up (`secret/netbox/api`)
- BMC passwords **not** stored full-fidelity in NetBox; use secrets manager. NetBox holds BMC **IP + interface** only.
- Optional: NetBox secrets plugin later — default is ESO/Vault.

## Scripts

| Script | Action |
| ------ | ------ |
| `scripts/import_seed.py` | Apply `seed/site.yaml` (+ generated rails/cables) |
| `scripts/export_inventory.py` | Devices → `cluster.yaml` |
| `scripts/export_cabling.py` | Cable matrix markdown + CSV |
| `scripts/export_ipam.py` | Prefix/IP YAML for ops |
| `scripts/export_dnsmasq.py` | `dhcp-host=` lines from mgmt+MAC |
| `scripts/create_token.sh` | Provision a v2 API token (`nbt_…`) via `/api/users/tokens/provision/` |

## Related docs

- [docs/netbox.md](../../docs/netbox.md) — ops, RBAC, sync policy  
- [docs/cabling.md](../../docs/cabling.md) — human cabling guide (exported)  
- [docs/bootstrap.md](../../docs/bootstrap.md) — bring-up order  
