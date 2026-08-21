defmodule Codegraph.Diff do
  @moduledoc """
  Reconciles two `Codegraph.Graph`s (e.g. the same scoped component from
  `Codegraph.Scope.project_graph_at/3` at two different git refs) by exact
  `Module.function/arity` signature, per SPEC.md's "Diff view":

    - `:added`    — present in B, absent in A
    - `:removed`  — present in A, absent in B
    - `:modified` — present in both, but the function body hash differs
    - `:unchanged` — present in both, identical body hash

  Renames/arity changes are not linked (a changed arity is a remove + add).
  """

  alias Codegraph.Graph
  alias Codegraph.Graph.Node

  @spec diff(Graph.t(), Graph.t()) :: Graph.t()
  def diff(%Graph{} = graph_a, %Graph{} = graph_b) do
    a_by_key = index(graph_a.nodes)
    b_by_key = index(graph_b.nodes)
    keys = a_by_key |> Map.keys() |> Kernel.++(Map.keys(b_by_key)) |> Enum.uniq()

    nodes = Enum.map(keys, &diff_node(Map.get(a_by_key, &1), Map.get(b_by_key, &1)))
    nodes_by_key = index(nodes)

    a_edges = index_edges(graph_a.edges)
    b_edges = index_edges(graph_b.edges)
    edge_keys = a_edges |> Map.keys() |> Kernel.++(Map.keys(b_edges)) |> Enum.uniq()

    edges =
      Enum.map(edge_keys, fn {from_key, to_key} = key ->
        status =
          cond do
            not Map.has_key?(a_edges, key) -> :added
            not Map.has_key?(b_edges, key) -> :removed
            true -> :unchanged
          end

        template = Map.get(b_edges, key) || Map.get(a_edges, key)

        %{
          template
          | status: status,
            from: Map.get(nodes_by_key, from_key, template.from),
            to: Map.get(nodes_by_key, to_key, template.to)
        }
      end)

    %Graph{nodes: nodes, edges: edges}
  end

  defp diff_node(nil, b), do: %{b | status: :added}
  defp diff_node(a, nil), do: %{a | status: :removed}

  defp diff_node(a, b) do
    status =
      if is_integer(a.hash) and is_integer(b.hash) and a.hash != b.hash do
        :modified
      else
        :unchanged
      end

    %{b | status: status}
  end

  defp index(nodes), do: Map.new(nodes, &{node_key(&1), &1})
  defp index_edges(edges), do: Map.new(edges, &{{node_key(&1.from), node_key(&1.to)}, &1})
  defp node_key(%Node{module: m, function: f, arity: a}), do: {m, f, a}
end
