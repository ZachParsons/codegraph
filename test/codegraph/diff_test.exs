defmodule Codegraph.DiffTest do
  use ExUnit.Case, async: true

  alias Codegraph.{Analyzer, Diff}

  test "classifies added, removed, modified, unchanged" do
    a =
      Analyzer.analyze_source("""
      defmodule A do
        def keep, do: :same
        def changed, do: :old
        def gone, do: :bye
      end
      """)

    b =
      Analyzer.analyze_source("""
      defmodule A do
        def keep, do: :same
        def changed, do: :new
        def fresh, do: :hi
      end
      """)

    graph = Diff.diff(a, b)
    by_fun = Map.new(graph.nodes, &{&1.function, &1})

    assert by_fun[:keep].status == :unchanged
    assert by_fun[:changed].status == :modified
    assert by_fun[:gone].status == :removed
    assert by_fun[:fresh].status == :added
  end

  test "classifies edges as added/removed/unchanged" do
    a =
      Analyzer.analyze_source("""
      defmodule A do
        def entry, do: old()
        defp old, do: :ok
      end
      """)

    b =
      Analyzer.analyze_source("""
      defmodule A do
        def entry, do: new()
        defp new, do: :ok
      end
      """)

    graph = Diff.diff(a, b)

    assert Enum.any?(graph.edges, fn e -> e.to.function == :new and e.status == :added end)
    assert Enum.any?(graph.edges, fn e -> e.to.function == :old and e.status == :removed end)
  end
end
