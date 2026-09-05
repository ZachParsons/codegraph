defmodule Mix.Tasks.CodegraphTest do
  use ExUnit.Case, async: false

  alias Mix.Tasks.Codegraph

  # These pin the CLI's argument-parsing behavior directly, without
  # booting the endpoint via `run/1` — that's the only untested layer
  # before this, since everything downstream (Scope, Diff, GitSource)
  # already has its own tests.

  test "parse_root treats a trailing /arity as a function root, otherwise a module root" do
    assert Codegraph.parse_root("MyApp.Accounts") == {:module, MyApp.Accounts}

    assert Codegraph.parse_root("MyApp.Accounts.create_user/1") ==
             {:function, MyApp.Accounts, :create_user, 1}
  end

  test "parse_depth accepts \"infinity\" or an integer string" do
    assert Codegraph.parse_depth("infinity") == :infinity
    assert Codegraph.parse_depth("3") == 3
  end

  test "diff_root resolves --path to its git toplevel and a path relative to it" do
    unresolved =
      Path.join(
        System.tmp_dir!(),
        "codegraph_cli_diff_root_#{System.unique_integer([:positive])}"
      )

    File.mkdir_p!(unresolved)
    on_exit(fn -> File.rm_rf!(unresolved) end)
    # Resolve symlinks up front (macOS's /tmp is one) so this compares
    # against the same real path `git rev-parse --show-toplevel` returns,
    # rather than against the edge case of a symlinked --path.
    {dir, 0} = System.cmd("pwd", ["-P"], cd: unresolved)
    dir = String.trim(dir)

    File.mkdir_p!(Path.join(dir, "lib"))
    System.cmd("git", ["init", "-q"], cd: dir)

    {root, glob_path} = Codegraph.diff_root(Path.join(dir, "lib"))

    assert root == dir
    assert glob_path == "lib"
  end

  test "diff_root raises when --path is outside any git repository" do
    dir =
      Path.join(
        System.tmp_dir!(),
        "codegraph_cli_diff_root_no_git_#{System.unique_integer([:positive])}"
      )

    File.mkdir_p!(dir)
    on_exit(fn -> File.rm_rf!(dir) end)

    assert_raise Mix.Error, ~r/--diff requires --path/, fn ->
      Codegraph.diff_root(dir)
    end
  end
end
