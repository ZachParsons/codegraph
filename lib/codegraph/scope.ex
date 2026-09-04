defmodule Codegraph.Scope do
  @moduledoc """
  Merges per-file `Codegraph.Graph`s into one project-wide graph (resolving
  which call targets are "in scope" i.e. defined somewhere in the project,
  vs. external boundary nodes), then does a breadth-first walk outward from
  a set of root modules to produce the subgraph actually shown to the user.

  Only outgoing (caller -> callee) edges are followed for the BFS itself;
  external boundary nodes are natural BFS leaves since we never analyzed
  their bodies, so they have no outgoing edges to expand into.

  Two independent depth budgets bound the walk, and a node's `level` (the
  UI's row/y-position) is its function-call hop count specifically, not
  its module-hop count — this is what makes the rendered graph an actual
  call tree (one row per call, including calls that stay inside the same
  module) rather than collapsing a module's whole internal call chain
  onto one row:

    * `depth` counts function-call hops: every edge followed, regardless
      of whether it stays inside the current module or crosses into a
      new one, spends one unit.
    * `module_depth` counts *modules*: a call from one function to
      another in the SAME module costs nothing, only a call that crosses
      into a module not yet seen on this path spends one unit. It exists
      purely to cap how far the walk sprawls across unrelated modules —
      it plays no part in a node's `level`.

  A node reachable within both budgets on some path is included; `level`
  and the module-hop count are each the value from whichever path first
  discovers that node (BFS order), same as the rest of this BFS.

  One exception: each root's own immediate callers (not the BFS
  descendants' callers, and not the callers' own callers) are looked up
  separately and included too, tagged `kind: :caller` on their edges, so
  the UI can draw them as an inverted one-generation tree above the root.
  """

  alias Codegraph.Analyzer
  alias Codegraph.GitSource
  alias Codegraph.Graph
  alias Codegraph.Graph.Edge

  @doc """
  Analyze every file matched by `globs` on disk and merge into one
  project-wide graph with `external` resolved on every node/edge. Each
  glob is resolved against `cwd` via `Path.expand/2`, so a relative glob
  (the common case) is scoped under `cwd` while an absolute one (e.g. a
  `--path` pointing at another package entirely) is used as-is.
  """
  @spec project_graph([String.t()], String.t()) :: Graph.t()
  def project_graph(globs \\ ["lib/**/*.ex"], cwd \\ File.cwd!()) do
    files =
      globs
      |> Enum.flat_map(&Path.wildcard(Path.expand(&1, cwd)))
      |> Enum.uniq()
      |> Enum.reject(&vendored?/1)

    files |> Enum.map(&Analyzer.analyze_file/1) |> merge()
  end

  # A recursive glob (e.g. `--path` pointing at a whole package root rather
  # than just its `lib/`) would otherwise sweep in fetched deps and
  # compiled artifacts alongside real source, which is both noise in the
  # graph and a source of exotic macro-generated ASTs the analyzer isn't
  # meant to handle.
  @vendored_segments ["deps", "_build"]
  defp vendored?(path) do
    path |> Path.split() |> Enum.any?(&(&1 in @vendored_segments))
  end

  @doc """
  Same as `project_graph/2`, but reads source as it existed at `ref` via
  `git show` instead of the working tree — no checkout needed.
  """
  @spec project_graph_at(String.t(), [String.t()], String.t()) :: Graph.t()
  def project_graph_at(ref, globs \\ ["lib/**/*.ex"], cwd \\ File.cwd!()) do
    paths =
      globs
      |> Enum.flat_map(&GitSource.list_files(ref, &1, cwd))
      |> Enum.uniq()

    paths
    |> Enum.flat_map(fn path ->
      case GitSource.read_file(ref, path, cwd) do
        {:ok, source} -> [Analyzer.analyze_source(source, path)]
        :error -> []
      end
    end)
    |> merge()
  end

  defp merge(file_graphs) do
    definitions = file_graphs |> Enum.flat_map(& &1.nodes) |> Enum.uniq()

    defined_functions =
      definitions
      |> Enum.filter(&(not is_nil(&1.function)))
      |> MapSet.new(&{&1.module, &1.function, &1.arity})

    edges =
      file_graphs
      |> Enum.flat_map(& &1.edges)
      |> Enum.map(&resolve_edge(&1, defined_functions))
      |> Enum.uniq()

    defined_nodes = Enum.map(definitions, &%{&1 | external: false})
    external_nodes = edges |> Enum.map(& &1.to) |> Enum.filter(& &1.external)

    %Graph{nodes: Enum.uniq(defined_nodes ++ external_nodes), edges: edges}
  end

  @typedoc """
  A root to seed the BFS from: either every function defined directly in a
  module, or one specific function.
  """
  @type root :: {:module, module()} | {:function, module(), atom(), non_neg_integer()}

  @doc """
  BFS from `roots` out to `depth` function-call hops away, additionally
  capped at `module_depth` distinct modules crossed on any given path
  (each `non_neg_integer() | :infinity`) — see the moduledoc for how the
  two differ. Each root is either `{:module, Mod}` (seeds from every
  function `Mod` defines) or `{:function, Mod, name, arity}` (seeds from
  just that one function).

  Preserves call order (the order edges were found in the source, already
  preserved through `project_graph/2`'s merge) in the returned edges/nodes,
  rather than the unspecified order a MapSet would give — this is what
  lets the UI lay out sibling nodes left-to-right in call order instead of
  an arbitrary one.
  """
  @spec scope(Graph.t(), [root()], non_neg_integer() | :infinity, non_neg_integer() | :infinity) :: Graph.t()
  def scope(%Graph{} = graph, roots, depth \\ 2, module_depth \\ :infinity) do
    root_modules = roots |> Enum.map(&root_module/1) |> MapSet.new()

    edges_by_from =
      Enum.group_by(graph.edges, fn e -> {e.from.module, e.from.function, e.from.arity} end)

    # `not n.external` matters: an external node is an unresolved call
    # TARGET, not something actually defined in the module (this also
    # catches the analyzer misattributing an unqualified builtin call —
    # e.g. `raise(...)`, `is_nil(...)` — to the enclosing module rather
    # than Kernel). Seeding it as its own root alongside the real root
    # that calls it would give it two disagreeing hop counts on the same
    # path (0 as a root, 1 as that root's callee) — whichever it's
    # assigned first wins, but the other interpretation still leaves a
    # real edge in the graph, which visibly conflicts with it in the UI.
    start = Enum.filter(graph.nodes, fn n -> n.function != nil and not n.external and matches_root?(n, roots) end)

    acc = %{
      node_set: MapSet.new(start),
      node_list: start,
      edge_set: MapSet.new(),
      edge_list: [],
      levels: Map.new(start, &{node_key(&1), 0}),
      module_hops: Map.new(start, &{node_key(&1), 0})
    }

    acc = bfs(start, edges_by_from, depth, module_depth, 0, acc)

    caller_edges = caller_edges(graph, start, acc.node_set)
    caller_nodes = caller_edges |> Enum.map(& &1.from) |> Enum.uniq()

    module_nodes =
      Enum.filter(graph.nodes, fn n -> is_nil(n.function) and MapSet.member?(root_modules, n.module) end)

    nodes =
      (acc.node_list ++ module_nodes ++ caller_nodes)
      |> Enum.uniq()
      |> Enum.map(&%{&1 | level: Map.get(acc.levels, node_key(&1))})

    %Graph{nodes: nodes, edges: acc.edge_list ++ caller_edges}
  end

  # One hop backward from each root function only (not from BFS
  # descendants, and not recursively from the callers themselves) — a
  # caller that is itself a root, or that's already reachable forward
  # from the roots (already `scoped_node_set`), is left out: it already
  # has a place in the regular downward tree, so showing it a second time
  # above would just be confusing, not additional information.
  defp caller_edges(%Graph{} = graph, start, scoped_node_set) do
    root_keys = start |> Enum.map(&node_key/1) |> MapSet.new()

    graph.edges
    |> Enum.filter(fn e ->
      MapSet.member?(root_keys, node_key(e.to)) and
        not MapSet.member?(root_keys, node_key(e.from)) and
        not MapSet.member?(scoped_node_set, e.from)
    end)
    |> Enum.uniq()
    |> Enum.map(&%{&1 | kind: :caller})
  end

  defp node_key(%{module: m, function: f, arity: a}), do: {m, f, a}

  defp root_module({:module, mod}), do: mod
  defp root_module({:function, mod, _name, _arity}), do: mod

  defp matches_root?(node, roots) do
    Enum.any?(roots, fn
      {:module, mod} -> node.module == mod
      {:function, mod, name, arity} -> node.module == mod and node.function == name and node.arity == arity
    end)
  end

  # One round per function-call hop (`depth` is the round budget, `round`
  # the hop count so far — this becomes each newly discovered node's
  # `level`). An edge is additionally dropped when following it would
  # cross `module_depth` distinct modules on this path: `module_hops`
  # tracks, per already-discovered node, the module-crossing count of
  # whichever path discovered it first, and a same-module edge inherits
  # its source's count unchanged while a cross-module edge adds one.
  defp bfs([], _edges_by_from, _depth, _module_depth, _round, acc), do: acc
  defp bfs(_frontier, _edges_by_from, depth, _module_depth, _round, acc) when depth <= 0, do: acc

  defp bfs(frontier, edges_by_from, depth, module_depth, round, acc) do
    next_round = round + 1

    candidate_edges =
      frontier
      |> Enum.flat_map(fn n -> Map.get(edges_by_from, {n.module, n.function, n.arity}, []) end)
      |> Enum.uniq()
      |> Enum.reject(&MapSet.member?(acc.edge_set, &1))

    {new_edges, module_hops} =
      Enum.reduce(candidate_edges, {[], acc.module_hops}, fn e, {kept, hops} ->
        from_hops = Map.fetch!(hops, node_key(e.from))
        to_hops = if e.from.module == e.to.module, do: from_hops, else: from_hops + 1

        if to_hops <= module_depth do
          to_key = node_key(e.to)
          hops = if Map.has_key?(hops, to_key), do: hops, else: Map.put(hops, to_key, to_hops)
          {[e | kept], hops}
        else
          {kept, hops}
        end
      end)

    new_edges = Enum.reverse(new_edges)

    acc = %{
      acc
      | edge_set: Enum.reduce(new_edges, acc.edge_set, &MapSet.put(&2, &1)),
        edge_list: acc.edge_list ++ new_edges,
        module_hops: module_hops
    }

    new_nodes =
      new_edges
      |> Enum.map(& &1.to)
      |> Enum.uniq()
      |> Enum.reject(&MapSet.member?(acc.node_set, &1))

    acc = %{
      acc
      | node_set: Enum.reduce(new_nodes, acc.node_set, &MapSet.put(&2, &1)),
        node_list: acc.node_list ++ new_nodes,
        levels: Enum.reduce(new_nodes, acc.levels, &Map.put(&2, node_key(&1), next_round))
    }

    next_frontier = Enum.reject(new_nodes, & &1.external)
    next_depth = if depth == :infinity, do: :infinity, else: depth - 1

    bfs(next_frontier, edges_by_from, next_depth, module_depth, next_round, acc)
  end

  defp resolve_edge(%Edge{} = edge, defined_functions) do
    to = edge.to
    external = not MapSet.member?(defined_functions, {to.module, to.function, to.arity})
    %{edge | from: %{edge.from | external: false}, to: %{to | external: external}}
  end
end
