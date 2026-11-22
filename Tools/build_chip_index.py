"""Build the compact, LLM-facing chip index from the local CV2 data files.

The raw dumps in `Circuits Data/` are ~2.5 MB and full of exporter detail. LLM
clients (and the Circuit Builder page) need a stable, small file that answers:
which chips exist, what each port is called, what type it takes, and how safe the
chip is to use. Exported fields are copied from the dumps; documented-only chips
and post-export official changes are merged from their separately sourced files.
Repeated palette names retain distinct port signatures instead of overwriting.

Usage:  python Tools/build_chip_index.py
Output: Source/api/circuits/chips.index.json
"""
from __future__ import annotations

import json
import re
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
CHIP_SRC = ROOT / "Circuits Data" / "CV2_ChipConfigs.json"
OBJ_SRC = ROOT / "Circuits Data" / "CV2_ObjectConfigs.json"
# Chips the dumps predate, documented at circuits.pages.dev (see the other script).
SUPP_SRC = ROOT / "Circuits Data" / "CV2_Docs_Supplement.json"
UPDATES_SRC = ROOT / "Circuits Data" / "CV2_Official_Updates.json"
OUT = ROOT / "Source" / "api" / "circuits" / "chips.index.json"

DESC_LIMIT = 120


def slug(name: str) -> str:
    """Stable lowercase id used for case/space-insensitive lookups."""
    return re.sub(r"[^a-z0-9]+", "", name.lower())


def flags(cfg: dict) -> list[str]:
    """Only the flags that are true, in a fixed order, so the index stays small."""
    dep = ((cfg.get("deprecationStage") or {}).get("name") or "Active") != "Active"
    pairs = [
        ("r1", bool(cfg.get("isValidInRoom1"))),
        ("r2", bool(cfg.get("isValidInRoom2"))),
        ("beta", bool(cfg.get("isBetaChip"))),
        ("dev", bool(cfg.get("isDevChip"))),
        ("studio", bool(cfg.get("isStudioChip"))),
        ("troll", bool(cfg.get("isTrollingRisk"))),
        ("role", bool(cfg.get("isRoleAssignmentRisk"))),
        ("hidden", bool(cfg.get("isHiddenInPalette"))),
        ("deprecated", dep),
    ]
    return [name for name, on in pairs if on]


def categories(cfg: dict) -> list[str]:
    cats = []
    for f in cfg.get("filters") or []:
        path = [p for p in (f.get("FilterPath") or []) if p]
        if path:
            cats.append(" / ".join(path))
    return sorted(set(cats))


def port(p: dict) -> str:
    """Ports are written "Name:Type"; an unnamed port is "_:Type"."""
    return f"{p.get('name') or '_'}:{p.get('type') or 'any'}"


def sections(cfg: dict) -> list[dict]:
    out = []
    for sec in cfg.get("nodeDescs") or []:
        item = {"name": sec.get("name") or ""}
        tp = [f"{p.get('name', '')}: {p.get('type', '')}" for p in sec.get("typeParams") or []]
        if tp:
            item["tp"] = tp
        item["in"] = [port(p) for p in sec.get("inputs") or []]
        item["out"] = [port(p) for p in sec.get("outputs") or []]
        out.append(item)
    return out


def entry(cfg: dict, kind: str) -> dict:
    desc = (cfg.get("description") or "").strip().replace("\r", " ").replace("\n", " ")
    if len(desc) > DESC_LIMIT:
        cut = desc[:DESC_LIMIT].rsplit(" ", 1)[0].rstrip(" ,.;:")
        desc = cut + "…"
    item = {
        "id": slug(cfg.get("chipName") or ""),
        "label": cfg.get("paletteName") or cfg.get("chipName") or "",
        "kind": kind,
        "cat": categories(cfg),
        "desc": desc,
        "flags": flags(cfg),
        "sections": sections(cfg),
    }
    if kind == "object":
        item["requiredChips"] = cfg.get("requiredChips")
    return item


def is_deprecated(cfg: dict) -> bool:
    return ((cfg.get("deprecationStage") or {}).get("name") or "Active") != "Active"


def signature(cfg: dict) -> tuple:
    """Port shape and section names, ignoring descriptions and room availability."""
    return tuple(
        (
            sec.get("name") or "",
            tuple((p.get("name") or "", p.get("type") or "any") for p in sec.get("typeParams") or []),
            tuple((p.get("name") or "", p.get("type") or "any") for p in sec.get("inputs") or []),
            tuple((p.get("name") or "", p.get("type") or "any") for p in sec.get("outputs") or []),
        )
        for sec in cfg.get("nodeDescs") or []
    )


