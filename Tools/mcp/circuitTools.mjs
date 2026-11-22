////////////////////////////////////////////////////////
// File:            circuitTools.mjs
// Description:     The brains behind the MCP server: load
//                  the chip index without a browser, turn a
//                  plain-language request into a circuit
//                  document, repair a rough document, and
//                  format a compiled plan as text.
//
// Everything here runs in Node. The compiler, the recipes
// and the step formatter are the exact modules the Builder
// page uses, so what an MCP client sees is what the page
// draws — there is no second implementation to drift.
////////////////////////////////////////////////////////

import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { circuit } from "../../Source/assets/js/Modules/circuit.mjs";
import { circuitView } from "../../Source/assets/js/Modules/circuitView.mjs";
import { recipes, matchRecipe } from "../../Source/assets/js/Modules/recipes.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));

export const REPO = path.resolve(HERE, "..", "..");
export const SOURCE_DIR = path.join(REPO, "Source");
export const INDEX_FILE = path.join(SOURCE_DIR, "api", "circuits", "chips.index.json");

const norm = (s) =>
	String(s ?? "")
		.toLowerCase()
		.replace(/[^a-z0-9]+/g, " ")
		.trim();

const slug = (s) => String(s ?? "").toLowerCase().replace(/[^a-z0-9]+/g, "");

/* -------------------------------------------------- index */

let indexDoc = null;
let audited = false;

/** Load the shipped chip index into the compiler (no fetch, no browser). */
export function loadIndex() {
	if (indexDoc) return indexDoc;
	indexDoc = JSON.parse(readFileSync(INDEX_FILE, "utf8"));
	circuit.index = indexDoc;
	return indexDoc;
}

export function indexCounts() {
	const doc = loadIndex();
	return { ...doc.counts, generated: doc.generated };
}

/* -------------------------------------------------- prompt -> document */

/* How a request names an event source. Order matters: "press the button when
   you walk in" should pick the button, not the trigger volume. */
const SOURCES = [
	{
		when: /(button|press|click|push|tap|switch|lever)/,
		chip: "Button",
		enter: "Pressed",
		exit: "Released",
		note: "A Button board fires Pressed and Released.",
	},
	{
		when: /(touch|interact|use it|hold|grab|grip|hand)/,
		chip: "Interaction Volume",
		enter: "On Use or Hold Completed",
		note: "An Interaction Volume fires when a player uses it.",
	},
	{
		when: /(walk|enter|enters|step|stand|zone|area|proximity|approach|through|near|pass)/,
		chip: "Trigger Volume",
		enter: "Player Entered",
		exit: "Player Exited",
		note: "A Trigger Volume fires when a player walks in and out.",
	},
];

/* What the event should *do*. `on`/`off` are port names on the board or chip;
   `player` is an input that wants the player who triggered it. */
const ACTIONS = [
	{
		when: /(light|lamp|lights|illuminat|glow|dark|bright)/,
		chip: "Point Light",
		on: "Turn On",
		off: "Turn Off",
	},
	{ when: /(door|gate|piston|slid|shutter|hatch|barrier)/, chip: "Piston", on: "Play", off: "Stop" },
	{ when: /(sound|audio|music|noise|beep|ding|sfx|jingle)/, chip: "Audio Player", on: "Play", off: "Stop" },
	{
		when: /(text|message|sign|notif|announce|tell|welcome|hint|instructions|label)/,
		chip: "Show Notification",
		on: "_",
		player: "Player",
	},
	{ when: /(teleport|warp|send them|move the player|transport)/, chip: "Set Position", on: "_", player: "Target" },
	{ when: /(explod|blast|bomb)/, chip: "Explosion Emitter", on: "Explode" },
	{ when: /(spawn|emit|particle|projectile|shoot|fire)/, chip: "Emitter", on: "Start", off: "Stop" },
];

/**
 * Check the composer's own tables against the index. A name that no longer
 * exists is dropped instead of producing a circuit that cannot compile, and
 * reported so it gets fixed rather than silently mis-composing.
 */
