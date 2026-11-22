////////////////////////////////////////////////////////
// File:            builder.mjs
// Description:     Circuit Builder page. Turns a request
//                  (or a circuit document) into a wiring
//                  plan: chips, ports, wires, and the
//                  checklist you follow in game.
////////////////////////////////////////////////////////

import { circuit } from "../../Modules/circuit.mjs";
import { circuitView } from "../../Modules/circuitView.mjs";
import { recipes, matchRecipe } from "../../Modules/recipes.mjs";

const $el = (id) => document.getElementById(id);

const state = {
	current: null,
	lastDoc: null,
};

/* -------------------------------------------------- page */

function init() {
	for (const recipe of recipes) {
		const btn = document.createElement("button");
		btn.type = "button";
		btn.className = "b-chip-btn";
		btn.textContent = recipe.title;
		btn.title = recipe.notes;
		btn.addEventListener("click", () => {
			$el("prompt").value = recipe.title;
			runRecipe(recipe);
		});
		$el("examples").appendChild(btn);
	}

	$el("generate").addEventListener("click", generate);
	$el("build").addEventListener("click", () => buildFromText());
	$el("download").addEventListener("click", download);
	$el("copy-prompt").addEventListener("click", copyPromptForLlm);
	$el("copy-llm").addEventListener("click", () => copy($el("llm-prompt").value));

	$el("prompt").addEventListener("keydown", (e) => {
		if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) generate();
	});

	document.querySelectorAll(".b-tab").forEach((tab) => {
		tab.addEventListener("click", () => showTab(tab.dataset.tab));
	});

	circuit
		.loadIndex()
		.then(() => {
			bootFromUrl();
		})
		.catch((err) => {
			$el("plan").innerHTML = "";
			message($el("plan"), "error", `Chip index failed to load: ${err.message}`, "Serve this folder over http (not file://) so api/circuits/chips.index.json can be fetched.");
		});
}

function bootFromUrl() {
	const params = new URLSearchParams(location.search);
	const recipeId = params.get("recipe");
	const docParam = params.get("doc");
	const prompt = params.get("prompt");

	if (prompt) $el("prompt").value = prompt;

	if (recipeId) {
		const recipe = recipes.find((r) => r.id === recipeId);
		if (recipe) {
			$el("prompt").value = recipe.title;
			return runRecipe(recipe);
		}
	}

	if (!docParam) return;

	if (/^https?:\/\//.test(docParam) || docParam.endsWith(".json")) {
		fetch(docParam)
			.then((r) => {
				if (!r.ok) throw new Error(`${r.status} fetching ${docParam}`);
				return r.json();
			})
			.then((doc) => renderDoc(doc))
			.catch((err) => message($el("plan"), "error", `Could not load ${escapeHtml(docParam)}: ${err.message}`));
		return;
	}

	try {
		renderDoc(JSON.parse(docParam));
	} catch (err) {
		message($el("plan"), "error", `The ?doc= value is not valid JSON: ${err.message}`);
	}
}

/* -------------------------------------------------- actions */

function generate() {
	const prompt = $el("prompt").value.trim();
	if (!prompt) {
		$el("prompt").focus();
		return;
	}
	const recipe = matchRecipe(prompt);
	if (recipe) {
		runRecipe(recipe);
		return;
	}

	$el("llm").hidden = false;
	$el("llm-prompt").value = buildLlmPrompt(prompt);
	showTab("steps");
	message(
		document.getElementById("plan"),
		"warn",
		"No offline pattern fits that request yet.",
		"Send the copied prompt to any model, then paste its JSON into “Circuit JSON” below.",
	);
}

function runRecipe(recipe) {
	const doc = JSON.parse(JSON.stringify(recipe.doc));
	$el("llm").hidden = true;
	renderDoc(doc);
}

async function buildFromText() {
	const text = $el("doc").value.trim();
	if (!text) {
		$el("json-wrap").open = true;
		return;
	}
	let doc;
	try {
		doc = JSON.parse(text);
	} catch (err) {
		showTab("diag");
		$el("diag").innerHTML = "";
		message($el("diag"), "error", `That is not valid JSON: ${err.message}`);
		return;
	}
	await renderDoc(doc);
}