def semantic_flags(cfg: dict) -> tuple:
    """Flags that distinguish otherwise identical palette variants."""
    return tuple(
        bool(cfg.get(field))
        for field in (
            "isBetaChip",
            "isDevChip",
            "isStudioChip",
            "isTrollingRisk",
            "isRoleAssignmentRisk",
            "isHiddenInPalette",
        )
    )


def room_set(configs: list[dict]) -> set[int]:
    rooms = set()
    if any(cfg.get("isValidInRoom1") for cfg in configs):
        rooms.add(1)
    if any(cfg.get("isValidInRoom2") for cfg in configs):
        rooms.add(2)
    return rooms


def group_configs(configs: list[dict]) -> list[list[dict]]:
    """Combine exact port/status duplicates while keeping distinct signatures."""
    groups: dict[tuple, list[dict]] = {}
    for cfg in configs:
        groups.setdefault((signature(cfg), semantic_flags(cfg)), []).append(cfg)
    return list(groups.values())


def variant_tags(configs: list[dict], deprecated: bool = False) -> list[str]:
    rooms = room_set(configs)
    tags = []
    if rooms == {1}:
        tags.append("Rooms 1")
    elif rooms == {2}:
        tags.append("Rooms 2")
    elif not rooms:
        tags.append("Room availability unknown")

    cfg = configs[0]
    if deprecated:
        tags.append("Deprecated")
    if cfg.get("isBetaChip"):
        tags.append("Beta")
    if cfg.get("isDevChip"):
        tags.append("Dev")
    if cfg.get("isStudioChip"):
        tags.append("Studio")
    if cfg.get("isHiddenInPalette"):
        tags.append("Hidden")
    if cfg.get("isTrollingRisk"):
        tags.append("Trolling Risk")
    if cfg.get("isRoleAssignmentRisk"):
        tags.append("Role Assignment Risk")
    return tags


def group_priority(configs: list[dict]) -> tuple:
    rooms = room_set(configs)
    cfg = configs[0]
    return (
        0 if 1 in rooms else 1,
        0 if 2 in rooms else 1,
        0 if not cfg.get("isHiddenInPalette") else 1,
        0 if not cfg.get("isDevChip") else 1,
        0 if not cfg.get("isBetaChip") else 1,
    )


def group_entry(configs: list[dict], base_label: str, label: str) -> dict:
    """Create one searchable record, merging exact R1/R2 duplicates."""
    cfg = max(
        configs,
        key=lambda item: (
            bool((item.get("description") or "").strip()),
            not bool(item.get("isHiddenInPalette")),
        ),
    )
    item = entry(cfg, "chip")
    item["label"] = label
    item["id"] = slug(label)
    item["flags"] = [
        flag
        for flag in ("r1", "r2", "beta", "dev", "studio", "troll", "role", "hidden", "deprecated")
        if any(flag in flags(config) for config in configs)
    ]
    if label != base_label:
        # The suffix distinguishes a room-specific or legacy signature. This
        # field retains the exact palette label used in Rec Room.
        item["paletteName"] = base_label
    return item


def unique_label(index: dict, label: str) -> str:
    if label not in index:
        return label
    n = 2
    while f"{label} (Variant {n})" in index:
        n += 1
    return f"{label} (Variant {n})"


def add_chip_group(index: dict, name: str, configs: list[dict]) -> None:
    base_label = configs[0].get("paletteName") or name
    current = [cfg for cfg in configs if not is_deprecated(cfg)]
    deprecated = [cfg for cfg in configs if is_deprecated(cfg)]
    current_groups = group_configs(current)
    deprecated_groups = group_configs(deprecated)

    if current_groups:
        current_groups.sort(key=group_priority)
        primary = current_groups[0]
        for group in current_groups:
            if group is primary:
                label = base_label
            else:
                tags = variant_tags(group)
                label = f"{base_label} ({', '.join(tags) or 'Variant'})"
            label = unique_label(index, label)
            index[label] = group_entry(group, base_label, label)

    # An old configuration with the same signature and flags as the current
    # version adds no useful port information. Keep deprecated variants only
    # when they preserve a distinct interface or availability.
    kept_deprecated = []
    for group in deprecated_groups:
        exemplar = group[0]
        covered = any(
            signature(exemplar) == signature(active[0])
            and semantic_flags(exemplar) == semantic_flags(active[0])
            and room_set(group).issubset(room_set(active))
            for active in current_groups
        )
        if not covered:
            kept_deprecated.append(group)

    if not current_groups and len(deprecated_groups) == 1:
        kept_deprecated = deprecated_groups

    for group in sorted(kept_deprecated, key=group_priority):
        tags = variant_tags(group, deprecated=True)
        label = f"{base_label} ({', '.join(tags) or 'Deprecated'})"
        if not current_groups and len(kept_deprecated) == 1:
            label = base_label
        label = unique_label(index, label)
        index[label] = group_entry(group, base_label, label)


