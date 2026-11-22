////////////////////////////////////////////////////////
// File:            circuitView.mjs
// Description:     Draws a compiled circuit plan as a
//                  wiring diagram: real chip markup, real
//                  port colours, bezier wires between the
//                  exact ports — plus the step list you
//                  follow when rebuilding it in Rec Room.
////////////////////////////////////////////////////////

import { chip } from "./chip.mjs";
import { circuit } from "./circuit.mjs";

const norm = (s) =>
	String(s ?? "")
		.toLowerCase()
		.replace(/[_\-]+/g, " ")
		.replace(/[^a-z0-9]+/g, " ")
		.replace(/\s+/g, " ")
		.trim();

const SVG_NS = "http://www.w3.org/2000/svg";

const dirKey = (dir) => (dir === "out" ? "outputs" : "inputs");

/* Same port-id scheme the editor uses: the k-th .port in DOM order is
   "port-k", and each mapped port keeps a reference to it on the nodeDesc. */
function mapPorts(root, nodeDescs) {
	const sections = [...root.querySelectorAll(".section")];
	root.querySelectorAll(".port").forEach((el, index) => {
		el.id = `port-${index}`;
		const sectionEl = el.closest(".section");
		const sectionIndex = sectionEl ? sections.indexOf(sectionEl) : -1;
		const desc = nodeDescs?.[sectionIndex];
		if (!desc) return;
		const isInput = !!el.closest(".input");
		if (!isInput && !el.closest(".output")) return;
		const sibling = [...sectionEl.querySelectorAll(isInput ? ".input .port" : ".output .port")];
		const portIndex = sibling.indexOf(el);
		if (portIndex < 0) return;
		const target = desc[isInput ? "inputs" : "outputs"]?.[portIndex];
		if (target) target.portId = el.id;
	});
}

/* Endpoint -> DOM element. Falls back to matching by name when a chip's
   rendered ports do not line up with the declared ones (Self replaces its
   outputs, several chips append extra inputs). */
function portElement(nodeEl, node, endpoint) {
	const desc = node.chipObject?.nodeDescs?.[endpoint.port.sectionIndex];
	const list = desc?.[dirKey(endpoint.port.dir)];
	let port = list?.[endpoint.port.portIndex];
	const bad = !port?.portId || norm(port.name) !== norm(endpoint.port.name);
	if (bad) {
		const matches = (list || []).filter((p) => norm(p.name) === norm(endpoint.port.name) && p.portId);
		port = matches[0] || port;
	}
	return port?.portId ? nodeEl.querySelector(`.port[id="${port.portId}"]`) : null;
}

function bezier(a, b) {
	const dx = Math.abs(b.x - a.x);
	const c = Math.max(56, dx * 0.45);
	return `M ${a.x} ${a.y} C ${a.x + c} ${a.y}, ${b.x - c} ${b.y}, ${b.x} ${b.y}`;
}

