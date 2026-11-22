# Graph Report - Rec-Room-Circuits-API-LLM-Support  (2026-11-22)

## Corpus Check
- 28 files · ~195,287 words
- Verdict: corpus is large enough that graph structure adds value.
- Unclassified: 50 file(s) not represented in the graph (top: .css 25, .woff2 18, (none) 3)
- WARNING: 50 of 78 files seen (64%) have no supported extractor and are missing from this graph entirely. It may look complete while representing only part of the codebase.

## Summary
- 108 nodes · 159 edges · 10 communities (9 shown, 1 thin omitted)
- Extraction: 91% EXTRACTED · 9% INFERRED · 0% AMBIGUOUS · INFERRED: 15 edges (avg confidence: 0.86)
- Token cost: 0 input · 0 output

## Community Hubs (Navigation)
- Editor Page Modules
- Pages Deploy Trigger
- Circuits API & Module Loading
- Account, Auth & Storage
- Showcase Page & Branding
- Pages Deploy Jobs
- Editor UI & Panels
- Chip Data Queries
- PWA Manifest

## God Nodes (most connected - your core abstractions)
1. `_` - 11 edges
2. `chip.mjs Module` - 9 edges
3. `Graph Editor Page` - 8 edges
4. `chip` - 6 edges
5. `graph` - 6 edges
6. `Circuits API Showcase Page` - 6 edges
7. `steps` - 5 edges
8. `store` - 5 edges
9. `palette` - 5 edges
10. `Chip HTML/CSS Layout Contract` - 5 edges

## Surprising Connections (you probably didn't know these)
- `importExternal() Blob-URL Loader` --semantically_similar_to--> `importExternal()`  [INFERRED] [semantically similar]
  README.md → Source/assets/js/Pages/api/examples/loadExternal.js
- `chip.render()` --references--> `chip`  [INFERRED]
  README.md → Source/assets/js/Modules/chip.mjs
- `chip.get(chipName)` --references--> `getInfo()`  [INFERRED]
  README.md → Source/assets/js/Modules/chip.mjs
- `chip.getAll()` --references--> `combineJSON()`  [INFERRED]
  README.md → Source/assets/js/Modules/chip.mjs
- `chip.getAll()` --references--> `getJSON()`  [INFERRED]
  README.md → Source/assets/js/Modules/chip.mjs

## Import Cycles
- None detected.

## Hyperedges (group relationships)
- **Chip Render Pipeline** — readme_render_method, source_index_html_chip_css_classes, branding_icon_icon_1k_transparent_chip_glyph, source_assets_js_modules_chip_chip [INFERRED 0.85]
- **Rec Room Account and Invention Publishing** — source_editor_html_account_window, source_editor_html_recroom_login_flow, source_editor_html_invention_modal, source_editor_html_context_menu [EXTRACTED 1.00]
- **Chip Metadata and Palette** — source_editor_html_palette_window, source_editor_html_palette_info_modal, source_editor_html_chip_badges, source_index_html_chip_showcase_carousel [INFERRED 0.75]

## Communities (10 total, 1 thin omitted)

### Community 0 - "Editor Page Modules"
Cohesion: 0.27
Nodes (7): chip, ui, contextMenu, store, graph, inventions, leftNav

### Community 1 - "Pages Deploy Trigger"
Cohesion: 0.15
Nodes (12): concurrency, cancel-in-progress, group, name, on, push, workflow_dispatch, permissions (+4 more)

### Community 2 - "Circuits API & Module Loading"
Cohesion: 0.18
Nodes (11): chip.mjs Module, Circuits API, Non-Affiliation Disclaimer, chip.get(chipName), GitHub-Hosted Circuit Data, importExternal() Blob-URL Loader, jQuery DOM Dependency, chip.render() (+3 more)

### Community 3 - "Account, Auth & Storage"
Cohesion: 0.19
Nodes (8): localStorage, api, auth, elements, account, data, Account Window, Rec Room Bio Verification Login

### Community 4 - "Showcase Page & Branding"
Cohesion: 0.24
Nodes (12): OpenGraph Social Banner, Chip Glyph Icon, List Type Icon, OpenGraph Social Banner (site copy), Chip Glyph Icon (site copy), List Type Icon (site copy), Chip HTML/CSS Layout Contract, Chip Showcase Carousel (+4 more)

### Community 5 - "Pages Deploy Jobs"
Cohesion: 0.17
Nodes (12): environment, runs-on, steps, name, url, jobs, deploy, id (+4 more)

### Community 6 - "Editor UI & Panels"
Cohesion: 0.20
Nodes (10): palette, Chip Availability Badges, Graph Context Menu, Drag Selection Box, Graph Editor Page, Create Invention Modal, Palette Info Modal, Chip Palette Window (+2 more)

### Community 7 - "Chip Data Queries"
Cohesion: 0.33
Nodes (8): combineResults Option, chip.getAll(), chip.search(query), _, combineJSON(), getJSON(), initPortsHover(), search()

### Community 8 - "PWA Manifest"
Cohesion: 0.25
Nodes (7): background_color, display, icons, name, short_name, start_url, theme_color

## Knowledge Gaps
- **7 isolated node(s):** `jQuery DOM Dependency`, `Non-Affiliation Disclaimer`, `Chip Availability Badges`, `schema.org WebSite JSON-LD`, `OpenGraph Social Banner (site copy)` (+2 more)
  These have ≤1 connection - possible missing edges or undocumented components. (Counts symbols only; 39 node(s) total have ≤1 connection when file, concept and rationale nodes are included.)
- **1 thin communities (<3 nodes) omitted from report** — run `graphify query` to explore isolated nodes.

## Suggested Questions
_Questions this graph is uniquely positioned to answer:_

- **Why does `chip` connect `Editor Page Modules` to `Circuits API & Module Loading`, `Chip Data Queries`?**
  _High betweenness centrality (0.152) - this node is a cross-community bridge._
- **What connects `jQuery DOM Dependency`, `Non-Affiliation Disclaimer`, `Chip Availability Badges` to the rest of the system?**
  _7 weakly-connected nodes found - possible documentation gaps or missing edges._
- **Why does `chip.mjs Module` connect `Circuits API & Module Loading` to `Editor Page Modules`, `Chip Data Queries`?**
  _High betweenness centrality (0.123) - this node is a cross-community bridge._
- **Why does `chip.render()` connect `Circuits API & Module Loading` to `Editor Page Modules`, `Showcase Page & Branding`?**
  _High betweenness centrality (0.106) - this node is a cross-community bridge._