def apply_official_updates(index: dict) -> None:
    if not UPDATES_SRC.exists():
        return
    updates = json.loads(UPDATES_SRC.read_text(encoding="utf-8")).get("updates") or []
    for update in updates:
        target = update["chip"]
        item = index.get(target)
        if not item:
            raise ValueError(f"Official update target is missing from chip index: {target}")

        for section_name, ports in (update.get("addOutputs") or {}).items():
            matches = [section for section in item["sections"] if section.get("name") == section_name]
            if len(matches) != 1:
                raise ValueError(f"Expected one section named {section_name!r} on {target}, found {len(matches)}")
            outputs = matches[0]["out"]
            for value in ports:
                name, type_name = value.split(":", 1)
                existing = [p for p in outputs if p.split(":", 1)[0] == name]
                if existing and existing != [value]:
                    raise ValueError(f"Official update conflicts with existing port on {target}: {existing}")
                if not existing:
                    outputs.append(value)

        if update.get("addEventOptions"):
            options = item.setdefault("eventOptionsAdded", [])
            for option in update["addEventOptions"]:
                if option not in options:
                    options.append(option)

        if update.get("addConfigurationOptions"):
            options = item.setdefault("configurationOptionsAdded", [])
            for option in update["addConfigurationOptions"]:
                if option not in options:
                    options.append(option)

        item.setdefault("updates", []).append(
            {
                "date": update["date"],
                "source": "Rec Room Ship Notes",
                "url": update["url"],
                "note": update["note"],
            }
        )


if __name__ == "__main__":
    chips = json.loads(CHIP_SRC.read_text(encoding="utf-8"))
    objects = json.loads(OBJ_SRC.read_text(encoding="utf-8"))

    index: dict[str, dict] = {}
    groups: dict[str, list[dict]] = {}
    for name, cfg in chips["configs"].items():
        groups.setdefault(cfg.get("chipName") or name, []).append(cfg)
    for name, configs in groups.items():
        add_chip_group(index, name, configs)

    for name, cfg in objects["configs"].items():
        label = cfg.get("chipName") or name
        if label in index:
            raise ValueError(f"Object board label collides with chip label: {label}")
        index[label] = entry(cfg, "object")

    # Add chips the export does not have yet. Preserve the exact palette name
    # when the raw export has room-specific or deprecated variants.
    documented = 0
    known = {slug(label) for label, item in index.items()}
    known.update(slug(item.get("paletteName") or "") for item in index.values())
    if SUPP_SRC.exists():
        supplement = json.loads(SUPP_SRC.read_text(encoding="utf-8"))
        for label, item in supplement.get("chips", {}).items():
            if slug(item.get("label") or label) in known:
                continue
            index[item.get("label") or label] = item
            documented += 1

    apply_official_updates(index)

    types = sorted(
        {p.split(":", 1)[1] for item in index.values() for sec in item["sections"] for p in (sec["in"] + sec["out"]) if ":" in p}
    )
    source_chip_entries = len(index) - len(objects["configs"]) - documented

    doc = {
        "version": 1,
        "generated": __import__("datetime").date.today().isoformat(),
        "source": {
            "chips": "Circuits Data/CV2_ChipConfigs.json",
            "objects": "Circuits Data/CV2_ObjectConfigs.json",
            "chipsExportedAtUtc": chips.get("exportedAtUtc"),
            "objectsUpdatedAtUtc": objects.get("updatedAtUtc"),
            "documented": "Circuits Data/CV2_Docs_Supplement.json (circuits.pages.dev)",
            "officialUpdates": "Circuits Data/CV2_Official_Updates.json (Rec Room Ship Notes)",
        },
        "counts": {
            "chips": source_chip_entries,
            "objects": len(objects["configs"]),
            "documented": documented,
            "sourceChipConfigs": len(chips["configs"]),
            "total": len(index),
        },
        "portTypes": types,
        "chips": dict(sorted(index.items(), key=lambda kv: kv[0].lower())),
    }

    OUT.parent.mkdir(parents=True, exist_ok=True)
    OUT.write_text(json.dumps(doc, ensure_ascii=False, separators=(",", ":")), encoding="utf-8")
    print(f"wrote {OUT.relative_to(ROOT)}  ({OUT.stat().st_size / 1024:.0f} KB)")
    print(
        f"  chips={doc['counts']['chips']} objects={doc['counts']['objects']} "
        f"documented={doc['counts']['documented']} portTypes={len(types)}"
    )
