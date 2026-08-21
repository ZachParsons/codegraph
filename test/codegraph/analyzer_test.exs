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
end
