# NetBox as Source of Truth

NetBox is the **authoritative DCIM + IPAM** system for this cluster. Inventory, prefixes, interfaces, and cables are not maintained long-term in Git YAML (except design seed pre-go-live).

| Concern | SoT | Export consumer |
| ------- | --- | --------------- |
| Devices, roles, racks | NetBox DCIM | ``export_inventory.py`` → Metal3 BMH / seed |
| Mgmt + OOB + VIP IPs | NetBox IPAM | inventory + dnsmasq |
| Prefixes / VLANs | NetBox IPAM | `inventory/ipam.yaml`, network automation later |
| Host↔leaf, leaf↔spine, BMC cables | NetBox cables | `docs/cabling.md` + install CSV |
| BMC credentials | Vault / env | never in NetBox secrets by default |
| K8s desired state | Git (Flux) | lattice of CRs |

```
                 ┌──────────────────┐
   design seed   │ site.yaml (git)  │  day-0 intent only
                 └────────┬─────────┘
                          │ import_seed.py
                          ▼
                 ┌──────────────────┐
                 │     NetBox       │  ◄── live edits, MAC fixes, cable status
                 └────────┬─────────┘
          ┌───────────────┼───────────────┐
          ▼               ▼               ▼
   cluster.yaml      cabling.md      dhcp-hosts.conf
   ipam.yaml         cabling.csv     Metal3 BMH
```

---

## 1. Day-0 (before K8s)

On `seed01`:

```bash
cd bootstrap/netbox
cp env.example .env && $EDITOR .env   # SECRET_KEY + API_TOKEN_PEPPER_1 required
docker compose up -d
export NETBOX_URL=http://127.0.0.1:8081
export NETBOX_TOKEN=$(bash scripts/create_token.sh)   # v2 token: nbt_<key>.<secret>
pip install -r requirements.txt
python3 scripts/import_seed.py
bash ../scripts/netbox-sync.sh
```

Without Docker (design-time / CI):

```bash
bash bootstrap/scripts/netbox-sync.sh --offline
```

Offline expands `seed/site.yaml` (same rail math as import).

> **NetBox 4.6 notes:** API tokens are v2 (`nbt_…`, HMAC-signed; plaintext shown once at creation — `API_TOKEN_PEPPER_1` must be set). MACs are discrete `MACAddress` objects marked primary per interface. Prefixes use generic `scope` (site), VLANs live in a site-scoped VLAN group (direct site assignment deprecated).

---

## 2. Day-2 (production NetBox)

Flux path: `bootstrap/platform/apps/netbox` (`platform-netbox` Kustomization, chart 8.x / NetBox v4.6.5).

After URL is `https://netbox.ai.local`:

1. Create API token (Vault: `secret/netbox/api_token`) — v2 format `nbt_<key>.<secret>`; the chart auto-generates signing peppers.  
2. Re-run `import_seed.py` once **only if** the K8s instance is empty (or use DB dump from seed NetBox).  
3. Point automation `NETBOX_URL` at cluster NetBox.  
4. Decommission seed Docker NetBox after cutover.

**Preferred cutover:** `pg_dump` seed Postgres → restore into Helm Postgres PVC, preserving IDs and cable history.

---

## 3. Custom fields

| Field | Type | On | Use |
| ----- | ---- | -- | --- |
| `k8s_role` | text | device | `control-plane`, `gpu-worker`, … |
| `gpu_count` | int | device | 8 on workers |
| `rail_index` | int | leaf | 0–7 |
| `redfish_url` | text | device | Metal3 BMC address |

---

## 4. IPAM plan (baseline)

| Prefix | VLAN | Role |
| ------ | ---- | ---- |
| 10.10.0.0/24 | 10 mgmt | OS, CP, VIP, seed |
| 10.20.0.0/24 | 20 oob | BMC + switch Management1 |
| 10.30.0.0/16 | fabric | Underlay container (expand later) |
| 10.40.0.0/16 | storage | STOR data |
| 10.96.0.0/12 | — | K8s services (documented only) |
| 10.244.0.0/16 | — | K8s pods (documented only) |

API VIP: `10.10.0.20` → `api.ai.local`.

---

## 5. Change control

| Change | Where | Next step |
| ------ | ----- | --------- |
| New MAC after RMA | NetBox interface | `netbox-sync.sh` → re-render BMH |
| New mgmt IP | NetBox IPAM assign | sync → dnsmasq + BMH |
| Cable installed | Cable status → connected | re-export cabling guide |
| Add GPU rack | NetBox rack + devices + cables | update seed only if design template changes |
| Fabric design change | Update `seed/site.yaml` sabling_policy **or** edit cables in UI | sync |

**Git PR** is still required for: CAPI templates, Flux apps, seed schema versions. **Not** for everyday MAC/IP/cable status.

---

## 6. RBAC (suggested)

| Group | NetBox perms |
| ----- | ------------ |
| netops | DCIM + cables + IPAM write |
| compute | devices read, interfaces write (MAC) |
| platform | read-all + cluster objects |
| audit | read-only |

---

## 7. Integration checklist

- [ ] Seed NetBox healthy; import finishes without missing ifaces  
- [ ] `cluster.yaml` header contains `GENERATED`  
- [ ] Cable counts: 64 host + 64 leaf-spine + BMC count match export  
- [ ] CAPI `02-apply-cluster.sh` consumes exported inventory  
- [ ] Production NetBox under Flux; seed retired or read-only  

---

## Related

- [bootstrap/netbox/README.md](../bootstrap/netbox/README.md)  
- [docs/cabling.md](cabling.md)  
- [docs/bootstrap.md](bootstrap.md)  
