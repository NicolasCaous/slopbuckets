---
title: Inspect
description: buckets inspect, a read-only page with the map, the DMZ matrix, symbol traces, projects, approvals, the timeline and impact simulations, and its JSON for agents.
---

# Inspect

`buckets inspect` serves a read-only page with the state of the project and of every project nested in it. It runs the same check as `buckets check`, so every color and message on the page comes from the real rules.

```sh
buckets inspect
```

```text
buckets inspect: 3 projects, 13 buckets, 15 contracts, 4 violations.
The page is read only and updates while files change. Press Ctrl+C to stop. It stops by itself after 30 minutes without an open page.
http://127.0.0.1:53883/
```

Open the link in a browser. The server listens only on `127.0.0.1`, answers only GET requests, and never writes to the project. The check it runs may write its analysis cache in `.buckets/cache/`, as `buckets check` does. Inspect never approves anything, so an agent may run it at any time, and `--no-recursive` leaves out the nested projects.

<figure class="shot">
  <img src="/img/inspect-map.webp" width="1440" height="900" alt="The map view of a project named acme-shop: nested boxes for the buckets root, api, billing, log, store and web, colored green, amber and red, with the project summary and the event feed on the right." fetchpriority="high">
  <figcaption>The map of a project with 4 violations, 7 lock differences and 2 nested projects.</figcaption>
</figure>

## The layout

The top bar lists the views and shows the live state, such as `live, 4 violations`. The line under it is a breadcrumb from the repo project to the current project and bucket. The right column has a panel for the selection (the project summary when nothing is selected) and the event feed. The CRT effect (scanlines, glow and the curved map) starts off. `CRT off` in the top bar turns it on, and the browser remembers the choice.

Every view and every selection lives in the query string, such as `?view=trace&symbol=total`, so a link opens the same view. The page works at 375 pixels wide and without animations when the system asks for reduced motion.

## Views

### Map

Each box is a bucket, nested like the folders, with one frame in the color of its situation: green passes, amber differs from the lock, and red breaks a rule. The box grows with the files in its `_/`. A badge on the frame counts violations (`✗`), orphan contracts (`○`) and lock differences (`~`), and a key at the top right of the map frame repeats these marks. Hovering a box, or moving to it with the arrow keys, shows its files, its contracts in and out, and how many buckets use it and it depends on. The `dmz/` line of a bucket with children is dim unless one of its contracts has a problem. A nested project is a cyan box inside the bucket that holds it. Click it to enter that project.

The map also draws the violations: a cycle as a red path, an orphan chain as a dotted line, and a forbidden import as a dashed line through the wall it crosses. The dependency lines of the selected bucket stay hidden until Show dependencies turns them on. The selected bucket, the buckets it depends on and the buckets that use it always show their names: lit on the box, or as a tag beside a box too small for its name (`●` selected, `→` depends on, `•` used by). Hovering a box shows its full path. With the map focused, the arrow keys move between boxes, show the same path and Enter opens the box. Fullscreen, or `f`, gives the map the whole screen, and Escape brings it back. Under the map, the bucket tree lists the same buckets as links, and the list of violations repeats each message of the check with a Copy button.

#### Large projects

With more than 40 buckets, the map shows one level at a time: the buckets inside the selected one, each as a box with its name and a badge for the problems in everything below it. Click a box to open it, or the outer frame to go up; the breadcrumb and `u` go up too. A cycle or forbidden import whose buckets sit inside a box is drawn between the boxes that hold them, and a note under the map says so, with a link to the level that shows it. Show all switches to a treemap of every bucket, where the area follows the files and names appear where they fit.

The bucket tree becomes the main way around: levels open and close, each row counts the buckets and problems below it, and the form above it finds a bucket by name or keeps only the buckets with problems or waiting for approval. The layout, the filters and the open bucket stay in the URL.

### Matrix

One table per `dmz/` folder. Rows are providers, columns are consumers, and each number counts the symbols of that contract file. `.self` stands for the bucket's own `_/`, `.parent` for the level above and `.external` for other projects. Select a number to open the symbols of that file, with their signatures and re-export chains. A dot marks a cell that cannot be a contract, such as a bucket providing to itself.

A folder with more than 8 children shows only the rows and columns that have a contract. When that is still more than 15, the folder becomes a list of its contracts grouped by provider, with the consumer, the symbol count and the status, and Show as a table switches back. In a large project, a form above the tables finds contracts by path or symbol, or keeps only those with problems or waiting for approval.

