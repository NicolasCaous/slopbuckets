---
title: Inspect
description: The read-only page where a human looks at the architecture, with the graph, the matrix, the pending list, the file tree, the details panel, the keyboard and the URL.
---

# Inspect

`buckets inspect` is how a human looks at the architecture that the agents keep. It serves a read-only page on `127.0.0.1`, prints the page's URL, and updates the page while files change. It stops with Ctrl+C, or by itself after 30 minutes without an open page. It never writes to the project.

```sh
buckets inspect
```

Every element of the page answers one of these questions:

1. What does the architecture look like? The buckets, their purposes and their dependencies.
2. What is broken right now? The pending violations.
3. Why does A depend on B? The reason, and the imports that form the dependency.
4. Where does this file live, and who uses this export?
5. How does A reach C? The dependency paths between two buckets.
6. What did the agents change while I was looking?

<figure class="shot">
  <img src="/img/inspect-page.webp" width="1200" height="760" alt="The inspect page on a shop project with 31 buckets and 9 pending items. The top bar has the search, the project picker and the pending count. The left column lists the buckets with their file counts and red pending badges. The bar above the graph reads Focus: payments, depth 1, with minus, plus and Show all buttons. The graph shows checkout and returns above payments, and events, http-client, log and money below it. The details panel on the right shows the purpose of payments, its files glob with a fold-out list of its files, each export of its public file with its line and the buckets that use it, and its dependencies with state, import count and reason." fetchpriority="high">
  <figcaption>The graph in focus mode on <code>payments</code>, with the bucket in the details panel.</figcaption>
</figure>

## Layout

The page is one screen with four areas:

- The top bar has the search (`/`) for a bucket, a file or an export, the picker of nested projects when there are any, and the number of pending violations, which opens the pending view. After a live change it also shows the number of changes and a "Mark changes seen" button.
- The left column lists the buckets, with a filter on name or purpose and a sort by name, files, dependencies, dependents or pending violations. Each row shows a red badge with its pending count when it has any, and the number the sort uses, or its file count when the sort is by name.
- The center shows the active view, picked with tabs or the keys `1` to `4`: graph, matrix, pending or files.
- The right column is the details panel for whatever is selected.

In a window narrower than 1000 pixels the bucket list moves below the view, and below 640 pixels every area stacks. There are no modals and no intro animation. When the URL names no view, the page opens on the pending view if the project has pending violations, and on the graph otherwise.

## Graph

The config forbids cycles, so the dependency graph is acyclic and the page draws it in layers: a bucket sits above the buckets it depends on, and every edge points down.

- A node shows the bucket name, its number of files and a red badge with its number of pending violations. The purpose shows on hover and in the panel.
- A solid edge is a dependency that is declared and used. A dashed edge is declared but has no import. A red dotted edge is an import without a declaration. The line style carries the difference, so it does not depend on color alone.
- A click on a node selects the bucket, highlights it with its direct dependencies and dependents, and fades the rest.
- A click on an edge selects the dependency, and the panel shows the reason and every import that forms it, with file and line.
- Dragging or scrolling pans the graph, and Ctrl+scroll zooms. The Fit, + and − buttons above the graph fit the drawing to the view and zoom.

### Focus mode

Focus mode draws only the neighborhood of the selection: the selected bucket, or both ends of the selected dependency, and the buckets up to N levels above and below it. The bar above the graph shows the state. In focus mode it reads "Focus: payments, depth 1", and its − and + buttons change N from 1 to 9. The keys `[` and `]` do the same.

With 60 buckets or fewer, the graph opens whole and the bar reads "Whole graph". With a bucket selected, the bar has a "Focus on" button that switches to depth 1, and in focus mode a "Show all" button goes back to the whole graph.

Above 60 buckets the graph always stays in focus mode, at depth 1 or more, and the bar has no "Show all", so a project with 500 buckets never draws 500 boxes at once. When nothing is selected, the graph opens on the bucket with the most pending violations. When nothing is pending, it opens on the bucket with the most dependencies among those that no other bucket depends on. The page writes that bucket into the URL, so a reload shows the same picture.

