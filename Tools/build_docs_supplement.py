"""Find chips the local CV2 dumps are missing, using the community chip docs.

The dumps in `Circuits Data/` come from the game and lag behind it: chips added
in newer updates simply are not there. https://circuits.pages.dev documents
every chip with its ports, so this script crawls that site, diffs it against the
dumps, and writes the extras to `Circuits Data/CV2_Docs_Supplement.json` so
`Tools/build_chip_index.py` can merge them.

Pages are cached in `Tools/.cache/docs/`; pass --refresh to re-download.
Nothing is invented: names, ports, descriptions and flags are copied from the
documented chip, and each entry records the page it came from.

Usage:
  python Tools/build_docs_supplement.py            # crawl (cached) + diff + write
  python Tools/build_docs_supplement.py --report   # diff only, write nothing
  python Tools/build_docs_supplement.py --refresh  # ignore the page cache
"""
from __future__ import annotations

import argparse
import difflib
import html
import json
import re
import sys
import time
import urllib.request
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
CHIP_SRC = ROOT / "Circuits Data" / "CV2_ChipConfigs.json"
OBJ_SRC = ROOT / "Circuits Data" / "CV2_ObjectConfigs.json"
OUT = ROOT / "Circuits Data" / "CV2_Docs_Supplement.json"
CACHE = ROOT / "Tools" / ".cache" / "docs"

BASE = "https://circuits.pages.dev"
SITEMAP = f"{BASE}/sitemap.xml"
DESC_LIMIT = 120


def slug(name: str) -> str:
    return re.sub(r"[^a-z0-9]+", "", (name or "").lower())


def get(url: str, tries: int = 3) -> str:
    last = None
    for i in range(tries):
        try:
            req = urllib.request.Request(url, headers={"User-Agent": "rec-room-circuits-index/1.0"})
            with urllib.request.urlopen(req, timeout=30) as r:
                return r.read().decode("utf-8", "replace")
        except Exception as exc:  # noqa: BLE001 - report and retry
            last = exc
            time.sleep(0.6 * (i + 1))
    raise RuntimeError(f"{url}: {last}")


def chip_urls(refresh: bool) -> list[str]:
    CACHE.mkdir(parents=True, exist_ok=True)
    sitemap = CACHE / "sitemap.xml"
    if refresh or not sitemap.exists():
        sitemap.write_text(get(SITEMAP), encoding="utf-8")
    urls = sorted(set(re.findall(r"https://circuits\.pages\.dev/docs/chips/[a-z0-9-]+", sitemap.read_text(encoding="utf-8"))))
    return urls


def text_of(fragment: str) -> str:
    """HTML fragment -> single-line text (titles are escaped twice on the site)."""
    s = re.sub(r"<[^>]+>", " ", fragment)
    s = html.unescape(html.unescape(s))
    return re.sub(r"\s+", " ", s).strip()


def port_cell(cell: str) -> dict | None:
    raw = text_of(cell)
    if not raw:
        return None
    if "|" in raw:
        ptype, name = raw.split("|", 1)
        ptype, name = ptype.strip(), name.strip()
    else:
        ptype, name = raw.strip(), ""
    if not name or name.lower() in {"no name.", "no name"}:
        name = "_"
    return {"name": name, "type": ptype or "any"}