<figure class="shot">
  <img src="/img/inspect-matrix.webp" width="1440" height="900" alt="The DMZ matrix view: a table per dmz folder with providers in rows, consumers in columns and symbol counts in the cells." loading="lazy">
  <figcaption>The DMZ matrix, one table per <code>dmz/</code> folder.</figcaption>
</figure>

### Trace

Search a symbol by name, or press `/`. The list shows every DMZ symbol of every project with its origin bucket and how many files carry and import it. Select one to see where it is declared, its signature read from the source, the chain of re-exports from the declaration to each DMZ file, and every `_/` file that imports it, with the line. Symbols that differ from the lock are marked.

<figure class="shot">
  <img src="/img/inspect-trace.webp" width="1440" height="900" alt="The trace view for the symbol total: its origin billing/invoices, its signature, and the chain through two DMZ files to the files that import it." loading="lazy">
  <figcaption>The trace of <code>total</code>, with a signature change waiting for approval.</figcaption>
</figure>

### Bucket panel

Select a bucket on the map, in the tree or in the matrix to open its panel:

- what it offers (DMZ files where it is the provider) and what it consumes
- the buckets it depends on and the buckets that depend on it
- its violations and lock differences
- the links in its `_/links/` folder
- the rewrite cost: how many contract symbols a rewrite from the contracts must keep, in how many contract files, and how many buckets depend on it

### Projects

The constellation draws each project as a box and each link as an arrow from the project that consumes to the project that publishes. A solid line is a link, a dashed line is a copy, amber means drift or a change waiting for approval, and red means the link is missing. Under it, the public surfaces list what each project publishes in its `.external.ts` files and which visible projects consume it. Select a link to see its origin, mode and alias, the symbols the linked project publishes, the code that imports it and, for a drifted copy, the files that differ. A published symbol that differs from the lock is marked as added, removed or changed, as on the review page.

<figure class="shot">
  <img src="/img/inspect-projects.webp" width="1440" height="900" alt="The projects view: the repo project acme-shop with arrows to the nested projects engine and ui-kit, a solid arrow for a link and a dashed amber arrow for a drifted copy." loading="lazy">
  <figcaption>The repo links <code>engine</code> and keeps a copy of <code>ui-kit</code> whose origin changed.</figcaption>
</figure>

### Approvals

Pending lock differences, grouped by project, with the message of each one. The view only shows the state. It says to approve with `buckets refresh --web` and has a button to copy that command. When a project also breaks rules, it says so, because the approval refuses to start until every rule passes.

<figure class="shot">
  <img src="/img/inspect-approvals.webp" width="1440" height="900" alt="The approvals view: lock differences of acme-shop and of the nested project ui-kit, each with its kind, path and message, and a button to copy buckets refresh --web." loading="lazy">
  <figcaption>Pending approvals of two projects. The page shows them and points to <code>buckets refresh --web</code>.</figcaption>
</figure>

### Timeline

Only an approval writes a lock, so each commit that changed a `buckets.lock.json` is an approval. The timeline reads them from git, with one track per project and up to 200 approvals each. Pick a point, drag the slider, use the arrow keys or press Play to see the contract graph at that approval. The panel lists what the approval changed since the one before, with the same rows the review page showed. The graph comes from that version of the lock, which records buckets, contracts and symbols but no source code, so boxes are sized by the symbols each bucket offers.

Without git, in a shallow clone or for a lock that was never committed, the track says why it has no points.

<figure class="shot">
  <img src="/img/inspect-timeline.webp" width="1440" height="900" alt="The timeline view: three tracks for acme-shop, engine and ui-kit with colored points for approvals, a slider, and a panel listing what the selected approval changed." loading="lazy">
  <figcaption>Approval 6 of the repo project added the <code>ui-kit</code> project and a copy of its <code>Theme</code>.</figcaption>
</figure>

### Impact

Simulations that answer a question before anyone changes a file. They run in memory on the last check and write nothing.

- **Remove a bucket.** Pick a bucket to see the contracts that break without it, the files that stop compiling, the buckets affected and the projects that link what it publishes.
- **Route a symbol.** Pick a symbol from some bucket's `_/` code and the bucket that should use it. The answer lists the DMZ files needed at each level, through `.self` and `.parent`, marks the ones that already exist, and generates the re-export lines and the import with the real alias, ready to copy. It warns when the new edge would close a cycle.
- **Change a published symbol.** Pick a symbol of a `.external.ts` file to see the other DMZ files of the project that pass it on, the code inside the project that uses it, and the projects that link it, with the files there that import the symbol. Those projects would see a `link-changed` difference for the new signature.