### Paths between two buckets

With a bucket selected, Shift and click on a second bucket, or Shift+Enter on it, shows the dependency paths between the two. This answers questions such as "why does billing end up depending on db?". The graph then draws only the two buckets and the buckets on those paths, in either direction. The panel lists up to 50 paths, shortest first, with a link on every bucket, and says so when there is no path. The bar reads "Paths between http and catalog" with a "Clear paths" link, and `Esc` clears the paths too.

<figure class="shot">
  <img src="/img/inspect-graph-focus.webp" width="580" height="714" alt="The graph showing the paths between http and catalog. The bar above the graph reads Paths between http and catalog, with a Clear paths link. Only three buckets are drawn: http at the top, reviews in the middle and catalog at the bottom. A red dotted arrow from http to reviews is an import without a declaration, and a solid arrow goes from reviews to catalog. The selected bucket reviews is filled in blue, and http and reviews each have a red pending badge." loading="lazy">
  <figcaption>The paths between <code>http</code> and <code>catalog</code>, which run through <code>reviews</code>.</figcaption>
</figure>

## Matrix

A bucket by bucket matrix, with the rows and the columns in the order of the graph layers. Each row imports its columns. It scales better than the graph to hundreds of buckets, because no edge crosses another.

- A cell shows the number of imports from the row bucket to the column bucket. A declared dependency without imports shows a dashed `0`, and an import without a declaration is red with a `!`.
- A click on a cell opens the dependency in the panel, as a click on an edge does, and a click on a bucket name opens the bucket. The row and column of the selected bucket, or of both ends of the selected dependency, are shaded.
- Up to 200 buckets the matrix is a table with sticky headers. Above 200 buckets the page draws it on a canvas with fixed headers. The "Show as table" button then switches to a list with one row per dependency, its two buckets, its state and its number of imports, which works with the keyboard and screen readers. "Show as matrix" switches back.

<figure class="shot">
  <img src="/img/inspect-matrix.webp" width="940" height="714" alt="The matrix view of the 31 bucket shop. Each cell holds the number of imports from the row bucket to the column bucket. The cell from reviews to shipping shows a dashed 0, declared but never imported. The cell from http to reviews is red with 1!, and it is selected, so the rows and columns of http and reviews are shaded blue. The details panel shows the dependency from http to reviews as undeclared, with no reason, and its one import at src/http/request.ts line 4, which imports reviewsTypes from src/reviews/index.ts." loading="lazy">
  <figcaption>The matrix with the undeclared dependency from <code>http</code> to <code>reviews</code> selected.</figcaption>
</figure>

## Pending

The list of everything `buckets check` reports, grouped by rule or by bucket, with a filter on the message text. Grouped by bucket, a violation that concerns two buckets shows under both, and each item names its rule. Each item shows a link to the dependency or bucket it concerns, a "Copy file:line" button and the full message, the same text the agent reads. The `file:line` in the message links to the file.

After the violations comes the advice, under its own Advice heading, with a note that it never fails the check or blocks the turn. Advice is a note on the config, such as a reason under three words or an `ignore` glob that covers more than 20% of the files besides tests, scripts, fixtures and examples. Each note links to the bucket it is about and shows the text `buckets check` prints. The filter applies to the advice too. The pending view shows both, so a project with advice and no violations still lists its notes.

<figure class="shot">
  <img src="/img/inspect-pending.webp" width="580" height="714" alt="The pending view grouped by rule, with 9 items. Each group has a heading with the rule id and a count. Each item has a link to the dependency it concerns, a Copy file:line button and the full message, in which the file and line are a link: an undeclared dependency from http to reviews, an unused dependency from reviews to shipping, and a private file import from returns into payments. The heading of the file-unowned group starts at the bottom." loading="lazy">
  <figcaption>The pending view grouped by rule.</figcaption>