def parse(page: str, url: str) -> dict | None:
    h1 = re.search(r"<h1[^>]*>(.*?)</h1>", page, re.S)
    if not h1:
        return None
    name = text_of(h1.group(1))
    if not name:
        return None

    # Description: the first paragraph after the title, before the port table.
    tail = page[h1.end():]
    cut = len(tail)
    for marker in ("<table", "<h3", "<details", '<div class="admonition'):
        i = tail.find(marker)
        if i != -1:
            cut = min(cut, i)
    para = re.search(r"<p>(.*?)</p>", tail[:cut], re.S)
    desc = text_of(para.group(1)) if para else ""

    inputs: list[dict] = []
    outputs: list[dict] = []
    table = re.search(
        r"<table>\s*<thead>\s*<tr>(.*?)</tr>\s*</thead>\s*<tbody>(.*?)</tbody>\s*</table>", page, re.S
    )
    if table:
        heads = [text_of(th).lower() for th in re.findall(r"<th[^>]*>(.*?)</th>", table.group(1), re.S)]
        for row in re.findall(r"<tr>(.*?)</tr>", table.group(2), re.S):
            cells = re.findall(r"<td[^>]*>(.*?)</td>", row, re.S)
            for i, cell in enumerate(cells):
                port = port_cell(cell)
                if not port:
                    continue
                col = heads[i] if i < len(heads) else ""
                if col.startswith("in"):
                    inputs.append(port)
                elif col.startswith("out"):
                    outputs.append(port)

    props: dict[str, str] = {}
    for label, value in re.findall(r"<tr><td>(.*?)</td><td>(.*?)</td></tr>", page, re.S):
        props[text_of(label)] = text_of(value)

    tags = []
    tag_block = re.search(r"<b>Tags:</b>(.*?)</ul>", page, re.S)
    if tag_block:
        tags = [text_of(t) for t in re.findall(r"<a[^>]*>(.*?)</a>", tag_block.group(1), re.S)]
        tags = [t for t in tags if t]

    beta = (props.get("Is beta required?") or "").strip().lower() == "yes"
    troll = (props.get("Is chip a trolling risk?") or "").strip().lower() == "yes"
    role = (props.get("Is chip a role assignment risk?") or "").strip().lower() == "yes"

    return {
        "name": name,
        "url": url,
        "uuid": props.get("Chip UUID") or url.rsplit("/", 1)[-1],
        "desc": desc,
        "inputs": inputs,
        "outputs": outputs,
        "tags": tags,
        "beta": beta,
        "troll": troll,
        "role": role,
        "availability": props.get("Room availability") or "",
    }


def load_docs(urls: list[str], refresh: bool) -> list[dict]:
    CACHE.mkdir(parents=True, exist_ok=True)

    def one(url: str) -> dict | None:
        uuid = url.rsplit("/", 1)[-1]
        path = CACHE / f"{uuid}.html"
        try:
            if refresh or not path.exists():
                path.write_text(get(url), encoding="utf-8")
            return parse(path.read_text(encoding="utf-8"), url)
        except Exception as exc:  # noqa: BLE001 - one bad page must not stop the crawl
            print(f"  ! {uuid}: {exc}", file=sys.stderr)
            return None

    out = []
    with ThreadPoolExecutor(max_workers=8) as pool:
        for i, doc in enumerate(pool.map(one, urls), 1):
            if doc:
                out.append(doc)
            if i % 100 == 0:
                print(f"  fetched {i}/{len(urls)}", file=sys.stderr)
    return out


def local_names() -> tuple[set[str], set[str]]:
    """(every name the dumps already provide, board+section combinations)."""
    chips = json.loads(CHIP_SRC.read_text(encoding="utf-8"))["configs"]
    objects = json.loads(OBJ_SRC.read_text(encoding="utf-8"))["configs"]

    names: set[str] = set()
    for cfg in chips.values():
        for key in (cfg.get("chipName"), cfg.get("paletteName")):
            if key:
                names.add(slug(key))
    board_sections: set[str] = set()
    for cfg in objects.values():
        label = cfg.get("chipName") or ""
        for key in (label, cfg.get("paletteName")):
            if key:
                names.add(slug(key))
        for sec in cfg.get("nodeDescs") or []:
            sname = sec.get("name") or ""
            if sname and label:
                board_sections.add(slug(f"{label} {sname}"))
    return names, board_sections


def local_labels() -> list[str]:
    chips = json.loads(CHIP_SRC.read_text(encoding="utf-8"))["configs"]
    return [c.get("chipName") or k for k, c in chips.items()]


