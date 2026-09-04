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

  test "a multi-clause function is one node, not one per clause" do
    graph =
      Analyzer.analyze_source("""
      defmodule Foo do
        def fmt(nil), do: "nil"
        def fmt(x) when is_integer(x), do: Integer.to_string(x)
        def fmt(_other), do: "?"
      end
      """)

    assert Enum.count(graph.nodes, &(&1.function == :fmt and &1.arity == 1)) == 1
  end

  test "tags def as public and defp as private" do
    graph =
      Analyzer.analyze_source("""
      defmodule Foo do
        def bar(x), do: x
        defp baz, do: :ok
      end
      """)

    bar = Enum.find(graph.nodes, &(&1.function == :bar))
    baz = Enum.find(graph.nodes, &(&1.function == :baz))
    assert bar.visibility == :public
    assert baz.visibility == :private
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

  test "skips macro-generated def/@spec heads (unquote(name)) instead of crashing" do
    graph =
      Analyzer.analyze_source("""
      defmodule Foo do
        for {name, value} <- [a: 1, b: 2] do
          @spec unquote(name)() :: unquote(value)
          def unquote(name)(), do: unquote(value)
        end

        def real(x), do: x
      end
      """)

    assert Enum.any?(graph.nodes, &(&1.module == Foo and &1.function == :real and &1.arity == 1))
  end

  test "edges preserve call order" do
    graph =
      Analyzer.analyze_source("""
      defmodule Foo do
        def a(x) do
          third(x)
          first(x)
          second(x)
        end

        def first(x), do: x
        def second(x), do: x
        def third(x), do: x
      end
      """)

    order =
      graph.edges
      |> Enum.filter(&(&1.from.function == :a))
      |> Enum.map(& &1.to.function)

    assert order == [:third, :first, :second]
  end

  test "resolves calls through a plain alias" do
    graph =
      Analyzer.analyze_source("""
      defmodule Foo do
        alias Foo.Bar

        def a(x), do: Bar.b(x)
      end
      """)

    assert Enum.any?(graph.edges, fn e -> e.to.module == Foo.Bar and e.to.function == :b end)
    refute Enum.any?(graph.edges, fn e -> e.to.module == Bar end)
  end

  test "resolves calls through an `as:` alias" do
    graph =
      Analyzer.analyze_source("""
      defmodule Foo do
        alias Foo.Bar, as: B

        def a(x), do: B.b(x)
      end
      """)

    assert Enum.any?(graph.edges, fn e -> e.to.module == Foo.Bar and e.to.function == :b end)
  end

  test "resolves calls through a multi-alias Mod.{A, B}" do
    graph =
      Analyzer.analyze_source("""
      defmodule Foo do
        alias Foo.{Bar, Baz}

        def a(x), do: Bar.b(x)
        def c(x), do: Baz.d(x)
      end
      """)

    assert Enum.any?(graph.edges, fn e -> e.to.module == Foo.Bar and e.to.function == :b end)
    assert Enum.any?(graph.edges, fn e -> e.to.module == Foo.Baz and e.to.function == :d end)
  end

  test "alias resolves a deeper reference, not just the aliased segment itself" do
    graph =
      Analyzer.analyze_source("""
      defmodule Foo do
        alias Foo.Topology

        def a(x), do: Topology.RateLimiter.b(x)
      end
      """)

    assert Enum.any?(graph.edges, fn e ->
             e.to.module == Foo.Topology.RateLimiter and e.to.function == :b
           end)
  end
end
