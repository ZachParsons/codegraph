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

    depth0 = Scope.scope(graph, [{:module, A}], 0)
    assert Enum.any?(depth0.nodes, &(&1.module == A and &1.function == :entry))
    assert depth0.edges == []

    depth1 = Scope.scope(graph, [{:module, A}], 1)
    assert Enum.any?(depth1.nodes, &(&1.module == B and &1.function == :step))
    assert Enum.any?(depth1.nodes, &(&1.module == Enum and &1.function == :map and &1.external))
    refute Enum.any?(depth1.nodes, &(&1.module == C))

    depth2 = Scope.scope(graph, [{:module, A}], 2)
    assert Enum.any?(depth2.nodes, &(&1.module == C and &1.function == :deep))
  end

  test "depth counts modules, not function calls: an intra-module chain costs nothing" do
    dir = Path.join(System.tmp_dir!(), "codegraph_scope_module_depth_#{System.unique_integer([:positive])}")
    File.mkdir_p!(dir)
    on_exit(fn -> File.rm_rf!(dir) end)

    File.write!(Path.join(dir, "root.ex"), """
    defmodule Root do
      def entry(x) do
        step_a(x)
      end

      def step_a(x), do: step_b(x)
      def step_b(x), do: step_c(x)
      def step_c(x), do: Other.leaf(x)
    end

    defmodule Other do
      def leaf(x), do: x
    end
    """)

    graph = Scope.project_graph(["*.ex"], dir)

    depth0 = Scope.scope(graph, [{:function, Root, :entry, 1}], 0)
    # Every function of Root is reachable purely through same-module calls,
    # so all of it is included at depth 0 despite being 3 calls deep.
    assert Enum.any?(depth0.nodes, &(&1.module == Root and &1.function == :step_c))
    refute Enum.any?(depth0.nodes, &(&1.module == Other))
    assert Enum.all?(depth0.nodes, &(&1.level == 0))

    depth1 = Scope.scope(graph, [{:function, Root, :entry, 1}], 1)
    other_leaf = Enum.find(depth1.nodes, &(&1.module == Other and &1.function == :leaf))
    assert other_leaf
    assert other_leaf.level == 1
  end

  test "a function root seeds from just that function, not the whole module" do
    graph = Scope.project_graph(["*.ex"], @fixtures)

    scoped = Scope.scope(graph, [{:function, A, :entry, 1}], 1)
    assert Enum.any?(scoped.nodes, &(&1.module == A and &1.function == :entry))
    assert Enum.any?(scoped.nodes, &(&1.module == B and &1.function == :step))
  end

  test "scope includes the root's own immediate callers, tagged kind: :caller" do
    graph = Scope.project_graph(["*.ex"], @fixtures)

    scoped = Scope.scope(graph, [{:module, B}], 0)

    assert Enum.any?(scoped.nodes, &(&1.module == A and &1.function == :entry))

    caller_edge =
      Enum.find(scoped.edges, &(&1.kind == :caller and &1.to.module == B and &1.to.function == :step))

    assert caller_edge
    assert caller_edge.from.module == A
    assert caller_edge.from.function == :entry
  end

  test "a root with no callers gets no caller edges" do
    graph = Scope.project_graph(["*.ex"], @fixtures)

    scoped = Scope.scope(graph, [{:module, A}], 0)

    refute Enum.any?(scoped.edges, &(&1.kind == :caller))
  end

  test "callers are only one generation deep, and one that's already in the downward scope is not duplicated as a caller" do
    dir = Path.join(System.tmp_dir!(), "codegraph_scope_callers_#{System.unique_integer([:positive])}")
    File.mkdir_p!(dir)
    on_exit(fn -> File.rm_rf!(dir) end)

    File.write!(Path.join(dir, "root.ex"), """
    defmodule Root do
      def entry(x) do
        Root.helper(x)
      end

      def helper(x), do: x
    end

    defmodule Outer do
      def calls_entry(x), do: Root.entry(x)
    end

    defmodule Grandcaller do
      def calls_outer(x), do: Outer.calls_entry(x)
    end
    """)

    graph = Scope.project_graph(["*.ex"], dir)
    scoped = Scope.scope(graph, [{:function, Root, :entry, 1}], 2)

    # Outer.calls_entry is a genuine one-hop caller of the root.
    assert Enum.any?(scoped.edges, fn e ->
             e.kind == :caller and e.from.module == Outer and e.from.function == :calls_entry
           end)

    # Grandcaller only calls a caller, not the root itself — one generation only.
    refute Enum.any?(scoped.edges, fn e -> e.kind == :caller and e.from.module == Grandcaller end)

    # Root.helper is already reachable downward from the root; it isn't
    # also a caller of Root.entry here, but confirm caller edges never
    # duplicate a node that the downward BFS already placed.
    downward_ids =
      scoped.edges
      |> Enum.reject(&(&1.kind == :caller))
      |> Enum.map(&{&1.to.module, &1.to.function, &1.to.arity})
      |> MapSet.new()

    caller_ids =
      scoped.edges
      |> Enum.filter(&(&1.kind == :caller))
      |> Enum.map(&{&1.from.module, &1.from.function, &1.from.arity})
      |> MapSet.new()

    assert MapSet.disjoint?(downward_ids, caller_ids)
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
    scoped = Scope.scope(graph, [{:module, Root}], 1)

    order =
      scoped.edges
      |> Enum.filter(&(&1.from.function == :entry))
      |> Enum.map(& &1.to.function)

    assert order == [:third, :first, :second]
  end
end
