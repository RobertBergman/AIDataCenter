"""Model backed directly by the YAML source of truth.

Used when NetBox is unavailable or deliberately bypassed. Renders byte-identical
artifacts to the NetBox-backed model, which is what makes `--source yaml` a usable
control when debugging whether a config problem came from the data or from NetBox.
"""

from __future__ import annotations

import sotlib as sot


class YamlModel:
    def describe(self) -> str:
        return f"YAML ({sot.SOT_DIR})"

    def devices(self) -> list[sot.Device]:
        return sorted(sot.DEVICES.values(), key=lambda d: d.name)

    def device(self, name: str) -> sot.Device:
        return sot.DEVICES[name]

    def links_for(self, name: str):
        return sot.links_for(name)

    def rail(self, rail_id: int) -> dict:
        return sot.RAILS[rail_id]

    def rail_for_leaf(self, leaf: str) -> dict:
        return sot.RAIL_BY_LEAF[leaf]

    def rail_host_ip(self, dev: sot.Device, rail_id: int) -> str:
        return sot.rail_host_ip(dev, rail_id)

    def expected_neighbors(self, name: str) -> dict:
        return sot.expected_neighbors(name)