async function renderDoc(doc) {
	state.lastDoc = doc;
	$el("llm").hidden = true;

	let compiled;
	try {
		compiled = await circuit.compile(doc);
	} catch (err) {
		message($el("plan"), "error", `Compile failed: ${err.message}`);
		return;
	}
	state.current = compiled;

	$el("doc").value = JSON.stringify(doc, null, 2);
	$el("json-state").textContent = compiled.ok ? "· built" : "· has errors";
	$el("json-state").style.color = compiled.ok ? "var(--b-ok)" : "var(--b-err)";

	renderHead(compiled);
	renderSteps(compiled);
	renderDiagnostics(compiled);

	const plan = $el("plan");
	try {
		await circuitView.render(plan, compiled);
	} catch (err) {
		message(plan, "error", `Drawing failed: ${err.message}`);
	}

	showTab(compiled.errors.length ? "diag" : "steps");
}

/* -------------------------------------------------- rendering */

function renderHead(compiled) {
	const head = $el("plan-head");
	head.innerHTML = "";
	const h2 = document.createElement("h2");
	h2.textContent = compiled.title;
	head.appendChild(h2);
	if (compiled.notes) {
		const p = document.createElement("p");
		p.textContent = compiled.notes;
		head.appendChild(p);
	}

	const stats = document.createElement("div");
	stats.className = "b-stats";
	const add = (label, value) => {
		const s = document.createElement("span");
		s.className = "b-stat";
		s.innerHTML = `${label} <b>${value}</b>`;
		stats.appendChild(s);
	};
	add("chips", compiled.stats.nodes);
	add("wires", compiled.stats.links);
	if (compiled.stats.autoLinks) add("guessed", compiled.stats.autoLinks);
	if (compiled.errors.length) add("errors", compiled.errors.length);
	if (compiled.warnings.length) add("notes", compiled.warnings.length);
	head.appendChild(stats);
}

function renderSteps(compiled) {
	const panel = $el("steps");
	panel.innerHTML = "";

	const { rows, chips, values } = circuitView.steps(compiled);

	panel.appendChild(title(`Place ${chips.length === 1 ? "this chip" : "these chips"}`));
	const chipList = document.createElement("div");
	chipList.className = "b-chip-list";
	for (const [name, count] of chips) {
		const entry = circuit.chip(name);
		const item = document.createElement("span");
		item.className = "b-chip-item";
		item.innerHTML = count > 1 ? `<b>${count}×</b> ${escapeHtml(name)}` : escapeHtml(name);
		if (entry?.kind === "object") item.title = "Object board — place it in the room, not on a circuit board.";
		else if (entry?.kind === "chip") item.title = "Chip — place it on a circuit board.";
		chipList.appendChild(item);
	}
	panel.appendChild(chipList);

	panel.appendChild(title(`Wire ${rows.length} connection${rows.length === 1 ? "" : "s"} · out → in`));
	const list = document.createElement("ol");
	list.className = "b-wire-list";
	rows.forEach((row, i) => {
		const li = document.createElement("li");
		li.className = "b-wire" + (row.auto ? " auto" : "");
		li.innerHTML = `
			<span class="b-wire-num">${i + 1}</span>
			<span class="b-wire-body">
				<span class="from">${escapeHtml(row.from)}</span>
				<span class="type">${escapeHtml(row.fromPort)}</span>
				<span class="arrow">→</span>
				<span class="to">${escapeHtml(row.to)}</span>
				<span class="type">${escapeHtml(row.toPort)}</span>
				${row.auto ? '<span class="auto-tag">guessed</span>' : ""}
			</span>`;
		list.appendChild(li);
	});
	panel.appendChild(list);

	if (values.length) {
		panel.appendChild(title("Type these values in"));
		const vlist = document.createElement("ul");
		vlist.className = "b-value-list";
		for (const v of values) {
			const li = document.createElement("li");
			li.className = "b-wire";
			li.innerHTML = `<span class="b-wire-num">·</span><span class="b-wire-body"><span class="from">${escapeHtml(v.node)}</span><span class="type">${escapeHtml(v.port)}</span><span class="arrow">=</span><span class="to">${escapeHtml(v.value)}</span></span>`;
			vlist.appendChild(li);
		}
		panel.appendChild(vlist);
	}

	if (!rows.length) {
		message(panel, "warn", "Nothing is wired yet.", "Add links, or set `auto: true` in the document.");
	}
}

