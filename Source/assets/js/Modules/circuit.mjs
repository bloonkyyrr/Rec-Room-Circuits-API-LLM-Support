////////////////////////////////////////////////////////
// File:            circuit.mjs
// Description:     LLM-facing circuit compiler. Turns a
//                  compact, name-addressed circuit document
//                  into laid-out chips with typed wires, and
//                  feeds circuitView.mjs, which draws the
//                  wiring plan you copy by hand in Rec Room.
//
// The document is deliberately not Rec Room's wire format.
// Ports are addressed by their in-game names so a model (or
// a person) can read and write circuits without knowing
// anything about DOM ids or port indices.
////////////////////////////////////////////////////////

const DEFAULT_INDEX = "api/circuits/chips.index.json";

const norm = (s) =>
	String(s ?? "")
		.toLowerCase()
		.replace(/[_\-]+/g, " ")
		.replace(/[^a-z0-9{}<>,()|]+/g, " ")
		.replace(/\s+/g, " ")
		.trim();

const slug = (s) => String(s ?? "").toLowerCase().replace(/[^a-z0-9]+/g, "");

const splitPort = (p) => {
	const i = String(p).indexOf(":");
	return i < 0 ? { name: String(p), type: "any" } : { name: p.slice(0, i), type: p.slice(i + 1) };
};

const isExec = (type) => String(type || "").toLowerCase() === "exec";

/* Types are compared in a normalised form: "T"/"T0"/"any" are wildcards, list
   types keep their element type, and unions are expanded on demand. */
const canonical = (t) => {
	const s = norm(t).replace(/\s/g, "");
	if (!s) return "any";
	if (s === "t" || s === "any" || s === "t0" || s === "t1") return "any";
	if (s.startsWith("list<")) return "list:" + canonical(s.slice(5, -1));
	return s;
};

const unionMembers = (t) =>
	t.startsWith("(") && t.endsWith(")") ? t.slice(1, -1).split("|").map((x) => canonical(x.trim())) : null;

/* A port's identity inside a node. Comparing by these coordinates (never by
   object identity) is what keeps declared links and guesses in sync. */
const portKey = (port) => `${port.dir}:${port.sectionIndex}:${port.portIndex}`;