<figure class="shot">
  <img src="/img/inspect-impact.webp" width="1440" height="900" alt="The impact view routing the symbol query to the bucket web: one DMZ file to write, root/dmz/store/web.ts, highlighted on the map." loading="lazy">
  <figcaption>Routing <code>query</code> from <code>store</code> to <code>web</code> needs one new DMZ file.</figcaption>
</figure>

### Event feed

While the page is open, a watcher runs the check again after files change, with a short debounce, and pushes the result to the page. The feed lists what happened, tagged by project: a file changed in a bucket, a violation appeared or was resolved, a lock difference appeared or was approved, a nested project appeared or went away, a link changed. The page itself updates in place. Each update says which ids changed, so a page whose content stayed the same reloads only the feed. Long lists, such as the symbols of the trace or the contracts that break in a simulation, show their first rows and a Show more button for the rest.

## Keyboard shortcuts

Press `?` on the page for this list. Shortcuts do nothing while the focus is in a text field.

| Key | Action |
|---|---|
| `/` | search a symbol |
| `j` and `k` | next and previous item in the view |
| `Enter` | open the item |
| `m` | switch between map and matrix |
| `g` | projects constellation |
| `a` | pending approvals |
| `t` | timeline of approvals |
| `[` and `]` | previous and next approval on the timeline |
| `p` | play or pause the timeline |
| `i` | impact simulation |
| `u` | up: parent bucket, then parent project |
| `f` | map in fullscreen, and back |
| `Esc` | close the panel or the help |
| `?` | the help |

## Exports

The map has an Export row. Map as SVG downloads the map of the current project, and Bucket graph as Mermaid downloads a flowchart with every project, bucket and contract. The projects view offers the Mermaid file too. The same files come from the command line, without a server:

```sh
buckets inspect --export svg > map.svg
buckets inspect --export mermaid --out buckets.mmd
```

`--out <file>` writes the file instead of printing it. It refuses a lock file, also through a link, and a folder. An export reads the analysis cache but never writes it. In the Mermaid flowchart, each project is a subgraph, each bucket a subgraph inside its parent, and each DMZ file an edge labeled with its symbol count. The syntax stays simple so older Mermaid versions read it too.

### The page as one HTML file

`--export html` writes the whole page into one file that opens in any browser without a server. Send it to someone who does not have the project, attach it to a pull request, or publish it, as the [live demo](https://nicolascaous.github.io/slopbuckets/demo/) does with a generated project of about 300 buckets.

```sh
buckets inspect --export html --out inspect.html
```

Every view works in the file: the map with one level or every bucket, the labels of a selection, the tooltips and fullscreen, the matrix, traces, the bucket panels, projects, approvals, the timeline and the impact simulations. A line under the top bar says which project the snapshot shows, when it was taken and which version of buckets exported it. The file is a snapshot: it does not watch files and never changes.

- The view and the selection live in the URL hash, such as `inspect.html#view=matrix&bucket=root%2Fbilling`, so a link can open the file on a given view. The back button moves between the views you opened.
- The file holds the snapshot, the stylesheets, the page script and the same renderers as the live page. Its Content-Security-Policy allows only its own inline scripts and styles, the two web fonts, and no requests. Offline, the page uses the system monospace fonts.
- The timeline holds the approvals that git had when you exported. Without git history the timeline has no window in the top bar.
- The path simulation of the impact view picks from the exports of every `_/` folder, read when you exported.
- The Export row still downloads the SVG and the Mermaid file, which the browser builds from the snapshot in the file.
- The file has no absolute folder of your computer: each project shows as its path in the repository. It has the names of buckets, files and symbols, the signatures of the symbols in contracts, and the authors and messages of the commits that changed a lock. Read it before you publish it.

The file grows with the project. For about 300 buckets it is 1.7 MB, about 240 KB when the server compresses it.

## The JSON for agents

`buckets inspect --json` prints the same state the page shows and exits, without a server:

```sh
buckets inspect --json > snapshot.json
```

The snapshot has every project with its buckets, DMZ files with their symbols, origins, chains, signatures and importers, the imports between buckets, cycles, orphan chains, violations with the same messages as the check, lock differences, links with the symbols each linked project publishes, and what each project publishes. A linked symbol that differs from the lock has a `change` field. Each bucket also lists `offers`, `consumes`, `dependsOn`, `dependents` and `rewriteCost`. An agent reads it to find the DMZ file a symbol already passes through, or the shortest path for a new one, instead of opening files one by one. The skill tells it to.

With `--export`, `--json` prints an object with the format, the file written and the text, plus the size of the SVG, the nodes and edges of the Mermaid graph, or the bytes of the HTML file. Every field is on the [Inspect snapshot](../reference/inspect) page.
