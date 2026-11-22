#!/usr/bin/env node
////////////////////////////////////////////////////////
// File:            server.mjs
// Description:     MCP server for the Circuit Builder.
//                  Speaks JSON-RPC over stdio, so any MCP
//                  client (Freebuff, Claude Desktop, an
//                  IDE agent…) can search the chip index,
//                  compose a circuit from plain language,
//                  validate it, repair it, and get a live
//                  preview URL that draws the wiring plan.
//
// Nothing here touches the game: the server reads the
// shipped chip index, compiles documents with the same
// compiler the Builder page uses, and serves the static
// Builder page on 127.0.0.1 so the returned URL renders.
//
// Run:  node Tools/mcp/server.mjs
//       node Tools/mcp/server.mjs --port 8790
//
// stdout carries protocol messages only; all logging goes
// to stderr, because a stray stdout line breaks the client.
////////////////////////////////////////////////////////

import { createHash } from "node:crypto";
import { createReadStream, statSync } from "node:fs";
import { createServer } from "node:http";
import path from "node:path";
import readline from "node:readline";

import {
	SOURCE_DIR,
	auditComposer,
	build,
	compose,
	formatPlan,
	indexCounts,
	loadIndex,
	repairDocument,
} from "./circuitTools.mjs";
import { circuit } from "../../Source/assets/js/Modules/circuit.mjs";
import { recipes } from "../../Source/assets/js/Modules/recipes.mjs";

const SERVER_INFO = { name: "rec-room-circuits", version: "1.0.0" };
const PROTOCOL_VERSIONS = ["2024-11-05", "2025-03-26", "2025-06-18"];
const DEFAULT_PORT = 8788;

const log = (...args) => process.stderr.write(`[circuits-mcp] ${args.join(" ")}\n`);

/* -------------------------------------------------- static preview server */

const MIME = {
	".html": "text/html; charset=utf-8",
	".htm": "text/html; charset=utf-8",
	".js": "text/javascript; charset=utf-8",
	".mjs": "text/javascript; charset=utf-8",
	".css": "text/css; charset=utf-8",
	".json": "application/json; charset=utf-8",
	".txt": "text/plain; charset=utf-8",
	".md": "text/markdown; charset=utf-8",
	".svg": "image/svg+xml",
	".png": "image/png",
	".jpg": "image/jpeg",
	".jpeg": "image/jpeg",
	".webp": "image/webp",
	".ico": "image/x-icon",
	".woff": "font/woff",
	".woff2": "font/woff2",
	".wasm": "application/wasm",
};

let staticServer = null;

/* Documents built by the tools live in memory and are served at a short path, so
   the preview link stays readable instead of being a page of percent-encoding. */
const previews = new Map();

function storePreview(doc) {
	const json = JSON.stringify(doc);
	const id = createHash("sha1").update(json).digest("hex").slice(0, 12);
	previews.set(id, json);
	if (previews.size > 200) previews.delete(previews.keys().next().value);
	return id;
}

/** `--port 8790`, `--port=8790`, or CIRCUITS_MCP_PORT. */
function cliPort() {
	const argv = process.argv.slice(2);
	const flag = argv.findIndex((a) => a === "--port" || a.startsWith("--port="));
	if (flag !== -1) {
		const value = argv[flag].includes("=") ? argv[flag].split("=")[1] : argv[flag + 1];
		const n = Number(value);
		if (Number.isInteger(n) && n > 0 && n < 65536) return n;
	}
	const env = Number(process.env.CIRCUITS_MCP_PORT);
	return Number.isInteger(env) && env > 0 ? env : DEFAULT_PORT;
}