export const circuit = {
	index: null,
	indexPath: DEFAULT_INDEX,

	async loadIndex(url = circuit.indexPath) {
		if (circuit.index && url === circuit.indexPath) return circuit.index;
		const res = await fetch(url);
		if (!res.ok) throw new Error(`Could not load chip index: ${url} (${res.status})`);
		circuit.index = await res.json();
		circuit.indexPath = url;
		return circuit.index;
	},

	/* -------------------------------------------------- lookup */

	chip(name) {
		const chips = circuit.index?.chips || {};
		if (!name) return null;
		const raw = String(name).trim();
		if (chips[raw]) return chips[raw];

		const want = slug(raw);
		for (const key in chips) if (chips[key].id === want) return chips[key];
		for (const key in chips) if (norm(key) === norm(raw)) return chips[key];
		for (const key in chips) if (norm(chips[key].label) === norm(raw)) return chips[key];
		return null;
	},

	search(query, options = {}) {
		const limit = options.limit || 12;
		const chips = circuit.index?.chips || {};
		const q = norm(query);
		if (!q) return [];
		const tokens = q.split(" ");
		const scored = [];

		for (const key in chips) {
			const c = chips[key];
			const label = norm(c.label);
			const id = slug(c.label);
			const cats = norm((c.cat || []).join(" "));
			const desc = norm(c.desc);
			let score = 0;

			if (label === q || id === q) score += 1000;
			if (label.startsWith(q)) score += 400;
			if (cats.includes(q)) score += 120;
			if (tokens.every((t) => label.includes(t))) score += 200;
			if (tokens.every((t) => desc.includes(t) || cats.includes(t))) score += 60;
			if (tokens.some((t) => label.includes(t))) score += 40;
			if (tokens.some((t) => desc.includes(t))) score += 12;
			if (c.flags?.includes("hidden")) score -= 25;
			if (c.flags?.includes("deprecated")) score -= 60;

			if (score > 0) scored.push({ chip: c, score });
		}

		scored.sort((a, b) => b.score - a.score || a.chip.label.localeCompare(b.chip.label));
		return scored.slice(0, limit).map((s) => s.chip);
	},

	/* chip.render() expects the exporter's object shape; the index is a trimmed
	   copy of it, so rebuild the fields it reads. */
	toChipObject(entry) {
		if (!entry) return null;
		return {
			chipName: entry.label,
			paletteName: entry.label,
			description: entry.desc,
			isObjectBoard: entry.kind === "object",
			isBetaChip: entry.flags?.includes("beta") || false,
			isDevChip: entry.flags?.includes("dev") || false,
			isStudioChip: entry.flags?.includes("studio") || false,
			isTrollingRisk: entry.flags?.includes("troll") || false,
			isRoleAssignmentRisk: entry.flags?.includes("role") || false,
			isValidInRoom1: entry.flags?.includes("r1") || false,
			isValidInRoom2: entry.flags?.includes("r2") || false,
			nodeDescs: (entry.sections || []).map((s) => ({
				name: s.name,
				typeParams: (s.tp || []).map((t) => {
					const i = t.indexOf(":");
					return i < 0 ? { name: t, type: "any" } : { name: t.slice(0, i).trim(), type: t.slice(i + 1).trim() };
				}),
				inputs: (s.in || []).map(splitPort).map((p) => ({ ...p, description: "" })),
				outputs: (s.out || []).map(splitPort).map((p) => ({ ...p, description: "" })),
			})),
		};
	},

	/* -------------------------------------------------- ports */

	portsOf(entry, dir) {
		const out = [];
		(entry.sections || []).forEach((sec, sectionIndex) => {
			(sec[dir] || []).forEach((raw, portIndex) => {
				const p = splitPort(raw);
				out.push({
					sectionIndex,
					section: sec.name,
					portIndex,
					dir,
					name: p.name,
					type: p.type,
					exec: isExec(p.type),
				});
			});
		});
		return out;
	},

	describePort(port) {
		return `${port.section}${port.name && port.name !== "_" ? "." + port.name : ""}:${port.type}`;
	},

	/* Resolve one port reference against one direction of one node. */
	resolvePort(entry, ref, dir) {
		const ports = circuit.portsOf(entry, dir);
		if (!ports.length) return { error: `\`${entry.label}\` has no ${dir === "out" ? "outputs" : "inputs"}.` };

		const raw = String(ref ?? "").trim();
		const list = () => ports.map((p) => circuit.describePort(p)).join("; ");

		if (!raw || raw === "*" || norm(raw) === "any") {
			return { port: ports.find((p) => p.exec) || ports[0], how: "auto" };
		}

		/* `_` is how the data dumps name an unnamed port, and a variable chip has
		   two of them. Used bare, it always means the exec one. */
		if (raw === "_") {
			return { port: ports.find((p) => p.exec) || ports[0], how: "unnamed" };
		}

		const idx = raw.match(/^(?:in|out)?\s*#?(\d+)$/i);
		if (idx) {
			const p = ports[Number(idx[1]) - 1];
			return p ? { port: p, how: "index" } : { error: `#${idx[1]} is out of range. Ports: ${list()}` };
		}

		const exec = raw.match(/^exec\s*#?(\d+)?$/i);
		if (exec) {
			const execs = ports.filter((p) => p.exec);
			const p = execs[(exec[1] ? Number(exec[1]) : 1) - 1];
			return p ? { port: p, how: "exec" } : { error: `No exec #${exec[1] || 1}. Ports: ${list()}` };
		}

		/* Section-qualified: "Set Locked.Locked", "Player Entered/Player". Split on
		   the separator character, NOT on spaces — section names contain spaces.
		   Exact matches first: a substring match here would make every board port
		   ambiguous, because "Pressed" is inside "Is Pressed". */
		const qualified = raw.match(/^\s*(.+?)\s*[./>]\s*(\S(?:.*\S)?)\s*$/);
		if (qualified) {
			const wantSection = norm(qualified[1]);
			const wantName = norm(qualified[2]);
			const exact = ports.filter((p) => norm(p.section) === wantSection && norm(p.name) === wantName);
			if (exact.length === 1) return { port: exact[0], how: "section-port" };
			if (exact.length > 1) return { error: `\`${raw}\` is ambiguous. Ports: ${list()}` };

			const loose = ports.filter((p) => norm(p.section).includes(wantSection) && norm(p.name).includes(wantName));
			if (loose.length === 1) return { port: loose[0], how: "section-port" };
			if (loose.length > 1) return { error: `\`${raw}\` is ambiguous. Ports: ${list()}` };
		}

		/* A section name on its own means that section's exec port — this is how
		   object-board events are usually referenced ("Player Entered"). */
		const bySection = ports.filter((p) => norm(p.section) === norm(raw));
		if (bySection.length) return { port: bySection.find((p) => p.exec) || bySection[0], how: "section" };

		const byName = ports.filter((p) => norm(p.name) === norm(raw));
		if (byName.length === 1) return { port: byName[0], how: "name" };
		if (byName.length > 1) {
			return { error: `\`${raw}\` matches ${byName.length} ports. Qualify it, e.g. \`${byName[0].section}.${byName[0].name}\`.` };
		}

		const loose = ports.filter((p) => norm(p.name).includes(norm(raw)) || norm(p.section).includes(norm(raw)));
		if (loose.length === 1) return { port: loose[0], how: "fuzzy" };
		if (loose.length > 1) return { error: `\`${raw}\` is ambiguous (${loose.map((p) => circuit.describePort(p)).join(", ")}).` };

		return { error: `\`${entry.label}\` has no ${dir === "out" ? "output" : "input"} named \`${raw}\`. Available: ${list()}` };
	},

	typesCompatible(aType, bType) {
		if (isExec(aType) !== isExec(bType)) return false;
		const a = canonical(aType);
		const b = canonical(bType);
		if (a === "any" || b === "any") return true;
		if (a === b) return true;

		/* List<T> is generic in T just like a bare T, so list<t> accepts any list. */
		const la = a.startsWith("list:") ? a.slice(5) : null;
		const lb = b.startsWith("list:") ? b.slice(5) : null;
		if (la !== null && lb !== null) return circuit.typesCompatible(la, lb);
		if ((la !== null) !== (lb !== null)) return false;

		const ua = unionMembers(a);
		const ub = unionMembers(b);
		if (ua && (ua.includes(b) || ua.includes("any"))) return true;
		if (ub && (ub.includes(a) || ub.includes("any"))) return true;
		if (ua && ub && ua.some((m) => ub.includes(m))) return true;
		return false;
	},

	/* -------------------------------------------------- compile */

	async compile(doc) {
		const errors = [];
		const warnings = [];
		const nodes = [];
		const links = [];
		const byKey = new Map();

		if (!circuit.index) throw new Error("Chip index not loaded.");

		const rawNodes = Array.isArray(doc?.nodes) ? doc.nodes : [];
		if (!rawNodes.length) {
			errors.push({ code: "no-nodes", message: "The document has no `nodes`." });
			return { ok: false, title: doc?.title || "Untitled", notes: "", nodes, links, errors, warnings, stats: { nodes: 0, links: 0, autoLinks: 0 } };
		}

		rawNodes.forEach((n, i) => {
			const wanted = typeof n === "string" ? n : n?.chip;
			const entry = circuit.chip(wanted);
			if (!entry) {
				const guess = circuit.search(wanted, { limit: 3 }).map((c) => c.label);
				errors.push({
					code: "unknown-chip",
					message: `Node ${i + 1}: no chip or object board named \`${wanted}\`.`,
					hint: guess.length ? `Did you mean: ${guess.join(", ")}?` : "Search the palette index for the right name.",
				});
				return;
			}
			const key = String((typeof n === "object" && n?.id) || `n${i + 1}`);
			if (byKey.has(key)) {
				errors.push({ code: "duplicate-id", message: `Two nodes share the id \`${key}\`.` });
				return;
			}
			const node = {
				key,
				entry,
				label: (typeof n === "object" && n?.label) || entry.label,
				values: (typeof n === "object" && n?.values) || null,
				fixed: typeof n === "object" && Array.isArray(n?.at) ? { x: Number(n.at[0]) || 0, y: Number(n.at[1]) || 0 } : null,
				ports: { in: circuit.portsOf(entry, "in"), out: circuit.portsOf(entry, "out") },
				links: [],
			};
			nodes.push(node);
			byKey.set(key, node);
		});

		const ref = (text, dir) => {
			const raw = String(text ?? "");
			const dot = raw.indexOf(".");
			if (dot < 0) return { error: `\`${raw}\` must be written \`nodeId.port\`.` };
			const node = byKey.get(raw.slice(0, dot).trim());
			if (!node) return { error: `No node with id \`${raw.slice(0, dot).trim()}\`.` };
			const res = circuit.resolvePort(node.entry, raw.slice(dot + 1), dir);
			if (res.error) return { error: `${node.key}: ${res.error}` };
			return { node, port: res.port, how: res.how };
		};

		const labelOf = (node, port) => `${node.key}.${circuit.describePort(port)}`;

		/* Accepts either "node.port" text (documents) or an already resolved
		   {node, port} pair (auto-connect, which resolves ports itself and must
		   never round-trip through a string and lose precision). */
		const addLink = (from, to, origin, reason) => {
			const f = typeof from === "string" ? ref(from, "out") : from;
			const t = typeof to === "string" ? ref(to, "in") : to;
			const fText = typeof from === "string" ? from : labelOf(f.node, f.port);
			const tText = typeof to === "string" ? to : labelOf(t.node, t.port);

			if (f.error) {
				errors.push({ code: "bad-from", message: `Link \`${fText}\` → \`${tText}\`: ${f.error}` });
				return false;
			}
			if (t.error) {
				errors.push({ code: "bad-to", message: `Link \`${fText}\` → \`${tText}\`: ${t.error}` });
				return false;
			}
			if (f.node === t.node && f.port.dir === t.port.dir && f.port.sectionIndex === t.port.sectionIndex && f.port.portIndex === t.port.portIndex) {
				errors.push({ code: "self-port", message: `Link \`${fText}\` → \`${tText}\` joins a port to itself.` });
				return false;
			}
			if (!circuit.typesCompatible(f.port.type, t.port.type)) {
				errors.push({
					code: "type-mismatch",
					message: `Cannot wire \`${fText}\` (${f.port.type}) into \`${tText}\` (${t.port.type}).`,
					hint: isExec(f.port.type) !== isExec(t.port.type) ? "Exec and data wires cannot be mixed." : "Rec Room needs an explicit conversion chip for that pair.",
				});
				return false;
			}
			if (links.some((l) => l.from.node === f.node && l.from.key === portKey(f.port) && l.to.node === t.node && l.to.key === portKey(t.port))) {
				return false;
			}

			/* One wire per data input, one per exec output. The later link wins,
			   which is how the editor behaves too. */
			const clashes = links.filter((l) =>
				!t.port.exec ? l.to.node === t.node && l.to.key === portKey(t.port) : f.port.exec && l.from.node === f.node && l.from.key === portKey(f.port),
			);
			for (const clash of clashes) {
				warnings.push({
					code: t.port.exec ? "exec-forked" : "input-overwritten",
					message: t.port.exec
						? `${fText} can only drive one chip, so the wire to ${labelOf(clash.to.node, clash.to.port)} was replaced. Use a Sequence chip to branch.`
						: `${tText} already had a wire from ${labelOf(clash.from.node, clash.from.port)}; the later link replaces it.`,
				});
				links.splice(links.indexOf(clash), 1);
			}

			const link = {
				from: { node: f.node, port: f.port, key: portKey(f.port) },
				to: { node: t.node, port: t.port, key: portKey(t.port) },
				origin,
				reason,
			};
			links.push(link);
			f.node.links.push(link);
			t.node.links.push(link);
			return true;
		};

		(doc.links || []).forEach((l) => {
			if (Array.isArray(l)) addLink(l[0], l[1], "declared");
			else if (l && typeof l === "object") addLink(l.from, l.to, "declared");
		});

		let autoLinks = 0;
		if (doc.auto !== false) autoLinks = circuit.autoConnect(nodes, links, addLink, warnings);

		if (!links.length) {
			warnings.push({
				code: "no-links",
				message: "Nothing is wired. Add `links`, or leave `auto` on so exec chains and matching data ports are joined for you.",
			});
		}

		const isolated = nodes.filter((n) => !n.links.length).map((n) => n.key);
		if (isolated.length) warnings.push({ code: "isolated", message: `Not wired to anything: ${isolated.join(", ")}.` });

		return {
			ok: errors.length === 0,
			title: doc.title || "Untitled circuit",
			notes: doc.notes || "",
			nodes,
			links,
			errors,
			warnings,
			stats: { nodes: nodes.length, links: links.length, autoLinks, execLinks: links.filter((l) => l.from.port.exec).length },
		};
	},

	/* Fill in what the document left implicit:
	   1. exec chain, in declared order;
	   2. data wires where an input and an upstream output share a port name.
	   Anything weaker than that is reported as a suggestion, never wired: a
	   type-only guess produced "Is Pressed → Locked", which is a wrong circuit
	   that still compiles. */
	autoConnect(nodes, existing, addLink, warnings) {
		const connected = (node, port, side) => existing.some((l) => l[side].node === node && l[side].key === portKey(port));
		const literal = (node, port) => {
			if (!node.values) return false;
			const wanted = Object.keys(node.values).map((k) => k.split("#")[0]);
			return wanted.some((k) => norm(k) === norm(port.name || port.section));
		};
		let made = 0;

		/* Chain exec ports only when the document declares no exec wire at all.
		   Filling in "whatever is still free" invented wires on circuits that
		   were already fully wired (Trigger Volume's Object Entered →
		   Piston.Reverse, Piston.Play → Audio Player.Pause). A document that
		   says what fires what is taken at its word. */
		let prev = null;
		if (!existing.some((l) => l.from.port.exec)) {
			for (const node of nodes) {
				const execIn = node.ports.in.filter((p) => p.exec);
				const execOut = node.ports.out.filter((p) => p.exec);
				if (execIn.length && prev) {
					const source = prev.ports.out.find((p) => p.exec);
					const target = execIn.find((p) => !connected(node, p, "to"));
					if (source && target && !connected(prev, source, "from") && addLink({ node: prev, port: source }, { node, port: target }, "auto", `${prev.key} → ${node.key} exec chain`)) {
						made++;
					}
				}
				if (execOut.length) prev = node;
			}
		}

		nodes.forEach((node, i) => {
			node.ports.in
				.filter((p) => !p.exec && !connected(node, p, "to") && !literal(node, p))
				.forEach((inPort) => {
					const candidates = [];
					for (const src of nodes.slice(0, i)) {
						for (const outPort of src.ports.out) {
							if (outPort.exec || connected(src, outPort, "from")) continue;
							if (!circuit.typesCompatible(outPort.type, inPort.type)) continue;
							candidates.push({ src, outPort, sameName: inPort.name && norm(outPort.name) === norm(inPort.name) });
						}
					}
					if (!candidates.length) return;

					const named = candidates.filter((c) => c.sameName);
					if (named.length === 1) {
						if (addLink({ node: named[0].src, port: named[0].outPort }, { node, port: inPort }, "auto", "matching port name")) made++;
						return;
					}
					if (named.length > 1) {
						warnings.push({
							code: "auto-ambiguous",
							message: `${node.key}.${inPort.name} matches ${named.length} upstream ports (${named.slice(0, 3).map((c) => `${c.src.key}.${c.outPort.name}`).join(", ")}). Name the wire in \`links\`.`,
						});
						return;
					}
					if (candidates.length === 1) {
						warnings.push({
							code: "auto-suggestion",
							message: `${node.key}.${inPort.name || inPort.section} is unconnected. ${candidates[0].src.key}.${candidates[0].outPort.name || candidates[0].outPort.section} has the right type (${inPort.type}) — wire it explicitly if that is what you meant.`,
						});
					}
				});
		});

		return made;
	},
};