</figure>

## Files

The file tree of the project, with an Owner column that names the bucket of each file, or says `ignored`, `no bucket` or `two buckets`. The Owner filter shows one of these states and gives the number of files in each, and a second filter matches paths. A click on a folder folds it. The view answers where each file lives, and right after `init` the `no bucket` filter shows which files no bucket covers yet.

<figure class="shot">
  <img src="/img/inspect-files.webp" width="580" height="714" alt="The files view of the shop right after buckets init, with the Owner filter on no bucket (142). The tree lists fixtures, orphans, packages/storefront-sdk, scripts and src with their file counts, and every file is marked no bucket in red. The count says 142 files." loading="lazy">
  <figcaption>The files view filtered on "no bucket", right after <code>buckets init</code>.</figcaption>
</figure>

## Details panel

- With nothing selected, the panel shows the project: its numbers of buckets, dependencies, files and pending violations, the number of advice notes with a link to them, and the changes since the page opened. The root project shows under the name of its folder.
- A bucket shows its purpose and its `files` globs, each with the number of files it matches, followed by a fold-out list of the files that the bucket alone owns. Then come its public files, each with every exported name, its line, whether it is a type, and the buckets that use it, or "Closed" when the bucket exports nothing. A public file that does not exist says so. Then come `external` when set, and its dependencies, each with its state, its number of imports, its reason and the first three imports that back it, with file, line and names, so a reason that no longer matches its imports stands out. Then come its dependents with the names each one uses, its packages, each with its state, its number of imports, its reason and the first three files that import it, and last its pending violations. A list of backing imports longer than three has a "Show N more" button.
- When the dependents of a bucket fall into two or more groups that share no exported name, the Dependents section opens with a "May want to split" note that lists each group with the names it uses. That is the split rule of the skill: dependents that use disjoint parts of the interface are a sign that the bucket holds two jobs. A dependent with a namespace or side-effect import could use any name, so then the note does not show.
- A dependency shows its state, the reason, and every import with file and line, the imported names and the imported file.
- A file shows its owner, its imports grouped by target bucket, the files of other buckets that import it, and the pending violations in that file.
- An export shows its name, its line in the public file and the files that import it, with their buckets.
- A shift-click pair shows the paths between the two buckets. The first bucket stays, and another shift-click replaces the second.

A list longer than 50 items shows the first 50 and a "Show N more" button. Every `file:line` has a Copy button.

## Live changes

The status at the right of the top bar reads "Live" while the page is connected and "Reconnecting…" when the connection drops. When a file changes, the server computes a new snapshot and sends it to the page. When the system cannot watch the folder, the command says so in the terminal, and only a reload shows changes.

The page compares each snapshot with the one before and marks what changed since it opened: a new bucket, a dependency added, removed or with a new state, a new pending violation and a resolved one. The top bar counts the changes, and the panel with nothing selected lists them with links. In the views, a changed item gets a dot in the graph, an outline in the matrix and the pending list, and a `new` or `changed` tag in the lists and the panel. The "Mark changes seen" button, in the top bar or in the panel, clears every mark. The page keeps the marks in memory only, so a reload clears them too. This is not a history. The git log of `buckets.config.json` is the history.

While `buckets.config.json` does not parse, for example when it is half saved, a red banner names the errors and the page keeps showing the last valid architecture.

## Keyboard

The keys in the first part of the table work anywhere on the page except in a text field.

| Key | Action |
|---|---|
| `/` | moves to the search |
| `1` to `4` | switches to the graph, matrix, pending or files view |
| `Esc` | clears the shift-click pair, then the selection; above 60 buckets the graph keeps a bucket selected |
| `[` and `]` | lowers or raises the focus depth, up to 9; depth 0 is the whole graph, which only projects of 60 buckets or fewer have |
| `c` | copies the selected bucket name or file path, the `file:line` of the selected export, or the `file:line` of the first import of the selected dependency |