function renderDiagnostics(compiled) {
	const panel = $el("diag");
	panel.innerHTML = "";
	$el("diag-count").textContent = compiled.errors.length ? `(${compiled.errors.length})` : "";

	if (!compiled.errors.length && !compiled.warnings.length) {
		message(panel, "ok", "This plan is wireable as drawn.", "Every port exists, every wire joins matching types, and each exec output drives one chip.");
		return;
	}
	for (const e of compiled.errors) message(panel, "error", e.message, e.hint);
	for (const w of compiled.warnings) message(panel, "warn", w.message, "");
}

function showTab(name) {
	document.querySelectorAll(".b-tab").forEach((t) => t.classList.toggle("is-active", t.dataset.tab === name));
	$el("steps").hidden = name !== "steps";
	$el("diag").hidden = name !== "diag";
}

function message(container, kind, text, hint) {
	const p = document.createElement("p");
	p.className = `b-msg ${kind}`;
	p.innerHTML = markCode(text) + (hint ? `<span class="hint">${markCode(hint)}</span>` : "");
	container.appendChild(p);
	return p;
}

function title(text) {
	const h = document.createElement("p");
	h.className = "b-section-title";
	h.textContent = text;
	return h;
}

/* -------------------------------------------------- LLM handoff */

function buildLlmPrompt(request) {
	const candidates = circuit.search(request, { limit: 14 });
	const lines = candidates.map((c) => {
		const ports = [
			...circuit.portsOf(c, "in").map((p) => `in ${p.section}.${p.name || "_"}:${p.type}`),
			...circuit.portsOf(c, "out").map((p) => `out ${p.section}.${p.name || "_"}:${p.type}`),
		];
		return `- ${c.label}${c.kind === "object" ? " (object board)" : ""} [${c.cat[0] || ""}]: ${ports.join(" | ")}`;
	});

	return `You are writing a Rec Room Circuits V2 wiring plan. Answer with ONE JSON object and nothing else.

REQUEST: ${request}

DOCUMENT FORMAT
{"v":1,"title":"short name","notes":"one or two sentences explaining the build",
 "nodes":[{"id":"a","chip":"Delay","label":"Wait 3s","values":{"Delay (s)":"3"}}],
 "links":[["a.After Delay","b._"]]}

RULES
1. "chip" must be an exact chip or object-board name from this index: https://pckydev.github.io/Rec-Room-Circuits-API/api/circuits/chips.index.json
2. A link is [ "nodeId.output", "nodeId.input" ]. Output first, always.
3. Refer to a port by its name ("Sum"), by its section ("Player Entered"), by section.port ("Set Locked.Locked"), by position ("out2"), or as "_" for the unnamed exec port.
4. Exec outputs drive exactly one exec input. A data input takes exactly one wire. If you need two paths from one exec output, add a Sequence chip.
5. Exec ports only connect to exec ports. Data ports must share a type; generic "T" accepts anything.
6. Put every literal a maker must type into an unconnected input in that node's "values", using the port name. For a repeated port name use "Value#2".
7. Object boards (Trigger Volume, Button, Room Door, Point Light, Piston, Text, Interaction Volume…) are placed in the room; chips go on a circuit board.
8. Prefer the smallest circuit that works. Do not invent chips.

LIKELY CHIPS FOR THIS REQUEST
${lines.join("\n") || "- (nothing matched; search the index)"}

Answer with the JSON only.`;
}

async function copyPromptForLlm() {
	const request = $el("prompt").value.trim() || "a circuit that does something useful";
	$el("llm").hidden = false;
	$el("llm-prompt").value = buildLlmPrompt(request);
	await copy($el("llm-prompt").value);
}

async function copy(text) {
	try {
		await navigator.clipboard.writeText(text);
	} catch {
		const ta = document.createElement("textarea");
		ta.value = text;
		document.body.appendChild(ta);
		ta.select();
		document.execCommand("copy");
		ta.remove();
	}
}

function download() {
	if (!state.lastDoc) return;
	const blob = new Blob([JSON.stringify(state.lastDoc, null, 2)], { type: "application/json" });
	const a = document.createElement("a");
	a.href = URL.createObjectURL(blob);
	a.download = `${(state.lastDoc.title || "circuit").toLowerCase().replace(/[^a-z0-9]+/g, "-")}.circuit.json`;
	a.click();
	setTimeout(() => URL.revokeObjectURL(a.href), 2000);
}

/* -------------------------------------------------- helpers */

function escapeHtml(s) {
	return String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
}

/* Backticks in messages mark port or chip names; render those as code. */
function markCode(text) {
	return escapeHtml(text).replace(/`([^`]+)`/g, "<code>$1</code>");
}

init();
