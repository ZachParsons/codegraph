defmodule Codegraph.Scope do
  @moduledoc """
  Merges per-file `Codegraph.Graph`s into one project-wide graph (resolving
  which call targets are "in scope" i.e. defined somewhere in the project,
  vs. external boundary nodes), then does a breadth-first walk outward from
  a set of root modules to produce the subgraph actually shown to the user.

  Only outgoing (caller -> callee) edges are followed for the BFS itself;
  external boundary nodes are natural BFS leaves since we never analyzed
  their bodies, so they have no outgoing edges to expand into.

  `depth` counts *modules*, not function calls: a call from one function
  to another in the SAME module costs nothing, so a module's whole
  internal call structure is included, however many calls deep, as soon
  as the module itself is in scope. Only a call that crosses into a
  module not yet seen spends one unit of depth. This is what lets the UI
  lay every function of a given module out at the same visual depth
  ("the same box") instead of one row per function-call hop — which is
  what a naive per-edge depth counter produced: a long intra-module call
  chain silently ate the whole `depth` budget before the walk ever
  reached a different module.

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
  Analyze every file matched by `globs` (relative to `cwd`) on disk and
  merge into one project-wide graph with `external` resolved on every
  node/edge.
  """
  @spec project_graph([String.t()], String.t()) :: Graph.t()
  def project_graph(globs \\ ["lib/**/*.ex"], cwd \\ File.cwd!()) do
    files =
      globs
      |> Enum.flat_map(&Path.wildcard(Path.join(cwd, &1)))
      |> Enum.uniq()

    files |> Enum.map(&Analyzer.analyze_file/1) |> merge()
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
  BFS from `roots` out to `depth` modules away (non-negative integer, or
  `:infinity` for the full transitive closure) — see the moduledoc for
  what "modules away" means. Each root is either `{:module, Mod}` (seeds
  from every function `Mod` defines) or `{:function, Mod, name, arity}`
  (seeds from just that one function).

  Preserves call order (the order edges were found in the source, already
  preserved through `project_graph/2`'s merge) in the returned edges/nodes,
  rather than the unspecified order a MapSet would give — this is what
  lets the UI lay out sibling nodes left-to-right in call order instead of
  an arbitrary one.
  """
  @spec scope(Graph.t(), [root()], non_neg_integer() | :infinity) :: Graph.t()
  def scope(%Graph{} = graph, roots, depth \\ 2) do
    root_modules = roots |> Enum.map(&root_module/1) |> MapSet.new()

    module_depth = module_bfs(graph, root_modules, depth)
    in_scope_modules = module_depth |> Map.keys() |> MapSet.new()

    edges_by_from =
      Enum.group_by(graph.edges, fn e -> {e.from.module, e.from.function, e.from.arity} end)

    start = Enum.filter(graph.nodes, fn n -> n.function != nil and matches_root?(n, roots) end)

    acc = %{node_set: MapSet.new(start), node_list: start, edge_set: MapSet.new(), edge_list: []}
    acc = bfs(start, edges_by_from, in_scope_modules, acc)

    caller_edges = caller_edges(graph, start, acc.node_set)
    caller_nodes = caller_edges |> Enum.map(& &1.from) |> Enum.uniq()

    module_nodes =
      Enum.filter(graph.nodes, fn n -> is_nil(n.function) and MapSet.member?(root_modules, n.module) end)

    nodes =
      (acc.node_list ++ module_nodes ++ caller_nodes)
      |> Enum.uniq()
      |> Enum.map(&%{&1 | level: Map.get(module_depth, &1.module)})

    %Graph{nodes: nodes, edges: acc.edge_list ++ caller_edges}
  end

  # BFS over the MODULE graph: an edge `mod_a -> mod_b` exists whenever
  # some function in `mod_a` calls some function in `mod_b` (same-module
  # calls never create one). This — not the function call graph itself —
  # is what `depth` measures, one level per round exactly like the
  # function-level `bfs/4` below, just counting module hops instead of
  # call hops. Multiple roots seed multiple BFS sources at once, same as
  # `bfs/4`, so each module's level is its shortest hop count from
  # whichever root reaches it first.
  defp module_bfs(%Graph{} = graph, root_modules, depth) do
    edges_by_from_module =
      graph.edges
      |> Enum.filter(fn e -> e.from.module != e.to.module end)
      |> Enum.map(fn e -> {e.from.module, e.to.module} end)
      |> Enum.uniq()
      |> Enum.group_by(&elem(&1, 0), &elem(&1, 1))

    initial = Map.new(root_modules, &{&1, 0})
    module_bfs_step(MapSet.to_list(root_modules), edges_by_from_module, depth, 0, initial)
  end

  defp module_bfs_step(_frontier, _edges_by_from_module, depth, _level, acc) when depth <= 0, do: acc
  defp module_bfs_step([], _edges_by_from_module, _depth, _level, acc), do: acc

  defp module_bfs_step(frontier, edges_by_from_module, depth, level, acc) do
    next_level = level + 1

    discovered =
      frontier
      |> Enum.flat_map(fn m -> Map.get(edges_by_from_module, m, []) end)
      |> Enum.uniq()
      |> Enum.reject(&Map.has_key?(acc, &1))

    acc = Enum.reduce(discovered, acc, &Map.put(&2, &1, next_level))
    next_depth = if depth == :infinity, do: :infinity, else: depth - 1

    module_bfs_step(discovered, edges_by_from_module, next_depth, next_level, acc)
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

  # Unbounded, once module_bfs above has already decided WHICH modules are
  # in scope: an edge is followed only if its target's module made the
  # cut, with no separate hop limit here — a module that's in scope is
  # shown in full, however many function-call hops its own internal
  # structure spans.
  defp bfs([], _edges_by_from, _in_scope_modules, acc), do: acc

  defp bfs(frontier, edges_by_from, in_scope_modules, acc) do
    new_edges =
      frontier
      |> Enum.flat_map(fn n -> Map.get(edges_by_from, {n.module, n.function, n.arity}, []) end)
      |> Enum.uniq()
      |> Enum.reject(&MapSet.member?(acc.edge_set, &1))
      |> Enum.filter(&MapSet.member?(in_scope_modules, &1.to.module))

    acc = %{
      acc
      | edge_set: Enum.reduce(new_edges, acc.edge_set, &MapSet.put(&2, &1)),
        edge_list: acc.edge_list ++ new_edges
    }

    new_nodes =
      new_edges
      |> Enum.map(& &1.to)
      |> Enum.uniq()
      |> Enum.reject(&MapSet.member?(acc.node_set, &1))

    acc = %{
      acc
      | node_set: Enum.reduce(new_nodes, acc.node_set, &MapSet.put(&2, &1)),
        node_list: acc.node_list ++ new_nodes
    }

    next_frontier = Enum.reject(new_nodes, & &1.external)

    bfs(next_frontier, edges_by_from, in_scope_modules, acc)
  end

  defp resolve_edge(%Edge{} = edge, defined_functions) do
    to = edge.to
    external = not MapSet.member?(defined_functions, {to.module, to.function, to.arity})
    %{edge | from: %{edge.from | external: false}, to: %{to | external: external}}
  end
end
