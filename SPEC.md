# codegraph

A Phoenix/LiveView tool, added as a `:dev`-only dependency to an Elixir project,
that statically analyzes a component of that project's source and renders its
module/function call structure as an interactive graph in the browser — either
as a single tree (current state) or as two trees with diff annotations
(before/after across two git commits).

## Identity

- Name: `codegraph`
- Location: `/Users/zach/se/projects/codegraph`
- Module namespace: `Codegraph` (`mix new codegraph` default casing — no
  underscore to split, so `CodeGraph` would require `--module CodeGraph`
  explicitly; going with the default)
- Consumed by a target project as:
  ```elixir
  {:codegraph, path: "../codegraph", only: :dev, runtime: false}
  # or, once published: {:codegraph, "~> 0.1", only: :dev, runtime: false}
  ```
- Invoked from inside the target project as `mix codegraph`

## Two use cases

1. **Single-tree view** — visualize one component (a root module and its
   transitive callees/callers) at the current working-tree state.
2. **Diff view** — visualize the same component at two git commits (e.g. a
   feature branch tip vs. its merge-base, or any two SHAs/refs), rendered as
   two trees side by side with nodes/edges annotated as added, removed, or
   modified.

## Analysis engine

**Hybrid, AST-primary:**

- The core engine parses source with `Code.string_to_quoted!/2` and walks the
  AST (`Macro.prewalk`/`traverse`) to extract:
  - `defmodule` → module nodes
  - `def`/`defp` → function nodes (name/arity, public/private)
  - call sites within function bodies → edges (resolving local calls,
    `Module.fun/arity` remote calls, and captures `&Mod.fun/N` on a
    best-effort basis; pipe (`|>`) call targets included)
- This works directly against source text pulled via `git show <sha>:path`
  (or the working tree for uncommitted state), so **no compilation step is
  required** — critical for analyzing arbitrary historical commits without
  checking them out or resolving their dependency tree.
- **Optional `mix xref` enrichment pass**: when analyzing the currently
  checked-out, compiled revision (i.e. not a historical diff side), the tool
  may additionally query `mix xref graph`/`callers`/`callees` to cross-check
  and fill in calls the AST walker's heuristics miss (notably macro-generated
  calls it can't see textually). This pass is skipped for diff sides that
  aren't the current checkout, since xref requires a compiled BEAM.

## Component scope

The user specifies a **root module** (or several) and a **depth**; the tool
does a BFS over the call graph from the root(s) — outgoing edges (what the
root calls), and optionally incoming edges (what calls the root) — up to that
depth, and everything reached becomes the visualized component. Depth counts
**function-call hops**: every call followed spends one unit, whether or not
it stays inside the current module — this is what a node's row in the
rendered tree reflects, so a long in-module call chain still reads as several
rows, not one. Depth 0 = just the root function(s) themselves; unset/
unbounded depth = full transitive closure (bounded practically by hitting
external-boundary nodes, see below).

A second, independent budget, **module depth**, counts distinct *modules*
crossed on a given path instead — a call that stays in the current module is
free, only a call into a module not yet seen on that path spends one unit.
It exists purely to cap how far the walk sprawls across unrelated modules,
regardless of how many function-call hops that takes; it has no effect on a
node's row. Unset/unbounded module depth (the default) applies no extra cap
beyond depth itself.

```
mix codegraph --root MyApp.Accounts --depth 4
mix codegraph --root MyApp.Accounts --root MyApp.Billing --depth 6 --module-depth 2
```

## Graph model

**Unified hierarchical graph**, not separate module/function views:

- Modules render as clusters (compound/parent nodes) containing their
  function nodes.
- Edges are drawn function → function (the ground truth from call-site
  analysis).
- Module → module edges are a derived/rolled-up view (aggregating whether
  any function in module A calls any function in module B) shown when
  zoomed/collapsed to cluster level.
- Node identity: functions are keyed by fully-qualified `Module.name/arity`;
  modules are keyed by their full name.

### External calls (out-of-scope targets)

Calls that leave the analyzed scope (Erlang/OTP, Phoenix, Ecto, other deps,
or simply anything outside the BFS closure) render as **boundary/leaf
nodes**: visually de-emphasized (greyed), not expandable, not walked further.
This preserves the "this reaches into Ecto.Repo" context without pulling in
the internals of every dependency.

## Diff view

- **Node matching across commits**: by exact fully-qualified signature
  (`Module.name/arity`). No rename/similarity heuristics in v1 — a changed
  arity or name is simply a remove-on-A + add-on-B, not linked. (Rename
  detection is a plausible future enhancement, not in scope now.)
- **Change classification**:
  - `added` — node/edge present in B, absent in A
  - `removed` — node/edge present in A, absent in B
  - `modified` — node present in both with the same signature, but its
    function body differs (text/AST diff of the `def` body) even if its
    outgoing call set is unchanged (e.g. a guard or internal logic changed
    with no call-graph impact)
  - unchanged — present identically in both, rendered normally
- Diff sides are read via `git show <sha>:path` per file — same AST-walker
  engine as the single-tree case, run twice, then reconciled by signature.
- Rendering: two trees (A and B), or a merged single tree with color-coded
  add/remove/modify status per node/edge — exact visual treatment (side by
  side vs. overlaid) is a UI-implementation detail to settle when building
  the LiveView, not fixed here.

```
mix codegraph --root MyApp.Accounts --diff HEAD~5..HEAD
mix codegraph --root MyApp.Accounts --diff main..feature-branch
```

## Web UI

- **Phoenix + LiveView.** The analyzed graph (nodes/edges/diff status) is
  held server-side in LiveView assigns; `handle_event` drives search/filter/
  expand-collapse/depth changes server-side and re-pushes graph data to the
  client.
- **D3.js** renders the graph via a LiveView JS hook. Since D3 has no
  built-in support for compound (parent/child) nodes or layered directed
  layout, the hook uses **d3-dag** for a layered/hierarchical (dagre-style)
  layout — callers above/left, callees below/right, edges flowing
  consistently in one direction, minimizing crossings. Module clustering is
  hand-built on top (grouping function nodes visually/positionally by parent
  module rather than via a native compound-node primitive, since D3 doesn't
  have one).
- Interactions to support in the UI (initial set, refine during build):
  search/filter by module or function name, click a module cluster to
  collapse it to a single rolled-up node, click a boundary/external node to
  no-op (it's a dead end by design), hover an edge/node for details
  (signature, file:line, doc if present).

## Out of scope / phase 2+

- A standalone CLI/escript mode that points at an arbitrary repo path
  without requiring it to add `codegraph` as a dependency. Deferred in favor
  of shipping the mix-dependency mode first; the analysis engine underneath
  should stay decoupled enough that this is an additive wrapper later, not a
  rewrite.
- Rename/similarity-based diff matching (currently: exact signature match
  only).
- Force-directed layout as an alternative/toggle to the default layered
  layout.
- Publishing to Hex.

## Open questions for implementation time (not blocking the plan)

- Exact color/status legend and visual treatment for diff mode (side-by-side
  panes vs. single merged/overlaid tree).
- How deep the AST walker goes in resolving indirect call targets (e.g.
  calls through `apply/3`, dynamically constructed module atoms, behaviour
  callbacks) — likely best-effort with a visible "unresolved call" marker
  rather than silently dropping them.
- Whether `--depth` unbounded is ever practical on a large app, or should
  default to a small number (e.g. 2) with an explicit `--depth :infinity`
  opt-in.
