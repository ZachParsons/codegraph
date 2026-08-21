defmodule Codegraph.GitSource do
  @moduledoc """
  Reads Elixir source as it existed at an arbitrary git ref, via `git
  ls-tree`/`git show` plumbing — no checkout, no compilation. Assumes `cwd`
  is inside the repository (paths from `git ls-tree` are already relative
  to the repo root, which is what `git show <ref>:<path>` expects).
  """

  @doc "List files matching `glob` (e.g. \"lib/**/*.ex\") as they exist at `ref`."
  @spec list_files(String.t(), String.t(), String.t()) :: [String.t()]
  def list_files(ref, glob, cwd \\ File.cwd!()) do
    case System.cmd("git", ["ls-tree", "-r", "--name-only", ref], cd: cwd, stderr_to_stdout: true) do
      {output, 0} ->
        regex = glob_to_regex(glob)
        output |> String.split("\n", trim: true) |> Enum.filter(&Regex.match?(regex, &1))

      {_error, _} ->
        []
    end
  end

  @doc "Read one file's content as it existed at `ref`."
  @spec read_file(String.t(), String.t(), String.t()) :: {:ok, String.t()} | :error
  def read_file(ref, path, cwd \\ File.cwd!()) do
    case System.cmd("git", ["show", "#{ref}:#{path}"], cd: cwd, stderr_to_stdout: false) do
      {content, 0} -> {:ok, content}
      {_error, _} -> :error
    end
  end

  # "**/" matches zero or more path segments (so "lib/**/*.ex" also matches
  # "lib/a.ex", not just "lib/sub/a.ex") — mirrors Path.wildcard's globstar
  # semantics, which a naive "**" -> ".*" substitution would get wrong.
  defp glob_to_regex(glob) do
    escaped =
      glob
      |> String.split(~r/(\*\*\/|\*\*|\*)/, include_captures: true)
      |> Enum.map(fn
        "**/" -> "(?:.*/)?"
        "**" -> ".*"
        "*" -> "[^/]*"
        other -> Regex.escape(other)
      end)
      |> Enum.join()

    Regex.compile!("^" <> escaped <> "$")
  end
end