export function auditComposer() {
	audited = true;
	const ok = [];
	const broken = [];

	for (const src of SOURCES) {
		const entry = circuit.chip(src.chip);
		if (!entry) {
			broken.push({ chip: src.chip, port: src.enter, reason: "no such chip or board" });
			src.disabled = true;
			continue;
		}
		const probe = circuit.resolvePort(entry, src.enter, "out");
		if (probe.error) {
			broken.push({ chip: src.chip, port: src.enter, reason: probe.error });
			src.disabled = true;
		} else {
			src.disabled = false;
			ok.push(`${src.chip}.${src.enter}`);
		}
	}

	for (const act of ACTIONS) {
		const entry = circuit.chip(act.chip);
		if (!entry) {
			broken.push({ chip: act.chip, port: act.on, reason: "no such chip or board" });
			act.disabled = true;
			continue;
		}
		const probe = circuit.resolvePort(entry, act.on, "in");
		if (probe.error) {
			broken.push({ chip: act.chip, port: act.on, reason: probe.error });
			act.disabled = true;
			continue;
		}
		act.disabled = false;
		ok.push(`${act.chip}.${act.on}`);
		if (act.off) {
			const off = circuit.resolvePort(entry, act.off, "in");
			if (off.error) act.off = null;
			else ok.push(`${act.chip}.${act.off}`);
		}
		if (act.player && circuit.resolvePort(entry, act.player, "in").error) act.player = null;
	}

	return { ok, broken };
}

const STOPWORDS = new Set([
	"the", "and", "that", "when", "with", "this", "into", "from", "then", "make", "want", "need", "should", "could",
	"would", "have", "will", "your", "their", "there", "them", "they", "something", "someone", "players", "player",
]);

/** Chips whose names share a real word with the request, for when the composer
 *  cannot decide. Searching the whole sentence returns noise, so go word by word. */
function candidateChips(text) {
	const words = (String(text).toLowerCase().match(/[a-z]{4,}/g) || []).filter((w) => !STOPWORDS.has(w));
	const found = [];
	for (const word of words) {
		for (const c of circuit.search(word, { limit: 3 })) {
			if (!found.includes(c.label)) found.push(c.label);
		}
	}
	return found.slice(0, 8);
}

function sourceFor(prompt) {
	if (!audited) auditComposer();
	const text = String(prompt || "").toLowerCase();
	return SOURCES.find((s) => !s.disabled && s.when.test(text)) || null;
}

function actionsFor(prompt) {
	if (!audited) auditComposer();
	const text = String(prompt || "").toLowerCase();
	return ACTIONS.filter((a) => !a.disabled && a.when.test(text));
}

/** Player-typed output on a source board, e.g. the Player Entered event's player. */
function playerOutput(entry, event) {
	const res = circuit.resolvePort(entry, `${event}.Player`, "out");
	if (!res.error && res.port.type === "player") return { ref: `${event}.Player`, port: res.port };
	const ports = circuit.portsOf(entry, "out").filter((p) => p.type === "player");
	return ports.length === 1 ? { ref: circuit.describePort(ports[0]).split(":")[0], port: ports[0] } : null;
}

/**
 * Turn a plain-language request into a circuit document, the way Rec Room's
 * Maker AI starts one: pick the event, pick the action, wire them, and only
 * reach for a Sequence when there is more than one thing to do.
 *
 * Returns { doc, via, note } or { error, candidates } when the request names
 * nothing this table understands — in that case the caller writes the document
 * itself and passes it back in, which is what the tool's `circuit` argument is
 * for.
 */