def entry(doc: dict, labels: list[str]) -> dict:
    desc = doc["desc"]
    if len(desc) > DESC_LIMIT:
        desc = desc[:DESC_LIMIT].rsplit(" ", 1)[0].rstrip(" ,.;:") + "…"
    flags = [f for f, on in (("beta", doc["beta"]), ("troll", doc["troll"]), ("role", doc["role"])) if on]
    near = difflib.get_close_matches(doc["name"], labels, n=1, cutoff=0.86)
    item = {
        "id": slug(doc["name"]),
        "label": doc["name"],
        "kind": "chip",
        "cat": doc["tags"],
        "desc": desc,
        "flags": flags,
        "sections": [
            {
                "name": "",
                "in": [f"{p['name']}:{p['type']}" for p in doc["inputs"]],
                "out": [f"{p['name']}:{p['type']}" for p in doc["outputs"]],
            }
        ],
        "prov": {
            "source": "circuits.pages.dev",
            "url": doc["url"],
            "uuid": doc["uuid"],
            "availability": doc["availability"],
            "note": "Not in the local CV2 dumps; ports copied from the community chip docs.",
        },
    }
    if near:
        item["prov"]["similar"] = near[0]
        item["prov"]["note"] += f" Similar local chip: {near[0]}."
    return item


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--refresh", action="store_true", help="re-download cached pages")
    ap.add_argument("--report", action="store_true", help="print the diff, write nothing")
    args = ap.parse_args()

    urls = chip_urls(args.refresh)
    print(f"docs: {len(urls)} chip pages")
    docs = load_docs(urls, args.refresh)
    print(f"docs parsed: {len(docs)}")

    names, board_sections = local_names()
    missing: list[dict] = []
    board_hits = 0
    for doc in docs:
        key = slug(doc["name"])
        if key in names:
            continue
        if key in board_sections:
            board_hits += 1
            continue
        missing.append(doc)

    # Drop docs that only restate an existing chip with a suffix such as "(new)".
    def close(name: str) -> str | None:
        bare = slug(re.sub(r"\((new|deprecated|beta|old)\)", "", name, flags=re.I))
        if bare in names or bare in board_sections:
            return bare
        return None

    still: list[dict] = []
    aliases: list[dict] = []
    for doc in missing:
        bare = close(doc["name"])
        if bare:
            aliases.append({"label": doc["name"], "alias": bare, "url": doc["url"]})
        else:
            still.append(doc)

    only_docs = {slug(d["name"]) for d in docs}
    extra_local = sorted(n for n in names if n and n not in only_docs)

    print(f"\nmatched chips:           {len(docs) - len(missing)}")
    print(f"  of which board+section: {board_hits}")
    print(f"  variant of local chip:  {len(aliases)}")
    print(f"missing from local data: {len(still)}")
    print(f"local-only names:        {len(extra_local)} (chips the docs do not list)")

    if still:
        print("\n-- missing --")
        for doc in sorted(still, key=lambda d: d["name"].lower()):
            ports = len(doc["inputs"]) + len(doc["outputs"])
            print(f"  {doc['name']}  ({ports} ports)  {doc['url']}")
            near = difflib.get_close_matches(doc["name"].lower(), sorted(names), n=2, cutoff=0.82)
            if near:
                print(f"      close to local: {near}")

    if args.report:
        return 0

    labels = local_labels()
    payload = {
        "generated": __import__("datetime").date.today().isoformat(),
        "source": {
            "site": BASE,
            "category": f"{BASE}/docs/category/chips",
            "pages": len(docs),
        },
        "chips": {doc["name"]: entry(doc, labels) for doc in sorted(still, key=lambda d: d["name"].lower())},
    }
    OUT.write_text(json.dumps(payload, indent=1, ensure_ascii=False) + "\n", encoding="utf-8")
    print(f"\nwrote {OUT.relative_to(ROOT)}  ({len(payload['chips'])} chips)")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
