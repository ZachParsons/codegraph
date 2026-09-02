# Roadmap

Vertical slices — each should leave the tool usably further along
end-to-end, not just one layer deeper. See SPEC.md for design details.

## Foundation

- [x] Scaffold mix project + git repo
- [x] Boot `mix codegraph` (empty Phoenix/LiveView shell)

## Single-tree view (use case 1)

- [x] AST walker: extract modules/defs/call sites from one file into `Codegraph.Graph`
- [x] Render that graph as raw data in LiveView (folded into D3 slice below)
- [x] Root-module + depth BFS across multiple files/modules (component scope)
- [x] External/out-of-scope calls as greyed boundary nodes
- [x] D3.js + d3-dag layered rendering of the graph in-browser
- [x] Basic interactions: search/filter, click to collapse a module cluster

## Diff view (use case 2)

- [x] Read source at an arbitrary git ref via `git show <sha>:path` (no checkout)
- [x] Run the walker on two refs, reconcile nodes by `Module.fun/arity`
- [x] Classify added / removed / modified (body diff) nodes & edges
- [x] Diff rendering in browser: two trees or overlaid, color-coded by status

## Hardening / polish

- [ ] Optional `mix xref` enrichment pass for the current compiled revision
- [x] Dogfood: add as a dep to a real external repo, verify `mix codegraph` there
- [x] Handle indirect/dynamic calls gracefully (mark unresolved, don't crash)

## Later (not yet scheduled)

- [ ] Standalone CLI/escript mode (no host-repo dependency)
- [ ] Rename-aware diff matching
- [ ] Publish to Hex
