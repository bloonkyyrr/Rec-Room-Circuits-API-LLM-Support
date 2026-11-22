# Rec Room Circuits V2 — writing wiring plans

This skill lets an agent turn a plain-language request ("a door that slides open when someone
walks up") into a **Rec Room Circuits V2 wiring plan**: which chips to place, which ports to
connect, and which literals to type in. The output is drawn in the browser by
[`builder.html`](../../builder.html) so a maker can read it and rebuild it by hand in game.

There is no export to the game. Nothing here changes a room. It is a diagram plus a checklist.

---

## 1. Where the truth lives

| What | Where |
| --- | --- |
| Compact chip index (1328 chips + 46 object boards + 19 documented-only) | `api/circuits/chips.index.json` |
| Raw exporter dumps | `../Circuits Data/CV2_ChipConfigs.json`, `CV2_ObjectConfigs.json` |
| Chips newer than the dumps | `../Circuits Data/CV2_Docs_Supplement.json` (from circuits.pages.dev) |
| Document schema | `api/circuits/schema.json` |
| Worked example | `api/circuits/examples/sliding-door.circuit.json` |
| Renderer page | `builder.html` |
| MCP server (if your client speaks MCP) | `../Tools/mcp/server.mjs` — see `../Tools/mcp/README.md` |

The raw dumps are ~2.5 MB; **use the index**. One entry looks like:

```json
"Delay": {"id":"delay","label":"Delay","kind":"chip","cat":["Commonly Used","Control Flow","Time"],
 "desc":"Fires outputs based on the inputted time to delay…","flags":["r1","r2"],
 "sections":[{"name":"Delay","in":["Run:exec","Delay (s):float","Cancel:exec"],
              "out":["Run:exec","After Delay:exec","Cancel:exec"]}]}
```

`kind` is `chip` (place on a circuit board) or `object` (a room board: Trigger Volume, Button,
Room Door, Point Light, Piston, Text, Interaction Volume…). `flags` only lists what is true;
`hidden` and `deprecated` should be avoided unless the user asks for them.

Some entries carry a `prov` field: those chips are newer than the exporter dumps and their
ports were taken from the community docs at circuits.pages.dev. Use them normally — the ports
are real — but if a `prov.similar` chip name is listed, that older local chip may be the one
you meant (e.g. `Set Game HUD Element Label` vs `Set HUD Element Label`).

**Do not guess chip names.** Verify every one against the index, e.g.:

```bash
jq -r '.chips | keys[]' api/circuits/chips.index.json | grep -i door
jq '.chips["Trigger Volume"]' api/circuits/chips.index.json
```

Naming you cannot infer from English:

- Variables are typed and the type is in the name: `bool Variable`, `int Variable`,
  `float Variable`, `string Variable`, `Vector3 Variable`.
- Unnamed ports are written `_:type` in the index. Variable chips have two `_` ports on each
  side (exec + value); `_` in a link always means the **exec** one.
- One chip can hold several sections; each section is a group of ports on the same chip
  (object boards use one section per event, e.g. `Player Entered`, `Player Exited`).

---

## 2. The document

```json
{
  "v": 1,
  "title": "Sliding door",
  "notes": "One or two sentences explaining the build.",
  "nodes": [
    { "id": "zone", "chip": "Trigger Volume", "label": "Doorway" },
    { "id": "gate", "chip": "Piston", "label": "Door panel" },
    { "id": "wait", "chip": "Delay", "label": "Hold", "values": { "Delay (s)": "3" } }
  ],
  "links": [
    ["zone.Player Entered", "wait.Run"],
    ["wait.Run", "gate.Play"],
    ["wait.After Delay", "gate.Stop"]
  ],
  "auto": false
}
```

- `id` — short, unique, referenced by links. Nodes may be plain strings (`"Delay"`) when one of
  each is enough.
- `chip` — exact index name.
- `label` — optional human caption; use it when the same chip appears twice.
- `values` — literals to type into **unconnected** input ports, keyed by port name. Use
  `"Value#2"` for the second port with that name.
- `links` — `["nodeId.output", "nodeId.input"]`, output first. `{"from":…,"to":…}` also works.
- `auto` — default `true`. Leave it on to let the compiler chain exec ports in node order and
  join ports that share a name. Set `false` when you listed every wire.
- `at` — `[x, y]` on **every** node to lay the plan out by hand; otherwise it is laid out for you.

### Port references

| Written as | Means |
| --- | --- |
| `Sum` | the port named `Sum` |
| `Player Entered` | that section — object-board events resolve to their exec port |
| `Set Locked.Locked` | section `Set Locked`, port `Locked` |
| `out2` / `in2` / `#2` | the 2nd output / input / port on that side |
| `exec2` | the 2nd exec port |
| `_` | the unnamed exec port |
| `*` or `any` | first free compatible port (the compiler picks) |

Duplicated names are an error unless you qualify them (`Player Entered.Player`).

### Type rules the compiler enforces

- exec ↔ exec only; data ↔ exec is rejected.
- Data types must match. `T`, `T0`, `T1` and `any` are generic and accept anything.
- Union types such as `(int | float | Vector3)` accept any listed member.
- One wire per data input; one wire per exec **output**. To branch an exec signal, use a
  `Sequence` chip or put the shared work behind `If` / `Event Definition`.

---

## 3. Check your work

Compile before answering:

```bash
node --input-type=module -e '
import { circuit } from "./Source/assets/js/Modules/circuit.mjs";
import fs from "fs";
// circuit.mjs uses fetch(); in Node point it at the file:
globalThis.fetch = async (u) => ({ ok: true, json: async () => JSON.parse(fs.readFileSync("./Source/" + u, "utf8")) });
const doc = JSON.parse(fs.readFileSync(process.argv[1], "utf8"));
const out = await circuit.compile(doc);
console.log(out.ok ? "OK" : "ERRORS", out.errors, out.warnings, out.stats);
' path/to/circuit.json
```

`compile()` returns `errors` (blocking: unknown chip, missing port, bad type, self-port) and
`warnings` (non-blocking: isolated node, overwritten input, ambiguous auto-connect). Every error
carries a `hint` naming the ports that do exist — read it instead of guessing again.

---

## 4. Show it

Open the plan in the browser:

```
builder.html?doc=api/circuits/examples/sliding-door.circuit.json
builder.html?doc=<encodeURIComponent(JSON)>
builder.html?recipe=timed-door
```

`?doc=` accepts a same-origin URL/path or inline URL-encoded JSON. Inline JSON is fine up to a
few KB; past that write a file next to the examples and link it.

The page draws the chips with the site's real chip CSS and colours, labels each wire with the
destination port, and lists the plan under **Wire it up**: chips to place, wires in order, values
to type. Dashed wires were guessed by `auto` and are marked *guessed*.

---

## 5. What this cannot tell you

Be explicit about these when you answer, because they change whether the build works:

- **Placement and parenting** — the plan says "Piston", not where the piston goes or what it moves.
- **Board scope** — variables, event definitions and custom boards are per-scope; the plan does not
  model scope boundaries. Keep everything on one board unless the user says otherwise.
- **Asset ports** — `Audio`, `Avatar Item`, `Texture`, `Destination Room`, `Consumable`, `Reward`
  and similar are dragged onto the chip from the palette; a typed string will not satisfy them.
- **Chip cost** — object boards list `requiredChips` in the raw dump; the plan does not total it.
- **Names of things you must create** — event names, variable names and interaction prompts are
  free text in game. Put them in `notes` so the maker knows what to name them.

---

## 6. Style

- Smallest circuit that does the job. No decorative chips.
- One `notes` sentence about how the pieces fit; the checklist already lists the wires, so do not
  restate it.
- If the request cannot be built from the index, say which chip is missing rather than inventing one.
- If the request is ambiguous (which door? unlock or slide?), pick the reading that needs the
  fewest chips and state the assumption in `notes`.
