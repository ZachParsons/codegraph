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

  test "project_graph accepts an absolute glob, ignoring cwd" do
    absolute_glob = Path.join(@fixtures, "*.ex")

    graph = Scope.project_graph([absolute_glob], "/nonexistent/cwd")

    b_step = Enum.find(graph.nodes, &(&1.module == B and &1.function == :step))
    assert b_step.external == false
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

  test "depth counts function-call hops, including hops that stay inside one module" do
    dir = Path.join(System.tmp_dir!(), "codegraph_scope_depth_#{System.unique_integer([:positive])}")
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
    # entry itself is level 0; step_a is one call away, past the depth-0
    # budget, even though it never leaves Root.
    refute Enum.any?(depth0.nodes, &(&1.module == Root and &1.function == :step_a))

    depth3 = Scope.scope(graph, [{:function, Root, :entry, 1}], 3)
    # Three calls (entry -> step_a -> step_b -> step_c) reaches step_c, each
    # one spending depth despite staying inside Root the whole way; level is
    # its own hop count, not a module-crossing count.
    step_c = Enum.find(depth3.nodes, &(&1.module == Root and &1.function == :step_c))
    assert step_c
    assert step_c.level == 3
    refute Enum.any?(depth3.nodes, &(&1.module == Other))

    depth4 = Scope.scope(graph, [{:function, Root, :entry, 1}], 4)
    other_leaf = Enum.find(depth4.nodes, &(&1.module == Other and &1.function == :leaf))
    assert other_leaf
    assert other_leaf.level == 4
  end

  test "module_depth independently caps modules crossed, without affecting level" do
    dir = Path.join(System.tmp_dir!(), "codegraph_scope_module_depth_#{System.unique_integer([:positive])}")
    File.mkdir_p!(dir)
    on_exit(fn -> File.rm_rf!(dir) end)

    File.write!(Path.join(dir, "root.ex"), """
    defmodule Root do
      def entry(x), do: A.step(x)
    end

    defmodule A do
      def step(x), do: B.step(x)
    end

    defmodule B do
      def step(x), do: x
    end
    """)

    graph = Scope.project_graph(["*.ex"], dir)

    # Plenty of function-call depth, but capped at 1 module crossing: A is
    # reached (entry -> A crosses one module), B is not (A -> B would be a
    # second crossing).
    scoped = Scope.scope(graph, [{:function, Root, :entry, 1}], 10, 1)
    a_step = Enum.find(scoped.nodes, &(&1.module == A and &1.function == :step))
    assert a_step
    # level is still the function-call hop count (1), not the module count.
    assert a_step.level == 1
    refute Enum.any?(scoped.nodes, &(&1.module == B))

    unbounded = Scope.scope(graph, [{:function, Root, :entry, 1}], 10, 2)
    assert Enum.any?(unbounded.nodes, &(&1.module == B and &1.function == :step))
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

  test "an external node isn't seeded as its own root just because it shares a root module's name" do
    dir = Path.join(System.tmp_dir!(), "codegraph_scope_external_root_#{System.unique_integer([:positive])}")
    File.mkdir_p!(dir)
    on_exit(fn -> File.rm_rf!(dir) end)

    # `helper(x)` is unqualified and never defined anywhere, so the
    # analyzer attributes the call to the enclosing module (Root) even
    # though it's really an unresolved external target — the same
    # misattribution real code hits for an unqualified builtin call like
    # `raise(...)` or `is_nil(...)`.
    File.write!(Path.join(dir, "root.ex"), """
    defmodule Root do
      def entry(x), do: helper(x)
    end
    """)

    graph = Scope.project_graph(["*.ex"], dir)
    scoped = Scope.scope(graph, [{:module, Root}], 5)

    entry = Enum.find(scoped.nodes, &(&1.module == Root and &1.function == :entry))
    helper = Enum.find(scoped.nodes, &(&1.module == Root and &1.function == :helper))
    assert entry.level == 0
    # helper/1 is external (never defined) and matches root module Root
    # by name, but it must only be reached as entry's callee (level 1),
    # never independently seeded as its own level-0 root.
    assert helper.external
    assert helper.level == 1
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