export function compose(prompt) {
	loadIndex();
	const text = String(prompt || "").trim();

	const src = sourceFor(text);
	const actions = actionsFor(text).slice(0, 3);
	const recipe = matchRecipe(text);

	/* A hand-built recipe beats a guess, unless the request wants several effects
	   at once ("open the door and play a ding") — no single recipe does that. */
	if (recipe && !(src && actions.length >= 2)) {
		return { doc: structuredClone(recipe.doc), via: `recipe "${recipe.id}"`, note: recipe.notes };
	}

	if (!src || !actions.length) {
		const candidates = candidateChips(text);
		const missing = [];
		if (!src) missing.push("an event to start from (a Button, Trigger Volume or Interaction Volume)");
		if (!actions.length) missing.push("something for it to do (a light, door, sound, message…)");
		return {
			error: `I could not tell ${missing.join(" or ")} from that request.`,
			candidates,
			recipes: recipes.map((r) => `${r.id}: ${r.title}`),
		};
	}

	const srcEntry = circuit.chip(src.chip);
	const nodes = [{ id: "trigger", chip: src.chip, label: src.chip === "Trigger Volume" ? "Trigger zone" : src.chip }];
	const links = [];

	const wantsOff = /(off|close|stop|release|turn it off|out|leave|exit)/.test(text);
	const exitPort = src.exit && circuit.resolvePort(srcEntry, src.exit, "out").error ? null : src.exit;

	const seq = actions.length > 1;
	if (seq) nodes.push({ id: "order", chip: "Sequence", label: "Do them in order" });

	actions.forEach((act, i) => {
		const id = `act${i + 1}`;
		nodes.push({ id, chip: act.chip, label: act.chip });
		const execPort = seq ? `order.${i + 1}` : `trigger.${src.enter}`;
		links.push([execPort, `${id}.${act.on}`]);

		/* Button released -> the paired "off" port, which is what people mean by
		   "only while held" / "closes again". */
		if (!seq && wantsOff && act.off && exitPort) links.push([`trigger.${exitPort}`, `${id}.${act.off}`]);

		if (act.player) {
			const player = playerOutput(srcEntry, src.enter);
			if (player) links.push([`trigger.${player.ref}`, `${id}.${act.player}`]);
		}
	});

	if (seq) links.unshift([`trigger.${src.enter}`, "order._"]);

	const title =
		actions.length === 1
			? `${src.chip} → ${actions[0].chip}`
			: `${src.chip} → ${actions.map((a) => a.chip).join(" + ")}`;

	return {
		doc: { v: 1, title, notes: src.note, nodes, links },
		via: "composer",
		note: `${src.note} ${seq ? "A Sequence chip runs the actions in order." : ""}`.trim(),
	};
}

/* -------------------------------------------------- repair */

const portKey = (p) => `${p.dir}:${p.sectionIndex}:${p.portIndex}`;

/** A port reference that resolves back to exactly this port. */
function refFor(entry, port, dir) {
	const ports = circuit.portsOf(entry, dir);
	const candidates = [];
	if (port.name && port.name !== "_") candidates.push(port.name);
	candidates.push(`${port.section}.${port.name}`);
	candidates.push(`#${ports.indexOf(port) + 1}`);
	for (const ref of candidates) {
		const res = circuit.resolvePort(entry, ref, dir);
		if (!res.error && portKey(res.port) === portKey(port)) return ref;
	}
	return candidates[candidates.length - 1];
}

function splitRef(text) {
	const raw = String(text ?? "").trim();
	const dot = raw.indexOf(".");
	return dot < 0 ? null : { node: raw.slice(0, dot).trim(), port: raw.slice(dot + 1).trim() };
}

/**
 * Fix the mistakes a model actually makes, in the order it makes them:
 * a chip name that is close but not exact, a node id with the wrong case, a
 * port address that is guessable from the other end of the wire, a link that
 * was written backwards, and links that can never be valid at all.
 *
 * Returns { doc, repairs } — an empty repairs list means it was already fine.
 */
/** How alike two chip names are, ignoring case and punctuation (0…1). */
function ratio(a, b) {
	const x = slug(a);
	const y = slug(b);
	if (!x || !y) return 0;
	if (x === y) return 1;
	const prev = Array.from({ length: y.length + 1 }, (_, i) => i);
	for (let i = 1; i <= x.length; i++) {
		let diag = prev[0];
		prev[0] = i;
		for (let j = 1; j <= y.length; j++) {
			const tmp = prev[j];
			prev[j] = Math.min(prev[j] + 1, prev[j - 1] + 1, diag + (x[i - 1] === y[j - 1] ? 0 : 1));
			diag = tmp;
		}
	}
	return 1 - prev[y.length] / Math.max(x.length, y.length);
}

const REPAIR_SIMILARITY = 0.62;

