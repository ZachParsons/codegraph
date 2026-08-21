defmodule Codegraph.Scope do
  @moduledoc """
  Merges per-file `Codegraph.Graph`s into one project-wide graph (resolving
  which call targets are "in scope" i.e. defined somewhere in the project,
  vs. external boundary nodes), then does a breadth-first walk outward from
  a set of root modules to produce the subgraph actually shown to the user.

  Only outgoing (caller -> callee) edges are followed for v1; external
  boundary nodes are natural BFS leaves since we never analyzed their
  bodies, so they have no outgoing edges to expand into.
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
  BFS from `roots` out to `depth` hops (non-negative integer, or
  `:infinity` for the full transitive closure). Each root is either
  `{:module, Mod}` (seeds from every function `Mod` defines) or
  `{:function, Mod, name, arity}` (seeds from just that one function).

  Preserves call order (the order edges were found in the source, already
  preserved through `project_graph/2`'s merge) in the returned edges/nodes,
  rather than the unspecified order a MapSet would give — this is what
  lets the UI lay out sibling nodes left-to-right in call order instead of
  an arbitrary one.
  """
  @spec scope(Graph.t(), [root()], non_neg_integer() | :infinity) :: Graph.t()
  def scope(%Graph{} = graph, roots, depth \\ 2) do
    root_modules = roots |> Enum.map(&root_module/1) |> MapSet.new()

    edges_by_from =
      Enum.group_by(graph.edges, fn e -> {e.from.module, e.from.function, e.from.arity} end)

    start = Enum.filter(graph.nodes, fn n -> n.function != nil and matches_root?(n, roots) end)

    acc = %{node_set: MapSet.new(start), node_list: start, edge_set: MapSet.new(), edge_list: []}
    acc = bfs(start, edges_by_from, depth, acc)

    module_nodes =
      Enum.filter(graph.nodes, fn n -> is_nil(n.function) and MapSet.member?(root_modules, n.module) end)

    %Graph{
      nodes: Enum.uniq(acc.node_list ++ module_nodes),
      edges: acc.edge_list
    }
  end

  defp root_module({:module, mod}), do: mod
  defp root_module({:function, mod, _name, _arity}), do: mod

  defp matches_root?(node, roots) do
    Enum.any?(roots, fn
      {:module, mod} -> node.module == mod
      {:function, mod, name, arity} -> node.module == mod and node.function == name and node.arity == arity
    end)
  end

  defp bfs(_frontier, _edges_by_from, depth, acc) when depth < 0, do: acc
  defp bfs([], _edges_by_from, _depth, acc), do: acc
  defp bfs(_frontier, _edges_by_from, 0, acc), do: acc

  defp bfs(frontier, edges_by_from, depth, acc) do
    new_edges =
      frontier
      |> Enum.flat_map(fn n -> Map.get(edges_by_from, {n.module, n.function, n.arity}, []) end)
      |> Enum.uniq()
      |> Enum.reject(&MapSet.member?(acc.edge_set, &1))

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
    next_depth = if depth == :infinity, do: :infinity, else: depth - 1

    bfs(next_frontier, edges_by_from, next_depth, acc)
  end

  defp resolve_edge(%Edge{} = edge, defined_functions) do
    to = edge.to
    external = not MapSet.member?(defined_functions, {to.module, to.function, to.arity})
    %{edge | from: %{edge.from | external: false}, to: %{to | external: external}}
  end
end
