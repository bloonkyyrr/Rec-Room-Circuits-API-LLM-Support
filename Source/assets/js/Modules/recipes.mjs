////////////////////////////////////////////////////////
// File:            recipes.mjs
// Description:     Offline circuit patterns for the Builder
//                  page. Each recipe is a plain circuit
//                  document, so it goes through exactly the
//                  same compiler and validator as anything a
//                  model writes — nothing here is special-cased.
//
// Every chip name, board port and type below was taken from
// Circuits Data/CV2_*.json. If the data changes, a recipe
// fails loudly in the diagnostics panel instead of silently
// producing a plan that cannot be wired.
////////////////////////////////////////////////////////

export const recipes = [
	{
		id: "proximity-door",
		title: "Sliding door that opens when you walk up",
		keywords: ["door", "sliding", "gate", "open", "proximity", "approach", "walk", "entrance", "auto"],
		notes:
			"Wire a Trigger Volume across the doorway and parent a Piston to the door panel. Walking in plays the piston, walking out stops it.",
		doc: {
			v: 1,
			title: "Proximity Sliding Door",
			nodes: [
				{ id: "zone", chip: "Trigger Volume", label: "Doorway zone" },
				{ id: "gate", chip: "Piston", label: "Door panel" },
			],
			links: [["zone.Player Entered", "gate.Play"], ["zone.Player Exited", "gate.Stop"]],
		},
	},
	{
		id: "button-light",
		title: "Light that is on while a button is held",
		keywords: ["button", "light", "lamp", "hold", "press", "on", "off", "switch"],
		notes: "A Button board drives a Point Light directly — pressed turns it on, released turns it off.",
		doc: {
			v: 1,
			title: "Hold Button To Light",
			nodes: [
				{ id: "btn", chip: "Button", label: "Wall button" },
				{ id: "lamp", chip: "Point Light", label: "Ceiling light" },
			],
			links: [["btn.Pressed", "lamp.Turn On"], ["btn.Released", "lamp.Turn Off"]],
		},
	},
	{
		id: "toggle-light",
		title: "Toggle button that latches a light on and off",
		keywords: ["toggle", "latch", "switch", "light", "stay", "persistent", "flip"],
		notes:
			"Press once and the light stays on: the toggle's Is Pressed bool feeds an If chip, and the branch turns the light on or off.",
		doc: {
			v: 1,
			title: "Latching Toggle Light",
			nodes: [
				{ id: "toggle", chip: "Toggle Button", label: "Lamp switch" },
				{ id: "if", chip: "If", label: "Is it on?" },
				{ id: "lamp", chip: "Point Light", label: "Ceiling light" },
			],
			links: [
				["toggle.Pressed", "if._"],
				["toggle.Is Pressed", "if.Condition"],
				["if.Then", "lamp.Turn On"],
				["if.Else", "lamp.Turn Off"],
			],
		},
	},
	{
		id: "timed-door",
		title: "Press a button, door opens for a few seconds",
		keywords: ["timed", "timer", "seconds", "delay", "temporarily", "briefly", "auto close", "close"],
		notes:
			"Delay gives you two exec outputs on one chip: Run fires immediately, After Delay fires later. Use them to play and stop the same piston.",
		doc: {
			v: 1,
			title: "Timed Piston Door",
			nodes: [
				{ id: "btn", chip: "Button", label: "Door button" },
				{ id: "wait", chip: "Delay", label: "Hold open", values: { "Delay (s)": "3" } },
				{ id: "gate", chip: "Piston", label: "Door panel" },
			],
			links: [
				["btn.Pressed", "wait.Run"],
				["wait.Run", "gate.Play"],
				["wait.After Delay", "gate.Stop"],
			],
		},
	},
	{
		id: "teleport-pad",
		title: "Hold a pad to teleport the player somewhere",
		keywords: ["teleport", "pad", "warp", "move player", "portal", "jump", "lift"],
		notes:
			"Set Position takes the player from the Interaction Volume and a typed Vector3. Change the Position value to wherever you want them to land.",
		doc: {
			v: 1,
			title: "Teleport Pad",
			nodes: [
				{ id: "pad", chip: "Interaction Volume", label: "Teleport pad" },
				{ id: "move", chip: "Set Position", label: "Send player", values: { Position: "0, 10, 0" } },
			],
			links: [["pad.On Use or Hold Completed", "move._"], ["pad.Player who used", "move.Target"]],
		},
	},
	{
		id: "welcome-text",
		title: "Show a welcome message to players who enter",
		keywords: ["welcome", "message", "text", "greet", "sign", "hint", "instructions", "notice"],
		notes: "A Text board is enough: the trigger volume sets its text when a player steps in.",
		doc: {
			v: 1,
			title: "Welcome Sign",
			nodes: [
				{ id: "zone", chip: "Trigger Volume", label: "Entry zone" },
				{ id: "sign", chip: "Text", label: "Welcome board", values: { Text: "Welcome to the room!" } },
			],
			links: [["zone.Player Entered", "sign.Set Text"]],
		},
	},
	{
		id: "lock-until-button",
		title: "Door stays locked until a button unlocks it",
		keywords: ["locked", "unlock", "key", "access", "secret", "permission", "locked door"],
		notes:
			'"Set Locked" is one exec input on the Room Door chip, so a single event has to drive it. Here the button does the unlocking and the door reports "Door Used" for anything you want to happen next.',
		doc: {
			v: 1,
			title: "Button Unlocked Door",
			nodes: [
				{ id: "btn", chip: "Button", label: "Unlock button" },
				{ id: "door", chip: "Room Door", label: "Exit door", values: { Locked: "False" } },
			],
			links: [["btn.Pressed", "door.Set Locked"]],
		},
	},
	{
		id: "player-counter",
		title: "Count how many times players walk through",
		keywords: ["count", "counter", "how many", "visits", "tally", "score", "increment"],
		notes:
			"An int Variable keeps the total. Add needs two inputs: wire the variable's value output into the first and type 1 into the second Value port. The Sequence splits one event into the counter and the notification.",
		doc: {
			v: 1,
			title: "Visit Counter",
			nodes: [
				{ id: "zone", chip: "Trigger Volume", label: "Counting zone" },
				{ id: "seq", chip: "Sequence", label: "Split the event" },
				{ id: "total", chip: "int Variable", label: "Visits" },
				{ id: "plus", chip: "Add", label: "Add one", values: { "Value#2": "1" } },
				{ id: "msg", chip: "Show Notification", label: "Tell the room", values: { Value: "You walked through!" } },
			],
			links: [
				["zone.Player Entered", "seq._"],
				["seq.1", "total._"],
				["total.out2", "plus.Value"],
				["plus.Sum", "total.in2"],
				["seq.2", "msg._"],
				["zone.Player Entered.Player", "msg.Player"],
			],
		},
	},
];

/* Cheap intent match over the recipe keywords. Returns null when nothing is
   close enough, so the page can hand the request to a model instead of
   inventing a circuit that does not answer it. */
export function matchRecipe(prompt) {
	const text = String(prompt || "").toLowerCase();
	if (!text.trim()) return null;

	let best = null;
	for (const recipe of recipes) {
		let score = 0;
		for (const kw of recipe.keywords) {
			if (text.includes(kw)) score += kw.includes(" ") ? 3 : 2;
		}
		if (text.includes(recipe.title.toLowerCase())) score += 6;
		if (score > 0 && (!best || score > best.score)) best = { recipe, score };
	}
	return best && best.score >= 2 ? best.recipe : null;
}