export const circuitView = {
	/* Render into `container` (already in the DOM and given a width). */
	async render(container, compiled) {
		container.innerHTML = "";
		container.classList.add("circuit-canvas");

		const scaler = document.createElement("div");
		scaler.className = "circuit-scaler";
		container.appendChild(scaler);

		const nodesLayer = document.createElement("div");
		nodesLayer.className = "circuit-nodes";
		scaler.appendChild(nodesLayer);

		for (const node of compiled.nodes) {
			const chipObject = node.chipObject || circuit.toChipObject(node.entry);
			const rendered = await chip.render(null, chipObject, { log: false, autoFit: false });
			if (!rendered?.html) continue;
			node.chipObject = rendered.object;

			const holder = document.createElement("div");
			holder.className = "circuit-node";
			holder.dataset.node = node.key;

			const caption = document.createElement("div");
			caption.className = "circuit-node-caption";
			caption.innerHTML = `<span class="circuit-node-key">${escapeHtml(node.key)}</span>${escapeHtml(node.label)}`;
			holder.appendChild(caption);

			const body = document.createElement("div");
			body.className = "circuit-node-body";
			body.innerHTML = rendered.html;
			holder.appendChild(body);

			nodesLayer.appendChild(holder);
			mapPorts(body, node.chipObject.nodeDescs);
			node.element = holder;
			node.el = body.querySelector(".chip");

			if (node.values) applyValues(body, node.values);
		}

		/* Measure at scale 1, then lay out and place. */
		for (const node of compiled.nodes) {
			if (!node.element) continue;
			node.element.style.position = "absolute";
			node.element.style.left = "0px";
			node.element.style.top = "0px";
			const r = node.element.getBoundingClientRect();
			node.w = r.width;
			node.h = r.height;
		}

		/* Hand-placed documents keep their coordinates; anything else is
		   laid out by the compiler. Mixing the two reads badly, so it is all
		   or nothing. */
		const useFixed = compiled.nodes.length > 0 && compiled.nodes.every((n) => n.fixed);
		if (useFixed) compiled.nodes.forEach((n) => (n.at = { ...n.fixed }));
		else this.layout(compiled);

		let minX = Infinity;
		let minY = Infinity;
		let maxX = 0;
		let maxY = 0;
		for (const node of compiled.nodes) {
			if (!node.element) continue;
			node.element.style.left = `${node.at.x}px`;
			node.element.style.top = `${node.at.y}px`;
			minX = Math.min(minX, node.at.x);
			minY = Math.min(minY, node.at.y);
			maxX = Math.max(maxX, node.at.x + node.w);
			maxY = Math.max(maxY, node.at.y + node.h);
		}
		const pad = 40;
		const offsetX = pad - (Number.isFinite(minX) ? minX : 0);
		const offsetY = pad - (Number.isFinite(minY) ? minY : 0);
		for (const node of compiled.nodes) {
			if (!node.element) continue;
			node.at.x += offsetX;
			node.at.y += offsetY;
			node.element.style.left = `${node.at.x}px`;
			node.element.style.top = `${node.at.y}px`;
		}
		const width = maxX - (Number.isFinite(minX) ? minX : 0) + pad * 2;
		const height = maxY - (Number.isFinite(minY) ? minY : 0) + pad * 2;

		/* Wires, drawn in world units inside the scaler. */
		const svg = document.createElementNS(SVG_NS, "svg");
		svg.setAttribute("class", "circuit-wires");
		svg.setAttribute("width", String(width));
		svg.setAttribute("height", String(height));
		nodesLayer.appendChild(svg);

		const scalerRect = scaler.getBoundingClientRect();
		for (const link of compiled.links) {
			const fromEl = link.from.node.element && portElement(link.from.node.el, link.from.node, link.from);
			const toEl = link.to.node.element && portElement(link.to.node.el, link.to.node, link.to);
			if (!fromEl || !toEl) {
				link.unresolved = true;
				continue;
			}
			const a = center(fromEl, scalerRect);
			const b = center(toEl, scalerRect);
			const color =
				getComputedStyle(fromEl).backgroundColor ||
				getComputedStyle(fromEl).borderColor ||
				"#b7c7ff";

			const path = document.createElementNS(SVG_NS, "path");
			path.setAttribute("d", bezier(a, b));
			path.setAttribute("fill", "none");
			path.setAttribute("stroke", color);
			path.setAttribute("stroke-width", "2.5");
			path.setAttribute("stroke-linecap", "round");
			path.setAttribute("opacity", link.origin === "auto" ? "0.55" : "0.95");
			if (link.origin === "auto") path.setAttribute("stroke-dasharray", "7 5");
			svg.appendChild(path);
			link.path = path;

			const label = document.createElementNS(SVG_NS, "text");
			label.setAttribute("x", String((a.x + b.x) / 2));
			label.setAttribute("y", String((a.y + b.y) / 2 - 5));
			label.setAttribute("class", "circuit-wire-label");
			const toName = link.to.port.name && link.to.port.name !== "_" ? link.to.port.name : "";
			label.textContent = toName && norm(toName) !== norm(link.to.port.section) ? toName : link.to.port.type;
			svg.appendChild(label);
		}

		scaler.style.width = `${width}px`;
		scaler.style.height = `${height}px`;
		container.style.height = `${height}px`;

		/* Fit to the available width, never upscale past 1. */
		const available = container.clientWidth || 900;
		const scale = Math.min(1, (available - 8) / width);
		scaler.style.transform = `scale(${scale})`;
		scaler.style.transformOrigin = "0 0";
		container.style.height = `${height * scale}px`;

		return { width, height, scale };
	},

	layout(compiled) {
		const depth = new Map(compiled.nodes.map((n) => [n.key, 0]));
		for (let pass = 0; pass < compiled.nodes.length; pass++) {
			let changed = false;
			for (const l of compiled.links) {
				if (!l.from.port.exec) continue;
				const want = (depth.get(l.from.node.key) || 0) + 1;
				if ((depth.get(l.to.node.key) || 0) < want) {
					depth.set(l.to.node.key, want);
					changed = true;
				}
			}
			if (!changed) break;
		}
		for (const l of compiled.links) {
			if (l.from.port.exec) continue;
			const src = depth.get(l.from.node.key) || 0;
			const dst = depth.get(l.to.node.key) || 0;
			if (src >= dst && dst > 0) depth.set(l.from.node.key, dst - 1);
		}

		const columns = new Map();
		compiled.nodes.forEach((n) => {
			const d = depth.get(n.key) || 0;
			if (!columns.has(d)) columns.set(d, []);
			columns.get(d).push(n);
		});

		const GAP_X = 130;
		const GAP_Y = 44;
		let x = 0;
		[...columns.keys()]
			.sort((a, b) => a - b)
			.forEach((d) => {
				let y = 0;
				let widest = 220;
				for (const n of columns.get(d)) {
					n.at = { x, y };
					widest = Math.max(widest, n.w || 220);
					y += (n.h || 160) + GAP_Y;
				}
				x += widest + GAP_X;
			});
		return compiled;
	},

	/* The list you actually follow with the maker pen open. */
	steps(compiled) {
		const label = (node) => (node.label && node.label !== node.entry.label ? `${node.label} (${node.entry.label})` : node.entry.label);
		/* A port whose name repeats its section (object-board events, most chips)
		   reads better as just the section. */
		const portName = (port) => {
			const name = port.name && port.name !== "_" ? port.name : "";
			if (!name) return port.type;
			if (norm(name) === norm(port.section)) return port.section;
			return `${port.section} · ${name}`;
		};
		const rows = compiled.links.map((l) => ({
			from: label(l.from.node),
			fromPort: portName(l.from.port),
			to: label(l.to.node),
			toPort: portName(l.to.port),
			auto: l.origin === "auto",
			type: l.from.port.type,
		}));

		const chipsUsed = new Map();
		for (const n of compiled.nodes) {
			const key = n.entry.label;
			chipsUsed.set(key, (chipsUsed.get(key) || 0) + 1);
		}

		const values = [];
		for (const n of compiled.nodes) {
			if (!n.values) continue;
			for (const [port, value] of Object.entries(n.values)) values.push({ node: label(n), port, value });
		}

		return { rows, chips: [...chipsUsed.entries()], values };
	},
};

function center(el, originRect) {
	const r = el.getBoundingClientRect();
	return { x: r.left + r.width / 2 - originRect.left, y: r.top + r.height / 2 - originRect.top };
}

function applyValues(root, values) {
	const containers = [...root.querySelectorAll(".port-container")];
	for (const [key, value] of Object.entries(values)) {
		/* "Value#2" targets the second port with that name, which is how a
		   chip with appended inputs (Add, And, String Concat…) gets its
		   literal typed in. */
		const [name, ordinal] = String(key).split("#");
		const matches = containers.filter((c) => norm(c.querySelector(".name")?.textContent) === norm(name));
		const hit = matches[(Number(ordinal) || 1) - 1];
		if (!hit) continue;
		const p = hit.querySelector(".port p");
		if (p) p.textContent = String(value);
		const port = hit.querySelector(".port");
		if (port) port.setAttribute("portValue", String(value));
	}
}

function escapeHtml(s) {
	return String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
}