/** Serve Source/ on loopback so `builder.html?doc=…` links actually work. */
function startStaticServer(port = DEFAULT_PORT, attempts = 12) {
	if (staticServer) return Promise.resolve(staticServer);

	return new Promise((resolve, reject) => {
		const server = createServer((req, res) => {
			let rel;
			try {
				rel = decodeURIComponent(new URL(req.url, "http://127.0.0.1").pathname);
			} catch {
				res.writeHead(400).end("bad request");
				return;
			}
			if (rel.startsWith("/mcp/preview/")) {
				const body = previews.get(path.basename(rel).replace(/\.json$/, ""));
				if (!body) {
					res.writeHead(404, { "content-type": "application/json" }).end('{"error":"unknown or expired preview"}');
					return;
				}
				res.writeHead(200, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" }).end(body);
				return;
			}

			if (rel.endsWith("/")) rel += "index.html";

			const file = path.join(SOURCE_DIR, path.normalize(rel));
			if (!file.startsWith(SOURCE_DIR)) {
				res.writeHead(403).end("forbidden");
				return;
			}

			let stat;
			try {
				stat = statSync(file);
			} catch {
				res.writeHead(404, { "content-type": "text/plain; charset=utf-8" }).end(`not found: ${rel}`);
				return;
			}
			if (stat.isDirectory()) {
				res.writeHead(302, { location: `${rel.replace(/\/?$/, "/")}index.html` }).end();
				return;
			}

			res.writeHead(200, {
				"content-type": MIME[path.extname(file).toLowerCase()] || "application/octet-stream",
				"cache-control": "no-store",
			});
			createReadStream(file).pipe(res);
		});

		server.on("error", (err) => {
			if (err.code === "EADDRINUSE" && attempts > 0) {
				startStaticServer(port + 1, attempts - 1).then(resolve, reject);
				return;
			}
			reject(err);
		});

		server.listen(port, "127.0.0.1", () => {
			staticServer = { server, port };
			log(`preview server: http://127.0.0.1:${port}/builder.html`);
			resolve(staticServer);
		});
	});
}

async function previewUrl(doc) {
	const { port } = await startStaticServer(cliPort());
	const id = storePreview(doc);
	return `http://127.0.0.1:${port}/builder.html?doc=/mcp/preview/${id}.json`;
}

/* -------------------------------------------------- tools */

const chipLine = (c) => {
	const ports = (c.sections || [])
		.map((s) => {
			const ins = (s.in || []).map((p) => p.split(":")[0]).join(", ");
			const outs = (s.out || []).map((p) => p.split(":")[0]).join(", ");
			return `${s.name ? s.name + " — " : ""}in [${ins}] out [${outs}]`;
		})
		.join(" | ");
	const flags = c.flags?.length ? ` flags=${c.flags.join(",")}` : "";
	return `${c.label} (${c.kind})${flags}${c.cat?.length ? ` · ${c.cat.join(" / ")}` : ""}\n    ${c.desc || "no description"}\n    ${ports}`;
};

const TOOLS = [
	{
		name: "search_chips",
		description:
			"Search the Rec Room CV2 chip index (1328 chips + 46 object boards) by name, description or category. Use this before naming a chip in a circuit — every chip name must exist in the index.",
		inputSchema: {
			type: "object",
			properties: {
				query: { type: "string", description: "Chip name or what it should do, e.g. \"door\" or \"show notification\"" },
				limit: { type: "number", description: "Max results (default 10)" },
				kind: { type: "string", enum: ["chip", "object"], description: "Only palette chips, or only room object boards" },
			},
			required: ["query"],
		},
		async run(args) {
			loadIndex();
			const limit = Math.max(1, Math.min(50, Number(args.limit) || 10));
			let hits = circuit.search(String(args.query || ""), { limit: limit * 3 });
			if (args.kind) hits = hits.filter((c) => c.kind === args.kind);
			hits = hits.slice(0, limit);
			if (!hits.length) return `No chip matches "${args.query}". Try a plainer word: light, door, sound, text, variable, delay.`;
			return `${hits.length} match(es) for "${args.query}":\n\n${hits.map(chipLine).join("\n\n")}`;
		},
	},
	{
		name: "get_chip",
		description: "Full index entry for one chip or object board: every section, input and output port with its type, plus flags (beta, deprecated…) and provenance.",
		inputSchema: {
			type: "object",
			properties: { name: { type: "string", description: "Exact chip name, e.g. \"Trigger Volume\"" } },
			required: ["name"],
		},
		async run(args) {
			loadIndex();
			const entry = circuit.chip(String(args.name || ""));
			if (!entry) {
				const near = circuit.search(String(args.name || ""), { limit: 5 }).map((c) => c.label);
				return `No chip called "${args.name}".${near.length ? ` Close: ${near.join(", ")}.` : ""}`;
			}
			return JSON.stringify(entry, null, 1);
		},
	},
	{
		name: "list_recipes",
		description: "The eight offline circuit patterns the builder can compose instantly, with the keywords each one matches.",
		inputSchema: { type: "object", properties: {} },
		async run() {
			return recipes.map((r) => `- ${r.id}: ${r.title}\n  keywords: ${r.keywords.join(", ")}\n  ${r.notes}`).join("\n");
		},
	},
	{
		name: "build_circuit",
		description:
			"Build a circuit end to end and return the wiring plan: place these chips, wire these ports in this order, type these values, plus a preview URL that draws it. Pass `prompt` in plain language for the composer (patterns + event/action tables), or pass `circuit` — a document with name-addressed nodes and links — and it is validated and repaired automatically. Returns the exact document that compiled, so you never hand-edit JSON.",
		inputSchema: {
			type: "object",
			properties: {
				prompt: { type: "string", description: 'What the circuit should do, e.g. "open the door when a player walks up and play a ding"' },
				circuit: {
					type: "object",
					description:
						'Circuit document: {title, notes, nodes:[{id, chip, label?, values?}], links:[["node.port","node.port"]], auto?}. Ports are addressed by in-game names: "zone.Player Entered", "lamp.Turn On", "total.out2", "_" for an unnamed exec port.',
				},
				auto: { type: "boolean", description: "Auto-connect exec chains and matching data ports (default true)" },
			},
		},
		async run(args) {
			const result = await build(args);
			if (result.error) {
				const hints = [];
				if (result.candidates?.length) hints.push(`Likely chips: ${result.candidates.join(", ")}`);
				if (result.recipes?.length) hints.push(`Known patterns:\n  ${result.recipes.join("\n  ")}`);
				return { text: [result.error, "", ...hints, "", ...result.parts].join("\n"), isError: true };
			}
			const url = await previewUrl(result.doc);
			const text = formatPlan(result.compiled, { url, repairs: result.repairs, parts: result.parts, doc: result.doc });
			return { text, isError: !result.ok };
		},
	},
	{
		name: "validate_circuit",
		description: "Compile a circuit document and report every error and warning, without building anything or opening a preview. Cheapest way to check a document you wrote.",
		inputSchema: {
			type: "object",
			properties: { circuit: { type: "object", description: "Circuit document (same shape as build_circuit's `circuit`)" } },
			required: ["circuit"],
		},
		async run(args) {
			loadIndex();
			const compiled = await circuit.compile(args.circuit || {});
			const issues = [...compiled.errors.map((e) => ({ ...e, kind: "error" })), ...compiled.warnings.map((w) => ({ ...w, kind: "warning" }))];
			const head = compiled.ok ? `Valid: ${compiled.stats.nodes} chips, ${compiled.stats.links} wires.` : `Invalid: ${compiled.errors.length} error(s).`;
			if (!issues.length) return head;
			return [head, "", ...issues.map((i) => `- ${i.kind} \`${i.code}\`: ${i.message}${i.hint ? ` — ${i.hint}` : ""}`)].join("\n");
		},
	},
	{
		name: "repair_circuit",
		description:
			"Attempt automatic repairs on a rough circuit document: near-miss chip names, wrong node-id case, unresolvable port names guessed from the other end of the wire, backwards links, and links that can never be valid. Returns the fixed document, what changed, and whether it now compiles.",
		inputSchema: {
			type: "object",
			properties: { circuit: { type: "object", description: "Circuit document to repair" } },
			required: ["circuit"],
		},
		async run(args) {
			const { doc, repairs } = repairDocument(args.circuit || {});
			const compiled = await circuit.compile(doc);
			const lines = [
				compiled.ok ? "Repaired and valid." : "Repaired, still invalid — see diagnostics.",
				"",
				repairs.length ? "## Changes" : "## Changes",
				...(repairs.length ? repairs.map((r) => `- ${r}`) : ["- nothing needed fixing"]),
				"",
				"## Diagnostics",
				...[
					...compiled.errors.map((e) => `- error \`${e.code}\`: ${e.message}`),
					...compiled.warnings.map((w) => `- warning \`${w.code}\`: ${w.message}`),
				].slice(0, 40) || [],
				"",
				"## Document",
				"```json",
				JSON.stringify(doc, null, 1),
				"```",
			];
			return { text: lines.join("\n"), isError: false };
		},
	},
	{
		name: "preview_circuit",
		description: "Return just the preview URL for a circuit (built from a prompt or a document) plus a one-line summary, for dropping straight into a browser panel.",
		inputSchema: {
			type: "object",
			properties: {
				prompt: { type: "string" },
				circuit: { type: "object" },
			},
		},
		async run(args) {
			const result = await build(args);
			if (result.error) return { text: result.error, isError: true };
			const url = await previewUrl(result.doc);
			return `${url}\n\n${result.compiled.ok ? "valid" : "has errors"} · ${result.compiled.stats.nodes} chips · ${result.compiled.stats.links} wires · ${result.doc.title}`;
		},
	},
];

const TOOL_INDEX = new Map(TOOLS.map((t) => [t.name, t]));

/* -------------------------------------------------- JSON-RPC over stdio */

function send(message) {
	process.stdout.write(`${JSON.stringify(message)}\n`);
}

function reply(id, result) {
	send({ jsonrpc: "2.0", id, result });
}

function fail(id, code, message) {
	send({ jsonrpc: "2.0", id, error: { code, message } });
}

async function handleCall(id, params) {
	const tool = TOOL_INDEX.get(params?.name);
	if (!tool) {
		fail(id, -32602, `Unknown tool: ${params?.name}`);
		return;
	}
	try {
		const out = await tool.run(params?.arguments || {});
		const text = typeof out === "string" ? out : out.text;
		reply(id, { content: [{ type: "text", text: String(text ?? "") }], isError: typeof out === "object" && !!out.isError });
	} catch (err) {
		log(`tool ${params.name} failed: ${err?.stack || err}`);
		reply(id, { content: [{ type: "text", text: `Tool failed: ${err?.message || err}` }], isError: true });
	}
}

async function handle(message) {
	const { id, method, params } = message;

	if (method === "initialize") {
		const wanted = params?.protocolVersion;
		const audit = auditComposer();
		if (audit.broken.length) log(`composer table out of date: ${audit.broken.map((b) => `${b.chip}.${b.port} (${b.reason})`).join("; ")}`);
		const counts = indexCounts();
		reply(id, {
			protocolVersion: PROTOCOL_VERSIONS.includes(wanted) ? wanted : "2025-06-18",
			capabilities: { tools: { listChanged: false } },
			serverInfo: SERVER_INFO,
			instructions: [
				"Rec Room CV2 Circuit Builder. Workflow: search_chips to find real chip names, build_circuit with a plain-language prompt (quick patterns) or with a circuit document (full control), then show the returned preview URL.",
				`Index: ${counts.chips} chips + ${counts.objects} object boards (${counts.documented || 0} from the community docs).`,
				"Ports are addressed by in-game names: \"zone.Player Entered\", \"lamp.Turn On\", \"total.out2\", \"_\" for an unnamed exec port. Output is a wiring plan to rebuild by hand — nothing is imported into the game.",
			].join("\n"),
		});
		return;
	}

	if (method === "notifications/initialized" || method === "notifications/cancelled") return;

	if (method === "ping") {
		reply(id, {});
		return;
	}

	if (method === "tools/list") {
		reply(id, {
			tools: TOOLS.map((t) => ({ name: t.name, description: t.description, inputSchema: t.inputSchema })),
		});
		return;
	}

	if (method === "tools/call") {
		if (id === undefined) return;
		await handleCall(id, params);
		return;
	}

	if (method === "resources/list") {
		reply(id, { resources: [] });
		return;
	}

	if (method === "prompts/list") {
		reply(id, { prompts: [] });
		return;
	}

	if (method === "resources/templates/list") {
		reply(id, { resourceTemplates: [] });
		return;
	}

	if (id !== undefined) fail(id, -32601, `Method not found: ${method}`);
}

function main() {
	loadIndex();
	const counts = indexCounts();
	log(`index loaded: ${counts.total} entries (${counts.chips} chips, ${counts.objects} boards, ${counts.documented || 0} documented-only)`);

	const rl = readline.createInterface({ input: process.stdin, terminal: false });
	rl.on("line", (line) => {
		const trimmed = line.trim();
		if (!trimmed) return;
		let message;
		try {
			message = JSON.parse(trimmed);
		} catch {
			log(`ignoring a line that is not JSON (${trimmed.length} chars)`);
			return;
		}
		Promise.resolve(handle(message)).catch((err) => {
			log(`handler failed: ${err?.stack || err}`);
			if (message?.id !== undefined) fail(message.id, -32603, String(err?.message || err));
		});
	});
	rl.on("close", () => {
		log("stdin closed, exiting");
		staticServer?.server.close();
		process.exit(0);
	});
}

main();

/* Importing this file starts the server, which is what a client expects from an
   MCP entry point. The test harness runs it as a child process instead. */
export { compose, TOOLS };
