defmodule Codegraph.AnalyzerTest do
  use ExUnit.Case, async: true

  alias Codegraph.Analyzer

  test "finds modules and functions" do
    graph =
      Analyzer.analyze_source("""
      defmodule Foo do
        def bar(x), do: x
        defp baz, do: :ok
      end
      """)

    assert Enum.any?(graph.nodes, &(&1.module == Foo and is_nil(&1.function)))
    assert Enum.any?(graph.nodes, &(&1.module == Foo and &1.function == :bar and &1.arity == 1))
    assert Enum.any?(graph.nodes, &(&1.module == Foo and &1.function == :baz and &1.arity == 0))
  end

  test "finds local calls (parenthesized only)" do
    graph =
      Analyzer.analyze_source("""
      defmodule Foo do
        def a(x), do: b(x)
        def b(x), do: x
      end
      """)

    assert Enum.any?(graph.edges, fn e ->
             e.from.function == :a and e.from.arity == 1 and
               e.to.module == Foo and e.to.function == :b and e.to.arity == 1
           end)
  end

  test "finds remote calls" do
    graph =
      Analyzer.analyze_source("""
      defmodule Foo do
        def a(x), do: Enum.map(x, & &1)
      end
      """)

    assert Enum.any?(graph.edges, fn e -> e.to.module == Enum and e.to.function == :map and e.to.arity == 2 end)
  end

  test "pipe adjusts callee arity by one" do
    graph =
      Analyzer.analyze_source("""
      defmodule Foo do
        def a(x), do: x |> Enum.map(& &1) |> Enum.sort()
      end
      """)

    assert Enum.any?(graph.edges, fn e -> e.to.module == Enum and e.to.function == :map and e.to.arity == 2 end)
    assert Enum.any?(graph.edges, fn e -> e.to.module == Enum and e.to.function == :sort and e.to.arity == 1 end)
  end

  test "skips special forms as calls" do
    graph =
      Analyzer.analyze_source("""
      defmodule Foo do
        def a(x) do
          if x do
            :ok
          else
            :no
          end
        end
      end
      """)

    refute Enum.any?(graph.edges, fn e -> e.to.function == :if end)
  end

  test "captures parameter names from the def head" do
    graph =
      Analyzer.analyze_source("""
      defmodule Foo do
        def handle(message, %{status: status} = state), do: {message, status, state}
        def zero, do: :ok
      end
      """)

    handle = Enum.find(graph.nodes, &(&1.function == :handle))
    assert handle.params == ["message", "%{status: status} = state"]

    zero = Enum.find(graph.nodes, &(&1.function == :zero))
    assert zero.params == []
  end

  test "attaches a @spec to its matching function regardless of source order" do
    graph =
      Analyzer.analyze_source("""
      defmodule Foo do
        @spec before_def(integer()) :: boolean()
        def before_def(x), do: x > 0

        def after_def(x), do: x
        @spec after_def(String.t()) :: :ok
      end
      """)

    before_def = Enum.find(graph.nodes, &(&1.function == :before_def))
    assert before_def.spec_args == ["integer()"]
    assert before_def.spec_return == "boolean()"

    after_def = Enum.find(graph.nodes, &(&1.function == :after_def))
    assert after_def.spec_args == ["String.t()"]
    assert after_def.spec_return == ":ok"
  end

  test "functions without a @spec have nil spec fields" do
    graph =
      Analyzer.analyze_source("""
      defmodule Foo do
        def unspecced(x), do: x
      end
      """)

    node = Enum.find(graph.nodes, &(&1.function == :unspecced))
    assert node.spec_args == nil
    assert node.spec_return == nil
  end
end
