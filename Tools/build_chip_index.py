"""Build the compact, LLM-facing chip index from the local CV2 data files.

The raw dumps in `Circuits Data/` are ~2.5 MB and full of exporter detail. LLM
clients (and the Circuit Builder page) need a stable, small file that answers:
which chips exist, what each port is called, what type it takes, and how safe the
chip is to use. Nothing here is guessed: every field is copied from the dumps.

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


if __name__ == "__main__":
    chips = json.loads(CHIP_SRC.read_text(encoding="utf-8"))
    objects = json.loads(OBJ_SRC.read_text(encoding="utf-8"))

    index: dict[str, dict] = {}
    for name, cfg in chips["configs"].items():
        index[cfg.get("chipName") or name] = entry(cfg, "chip")
    for name, cfg in objects["configs"].items():
        label = cfg.get("chipName") or name
        index[label] = entry(cfg, "object")

    # Add chips the export does not have yet. They keep their provenance field so
    # a reader can tell a documented chip from an exported one.
    documented = 0
    known = {slug(label) for label in index}
    if SUPP_SRC.exists():
        supplement = json.loads(SUPP_SRC.read_text(encoding="utf-8"))
        for label, item in supplement.get("chips", {}).items():
            if slug(item.get("label") or label) in known:
                continue
            index[item.get("label") or label] = item
            documented += 1

    types = sorted(
        {p.split(":", 1)[1] for item in index.values() for sec in item["sections"] for p in (sec["in"] + sec["out"]) if ":" in p}
    )

    doc = {
        "version": 1,
        "generated": __import__("datetime").date.today().isoformat(),
        "source": {
            "chips": "Circuits Data/CV2_ChipConfigs.json",
            "objects": "Circuits Data/CV2_ObjectConfigs.json",
            "chipsExportedAtUtc": chips.get("exportedAtUtc"),
            "objectsUpdatedAtUtc": objects.get("updatedAtUtc"),
            "documented": "Circuits Data/CV2_Docs_Supplement.json (circuits.pages.dev)",
        },
        "counts": {
            "chips": len(chips["configs"]),
            "objects": len(objects["configs"]),
            "documented": documented,
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