export function repairDocument(input) {
	loadIndex();
	const doc = JSON.parse(JSON.stringify(input ?? {}));
	const repairs = [];
	const gone = [];

	doc.nodes = (Array.isArray(doc.nodes) ? doc.nodes : []).map((raw, i) => {
		const node = typeof raw === "string" ? { chip: raw } : { ...(raw || {}) };
		node.id = String(node.id ?? (typeof raw === "string" ? slug(raw) || `n${i + 1}` : `n${i + 1}`));
		if (!circuit.chip(node.chip)) {
			/* Only rename when the name really is a near-miss. "Totally Not A Chip"
			   used to get renamed to "AABB Contains Point" by search rank alone. */
			const near = circuit.search(node.chip || "", { limit: 5 })
				.map((c) => c.label)
				.sort((a, b) => ratio(node.chip, b) - ratio(node.chip, a))[0];
			if (near && ratio(node.chip, near) >= REPAIR_SIMILARITY) {
				repairs.push(`chip "${node.chip}" → "${near}"`);
				node.chip = near;
			} else {
				gone.push(node.id);
				repairs.push(`no chip matches "${node.chip}" — node "${node.id}" was dropped`);
			}
		}
		return node;
	});

	const live = doc.nodes.filter((n) => !gone.includes(n.id));
	doc.nodes = live;
	const byId = new Map(live.map((n) => [n.id, n]));
	const findId = (id) => {
		if (byId.has(id)) return id;
		const loose = [...byId.keys()].find((k) => norm(k) === norm(id)) || [...byId.keys()].find((k) => slug(k) === slug(id));
		if (loose) repairs.push(`node id "${id}" → "${loose}"`);
		return loose;
	};
	const entryOf = (id) => circuit.chip(byId.get(id).chip);

	const resolveEnd = (nodeId, ref, dir) => {
		const real = findId(nodeId);
		if (!real) return { error: `no node "${nodeId}"` };
		const entry = entryOf(real);
		const res = circuit.resolvePort(entry, ref, dir);

		if (res.error) {
			/* "TurnOn" and "Turn On" are the same port. Accept a match only when
			   exactly one port agrees once punctuation is ignored. */
			const want = slug(ref);
			const loose = circuit.portsOf(entry, dir).filter((p) => [slug(p.name), slug(p.section), slug(p.section + p.name)].includes(want));
			if (loose.length !== 1) return { node: real, error: res.error };
			const fixed = refFor(entry, loose[0], dir);
			repairs.push(`port "${nodeId}.${ref}" → "${real}.${fixed}"`);
			return { node: real, port: loose[0] };
		}

		const canonicalRef = refFor(entry, res.port, dir);
		if (ref !== canonicalRef) repairs.push(`port "${nodeId}.${ref}" → "${real}.${canonicalRef}"`);
		return { node: real, port: res.port };
	};

	/* Guess a port from the other end of the wire: same type, exactly one
	   candidate, else leave it alone (guessing among two is how you get a
	   circuit that compiles and does the wrong thing). */
	const guessPort = (nodeId, dir, otherType) => {
		if (!otherType) return null;
		const ports = circuit.portsOf(entryOf(nodeId), dir).filter((p) => circuit.typesCompatible(otherType, p.type));
		return ports.length === 1 ? ports[0] : null;
	};

	const links = [];
	for (const raw of Array.isArray(doc.links) ? doc.links : []) {
		const pair = Array.isArray(raw) ? raw : [raw?.from, raw?.to];
		const [fromText, toText] = pair;
		const a = splitRef(fromText);
		const b = splitRef(toText);
		if (!a || !b) {
			repairs.push(`dropped link ${JSON.stringify(raw)} — links are "nodeId.port" pairs`);
			continue;
		}

		let from = resolveEnd(a.node, a.port, "out");
		let to = resolveEnd(b.node, b.port, "in");

		if ((from.error || to.error) && from.node && to.node) {
			const fromPort = from.port || guessPort(from.node, "out", to.port?.type);
			const toPort = to.port || guessPort(to.node, "in", fromPort?.type || from.port?.type);
			if (fromPort) from = { node: from.node, port: fromPort };
			if (toPort) to = { node: to.node, port: toPort };
		}

		/* Written backwards: the "input" exists as an output and vice versa. */
		if ((!from.port || !to.port) && from.node && to.node) {
			const back = resolveEnd(to.node, b.port, "out");
			const fwd = resolveEnd(from.node, a.port, "in");
			if (back.port && fwd.port && circuit.typesCompatible(back.port.type, fwd.port.type)) {
				repairs.push(`link ${fromText} → ${toText} was backwards; reversed`);
				from = back;
				to = fwd;
			}
		}

		if (!from.port || !to.port) {
			repairs.push(`dropped ${fromText} → ${toText}: ${from.error || to.error || "port not found"}`);
			continue;
		}
		if (!circuit.typesCompatible(from.port.type, to.port.type)) {
			repairs.push(`dropped ${fromText} → ${toText}: ${from.port.type} cannot drive ${to.port.type}`);
			continue;
		}

		links.push([`${from.node}.${refFor(entryOf(from.node), from.port, "out")}`, `${to.node}.${refFor(entryOf(to.node), to.port, "in")}`]);
	}

	doc.links = links;
	return { doc, repairs: [...new Set(repairs)] };
}