In the search, the up and down arrows move through the results, `Enter` opens one and moves to its details, and `Esc` closes the search. The bucket list, the file tree and the dependency table are one tab stop each: the arrows, `Page Up`, `Page Down`, `Home` and `End` move between rows, and `Enter` opens the row.

In the graph:

| Key | Action |
|---|---|
| left and right arrows | on a bucket, move to the next bucket in the same layer; on an edge, move to the next edge of the same bucket |
| up and down arrows | on a bucket, move to the edge toward the nearest dependent or dependency; on an edge, move to its upper or lower bucket |
| `Enter` or `Space` | selects the bucket or edge; with Shift on a second bucket, shows the paths |
| Shift and an arrow | pans |
| `+` or `=`, `-` | zoom in, zoom out |
| `0` | fits the graph to the view |

## URL

The hash holds the place the page shows: the view, the selection and the graph options, such as `#/graph/bucket/billing`, `#/matrix/edge/billing/payments`, `#/files/file/src/a.ts` or `#/graph?depth=2`. A selection is `bucket/<name>`, `edge/<from>/<to>`, `export/<bucket>/<name>` or `file/<path>`. A hash without a view opens the default view.

The query string before the hash holds the options of the lists, such as `?sort=pending&by=bucket#/pending`. The page leaves out every option that has its default value.

| Option | Place | Values |
|---|---|---|
| `depth` | hash | the focus depth, 0 to 9 |
| `pair` | hash | two bucket names separated by a comma, for the paths between them |
| `project` | hash | the path of a nested project; the root project is the default |
| `filter` | query | the filter of the bucket list |
| `sort` | query | `name`, `files`, `dependencies`, `dependents` or `pending` |
| `by` | query | `rule` or `bucket`, the grouping of the pending view |
| `pending` | query | the filter of the pending view |
| `owner` | query | `all`, `bucket`, `ignored`, `unowned` or `overlap`, the Owner filter of the files view |
| `path` | query | the path filter of the files view |
| `table` | query | `1` shows the list of dependencies instead of the canvas matrix |

Each new selection or view adds a history entry, so the back button returns to the one before. Typing in a filter or changing the sort replaces the URL without a new entry. A reload or a copied link opens the same place while the server runs. The server picks a free port on each start, so a link from an earlier run does not work.

## Appearance

The page follows the light or dark setting of the system. Text uses the system font, and bucket names, paths and code names use a monospaced font. Three colors carry meaning: blue for the selection, red for violations, and gray for everything else. The only animation is a 0.15 second fade of the graph's nodes and edges when the selection changes, and `prefers-reduced-motion` turns it off.

## For agents and scripts

`buckets inspect --json` prints the snapshot the page loads and exits. The [Inspect snapshot](../reference/inspect) page describes it. The exports print without a server and exit.

| Flag | What it does |
|---|---|
| `--json` | prints the snapshot as JSON |
| `--no-recursive` | keeps only the root project and leaves nested projects out, on the page and in every output |
| `--export svg` | prints the layered graph of every project in one SVG, with a legend of the line styles |
| `--export mermaid` | prints a Mermaid flowchart with the reasons on the edges |
| `--export dot` | prints a Graphviz file with the reasons on the edges |
| `--export html` | prints the whole page as one offline file with the snapshot inside; it does not update |
| `--out <file>` | writes the export to the file instead of stdout; it works only with `--export` |

## Security

The server listens on `127.0.0.1` only and answers only GET and HEAD requests. It refuses a request whose `Host` header is not `127.0.0.1:<port>` or `localhost:<port>`, which stops DNS rebinding, and a request whose `Origin` header names another origin. It also refuses requests for data that the browser marks as cross-site, so another site open in the same browser cannot read the project. A link from another site still opens the page. Every response carries a Content Security Policy that allows scripts and requests only from the server itself and forbids other pages from framing it.
