# Circuit Builder MCP server

An [MCP](https://modelcontextprotocol.io) server for the Rec Room CV2 chip data in this repo.
Any MCP client — Freebuff, Claude Desktop, an IDE agent, your own script — can search the chip
index, compose a circuit from plain language, check it, repair it, and hand back a live preview
URL that draws the wiring plan.

Nothing is imported into Rec Room: the output is a diagram plus the checklist you follow with the
maker pen. The server reads the shipped chip index and compiles online or offline — no account,
no key, no network.

## Requirements

Node 18 or newer. No dependencies, nothing to install.

```bash
node Tools/mcp/server.mjs          # talks MCP over stdio
node Tools/mcp/server.mjs --port 8790
```

## Connect a client

Add it to the client's MCP config. The command is `node`, the argument is the **absolute** path to
`server.mjs`:

```json
{
  "mcpServers": {
    "rec-room-circuits": {
      "command": "node",
      "args": ["<path-to-repo>/Tools/mcp/server.mjs"]
    }
  }
}
```

Optional: `"env": { "CIRCUITS_MCP_PORT": "8790" }` (or pass `--port 8790`) picks the port the
preview server uses. It defaults to 8788 and steps up to the next free port if that one is taken,
so several clients can run at once.

## Tools

| Tool | What it does |
| --- | --- |
| `search_chips` | Search indexed chip variants, 19 documented-only chips, and 46 object boards by name, ports, description, event choices, configuration updates, or category. Optional `kind: "chip" \| "object"`. |
| `get_chip` | Every section, input and output of one chip, with types, flags and provenance. |
| `list_recipes` | The eight offline patterns and the keywords each matches. |
| `build_circuit` | `prompt` (plain language) or `circuit` (a document) → compiles, auto-connects, repairs, returns the plan, the exact document, and a preview URL with visible, port-type-coloured wires. |
| `validate_circuit` | Compile a document and list every error and warning. Cheapest check. |
| `repair_circuit` | Fix a rough document and say what changed. |
| `preview_circuit` | Preview URL with visible, port-type-coloured wires. Refresh an already-open page if it shows stale wire styling. |

A circuit document is name-addressed, so no ids or port indices leak into it:

```json
{
  "title": "Sliding door",
  "nodes": [
    { "id": "zone", "chip": "Trigger Volume", "label": "Doorway" },
    { "id": "gate", "chip": "Piston", "label": "Door panel" }
  ],
  "links": [["zone.Player Entered", "gate.Play"], ["zone.Player Exited", "gate.Stop"]]
}
```

## How a prompt becomes a circuit

1. **Recipe** — if the request matches one of the eight hand-built patterns (`matchRecipe`), that
   document is used as-is.
2. **Composer** — otherwise an event source (Button, Trigger Volume, Interaction Volume) and up to
   three actions (light, door/piston, audio, notification, teleport, explosion, emitter) are picked
   from the words in the request. Two or more actions get a `Sequence` so nothing fights over one
   exec output. A prompt that names two effects beats a single-effect recipe.
3. **Document** — pass `circuit` yourself for full control; it goes through the same compiler.
4. **Repair** — before giving up on a document the server fixes what it safely can: a near-miss
   chip name (`Trigger Volum` → `Trigger Volume`, but not `Totally Not A Chip` → anything),
   node-id case, a port written `TurnOn` instead of `Turn On`, an unresolvable port guessed from
   the type at the other end of the wire, links written backwards, and links that can never be
   valid. Every change is listed in the output.

Auto-connect is deliberately conservative. Exec ports are chained only when a document declares
no exec wires at all, and data wires are only made on matching port names. A single type-compatible
candidate is reported as a suggestion, never wired — a type-only guess produced "Is Pressed →
Locked", which compiles and is wrong.

## Preview

`build_circuit` serves the Builder page itself:

```
http://127.0.0.1:8788/builder.html?doc=/mcp/preview/<id>.json
```

The static server binds `127.0.0.1` only, serves `Source/`, sends `cache-control: no-store`, and
keeps the last 200 built documents in memory under `/mcp/preview/<id>.json`. They disappear when
the server stops, so a link is for the session that produced it — call `build_circuit` again for
a fresh one.
Wires use their semantic port-type colours and a non-scaling stroke to stay visible when the graph
is fit to the browser view.

## Notes

- stdout carries JSON-RPC only; logs go to stderr, so a client never sees a stray line.
- The composer's event/action table is checked against the index at `initialize`. If a chip or
  port it names has changed, that entry is switched off and the reason is logged to stderr, rather
  than composing a circuit that cannot compile.
- Regenerate the index after a game update: `python Tools/build_docs_supplement.py && python Tools/build_chip_index.py`.
