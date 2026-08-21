defmodule Codegraph.GitSourceTest do
  use ExUnit.Case, async: false

  alias Codegraph.{GitSource, Scope}

  setup do
    dir = Path.join(System.tmp_dir!(), "codegraph_git_test_#{System.unique_integer([:positive])}")
    File.mkdir_p!(Path.join(dir, "lib"))

    System.cmd("git", ["init", "-q"], cd: dir)
    System.cmd("git", ["config", "user.email", "test@example.com"], cd: dir)
    System.cmd("git", ["config", "user.name", "Test"], cd: dir)

    File.write!(Path.join(dir, "lib/a.ex"), """
    defmodule A do
      def one, do: :old
    end
    """)

    System.cmd("git", ["add", "."], cd: dir)
    System.cmd("git", ["commit", "-q", "-m", "first"], cd: dir)
    {first_sha, 0} = System.cmd("git", ["rev-parse", "HEAD"], cd: dir)
    first_sha = String.trim(first_sha)

    File.write!(Path.join(dir, "lib/a.ex"), """
    defmodule A do
      def one, do: :new
      def two, do: one()
    end
    """)

    System.cmd("git", ["add", "."], cd: dir)
    System.cmd("git", ["commit", "-q", "-m", "second"], cd: dir)

    on_exit(fn -> File.rm_rf!(dir) end)

    {:ok, dir: dir, first_sha: first_sha}
  end

  test "lists and reads files at an arbitrary ref", %{dir: dir, first_sha: first_sha} do
    files = GitSource.list_files(first_sha, "lib/**/*.ex", dir)
    assert files == ["lib/a.ex"]

    {:ok, content} = GitSource.read_file(first_sha, "lib/a.ex", dir)
    assert content =~ ":old"
  end

  test "project_graph_at reflects the ref, not the working tree", %{dir: dir, first_sha: first_sha} do
    old_graph = Scope.project_graph_at(first_sha, ["lib/**/*.ex"], dir)
    refute Enum.any?(old_graph.nodes, &(&1.module == A and &1.function == :two))

    new_graph = Scope.project_graph_at("HEAD", ["lib/**/*.ex"], dir)
    assert Enum.any?(new_graph.nodes, &(&1.module == A and &1.function == :two))
  end
end