/* -------------------------------------------------- build + format */

/**
 * compose (or accept) → repair → compile. The document that comes back is the
 * one that compiles, so a caller never has to hand-edit JSON.
 */
export async function build(request = {}) {
	loadIndex();
	const parts = [];
	let doc = request.circuit ? structuredClone(request.circuit) : null;
	let repairs = [];

	if (!doc) {
		if (!String(request.prompt || "").trim()) {
			return { ok: false, error: "Pass either `prompt` (plain language) or `circuit` (a document).", parts };
		}
		const composed = compose(request.prompt);
		if (composed.error) {
			return {
				ok: false,
				error: composed.error,
				candidates: composed.candidates,
				recipes: composed.recipes,
				parts: [`_Composer could not decide. Pass a \`circuit\` document instead — likely chips: ${composed.candidates.join(", ") || "none"}_`],
			};
		}
		doc = composed.doc;
		parts.push(`_composed from the prompt (${composed.via})${composed.note ? " — " + composed.note : ""}_`);
	}

	if (request.auto !== undefined) doc.auto = !!request.auto;

	let compiled = await circuit.compile(doc);
	if (!compiled.ok) {
		const fixed = repairDocument(doc);
		if (fixed.repairs.length) {
			repairs = fixed.repairs;
			doc = fixed.doc;
			compiled = await circuit.compile(doc);
		}
	}

	return { ok: compiled.ok, doc, compiled, repairs, parts };
}

/** The plan as text: what to place, what to wire, what to type, where to look. */
export function formatPlan(compiled, { url, repairs = [], parts = [], doc } = {}) {
	const { rows, chips, values } = circuitView.steps(compiled);
	const out = [];

	out.push(`# ${compiled.title}`);
	out.push(
		compiled.ok
			? "_Valid: every port exists and every wire joins matching types._"
			: "_NOT valid yet — see the diagnostics at the end._",
	);
	if (parts.length) out.push("", ...parts);

	out.push("", `## Place these chips (${compiled.stats.nodes})`);
	for (const [label, count] of chips) out.push(`- ${count}× ${label}`);

	out.push("", `## Wire them, in this order (${rows.length})`);
	rows.forEach((r, i) => {
		const guessed = r.auto ? " _(guessed — check it)_" : "";
		out.push(`${i + 1}. **${r.from}** \`${r.fromPort}\` → **${r.to}** \`${r.toPort}\`${guessed}`);
	});

	if (values.length) {
		out.push("", "## Type in these values");
		for (const v of values) out.push(`- ${v.node} · ${v.port} = \`${v.value}\``);
	}

	if (repairs.length) {
		out.push("", "## Repaired automatically");
		for (const r of repairs) out.push(`- ${r}`);
	}

	const issues = [...compiled.errors.map((e) => ({ ...e, kind: "error" })), ...compiled.warnings.map((w) => ({ ...w, kind: "warning" }))];
	out.push("", "## Diagnostics");
	if (!issues.length) out.push("- no errors, no warnings");
	for (const i of issues) out.push(`- **${i.kind}** \`${i.code}\` ${i.message}${i.hint ? ` _(${i.hint})_` : ""}`);

	if (url) out.push("", "## Preview", url);

	if (doc) out.push("", "## Circuit document", "```json", JSON.stringify(doc, null, 1), "```");
	return out.join("\n");
}
