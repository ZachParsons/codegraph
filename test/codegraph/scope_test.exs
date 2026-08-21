defmodule Codegraph.ScopeTest do
  use ExUnit.Case, async: true

  alias Codegraph.Scope

  @fixtures Path.join(__DIR__, "../fixtures/scope_sample")

  test "project_graph resolves external vs in-project targets" do
    graph = Scope.project_graph(["*.ex"], @fixtures)

    b_step = Enum.find(graph.nodes, &(&1.module == B and &1.function == :step))
    enum_map = Enum.find(graph.nodes, &(&1.module == Enum and &1.function == :map))

    assert b_step.external == false
    assert enum_map.external == true
  end

  test "scope BFS respects depth and stops at external boundary nodes" do
    graph = Scope.project_graph(["*.ex"], @fixtures)

    depth0 = Scope.scope(graph, [A], 0)
    assert Enum.any?(depth0.nodes, &(&1.module == A and &1.function == :entry))
    assert depth0.edges == []

    depth1 = Scope.scope(graph, [A], 1)
    assert Enum.any?(depth1.nodes, &(&1.module == B and &1.function == :step))
    assert Enum.any?(depth1.nodes, &(&1.module == Enum and &1.function == :map and &1.external))
    refute Enum.any?(depth1.nodes, &(&1.module == C))

    depth2 = Scope.scope(graph, [A], 2)
    assert Enum.any?(depth2.nodes, &(&1.module == C and &1.function == :deep))
  end

  test "scope preserves call order through the BFS, not just at the analyzer" do
    dir = Path.join(System.tmp_dir!(), "codegraph_scope_order_#{System.unique_integer([:positive])}")
    File.mkdir_p!(dir)
    on_exit(fn -> File.rm_rf!(dir) end)

    File.write!(Path.join(dir, "root.ex"), """
    defmodule Root do
      def entry(x) do
        third(x)
        first(x)
        second(x)
      end

      def first(x), do: x
      def second(x), do: x
      def third(x), do: x
    end
    """)

    graph = Scope.project_graph(["*.ex"], dir)
    scoped = Scope.scope(graph, [Root], 1)

    order =
      scoped.edges
      |> Enum.filter(&(&1.from.function == :entry))
      |> Enum.map(& &1.to.function)

    assert order == [:third, :first, :second]
  end
end
