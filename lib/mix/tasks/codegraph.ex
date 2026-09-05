defmodule Mix.Tasks.Codegraph do
  @shortdoc "Starts the codegraph web UI"
  @moduledoc """
  Starts the codegraph web UI against the current project.

      mix codegraph [--port 4444] [--path lib] \\
        [--root MyApp.Accounts] [--root MyApp.Billing.create_invoice/2] \\
        [--fdepth 2] [--mdepth infinity] [--diff BASE_REF..HEAD_REF]

  `--root` may be given multiple times to seed the BFS from several roots,
  and each one is either a module (`MyApp.Accounts`, seeds from every
  function it defines) or one specific function (`MyApp.Accounts.
  create_user/1` — the trailing `/N` arity is what marks it as a function
  rather than a module). Omit `--root` entirely to render the whole
  project graph unscoped. `--fdepth` (function-call hops away from the
  root(s); each row in the graph is one hop, including calls that stay
  inside the same module) and `--mdepth` (distinct modules crossed
  on a given path — a call that stays in the current module is free) each
  accept an integer or `infinity`, and bound the walk independently:
  `--fdepth` defaults to `2`, `--mdepth` defaults to `infinity` (no
  extra cap beyond `--fdepth` itself). `--path` is the directory to scan
  for `.ex` files; defaults to `lib`,
  relative to the current project root. It may also be an absolute path
  (or a relative one that escapes the current project, e.g. `../other-
  lib/lib`) to graph another package's source directly, without adding
  codegraph as a dependency there — analysis is pure static parsing, so
  the target package need not be fetched, compiled, or even be a Mix
  project. The scan is recursive under `--path`, but `deps/` and
  `_build/` are always excluded even if they fall underneath it — so
  pointing `--path` at a whole package root (rather than just its `lib/`)
  is safe and won't pull in vendored dependency source. `--diff` renders
  the diff between two git refs (e.g. `main..HEAD`) instead of the
  working tree — it walks git history via `--path`'s own repository
  (found via `git rev-parse --show-toplevel`, so `--path` may still be
  absolute or escape the current project) rather than the filesystem, so
  the refs must exist in THAT repo, not necessarily the one `mix
  codegraph` was invoked from.
  """
  use Mix.Task

  @impl Mix.Task
  def run(args) do
    Mix.Task.run("app.start")

    # codegraph is meant to be added with `runtime: false` (it's a dev
    # tool, not something the host app should boot on its own), which
    # means `app.start` above deliberately does NOT start :codegraph or
    # its own deps (:phoenix, :phoenix_pubsub, :bandit, ...) — we have to
    # start them ourselves.
    {:ok, _} = Application.ensure_all_started(:codegraph)

    {opts, _rest, _invalid} =
      OptionParser.parse(args,
        strict: [
          port: :integer,
          path: :string,
          root: :keep,
          fdepth: :string,
          mdepth: :string,
          diff: :string
        ]
      )

    port = Keyword.get(opts, :port, 4444)
    path = Keyword.get(opts, :path, "lib")

    roots =
      opts
      |> Keyword.get_values(:root)
      |> Enum.map(&parse_root/1)

    depth = parse_depth(Keyword.get(opts, :fdepth, "2"))
    module_depth = parse_depth(Keyword.get(opts, :mdepth, "infinity"))

    diff =
      case Keyword.get(opts, :diff) do
        nil ->
          nil

        spec ->
          case String.split(spec, "..", parts: 2) do
            [ref_a, ref_b] -> {ref_a, ref_b}
            _ -> Mix.raise("--diff expects BASE_REF..HEAD_REF, got: #{inspect(spec)}")
          end
      end

    {cwd, glob_path} = if diff, do: diff_root(path), else: {File.cwd!(), path}

    Application.put_env(:codegraph, :cli_opts,
      globs: [Path.join(glob_path, "**/*.ex")],
      cwd: cwd,
      roots: roots,
      depth: depth,
      module_depth: module_depth,
      diff: diff
    )

    # Fixed (not per-run-random) secret: this is a localhost-only dev tool
    # with no real auth boundary, and a random secret means any cached or
    # reloaded copy of the page — which embeds a session token signed by
    # *some* run's secret — fails LiveView's session verification against
    # whichever instance is currently serving it, which is exactly what
    # produced the reported crash-and-reload loop.
    Application.put_env(:codegraph, Codegraph.Web.Endpoint,
      http: [ip: {127, 0, 0, 1}, port: port],
      url: [host: "localhost"],
      server: true,
      secret_key_base: String.duplicate("codegraph-dev-secret-", 4),
      live_view: [signing_salt: "codegraph-live-view-salt"],
      pubsub_server: Codegraph.Web.PubSub,
      check_origin: false,
      adapter: Bandit.PhoenixAdapter,
      render_errors: [formats: [html: Codegraph.Web.ErrorHTML], layout: false]
    )

    children = [
      {Phoenix.PubSub, name: Codegraph.Web.PubSub},
      Codegraph.Web.Endpoint
    ]

    {:ok, _pid} = Supervisor.start_link(children, strategy: :one_for_one, name: Codegraph.Supervisor)

    Mix.shell().info("codegraph listening on http://localhost:#{port}")
    Process.sleep(:infinity)
  end

  # Public (not `defp`) so a test can pin the parsing behavior directly,
  # without booting the endpoint via `run/1`. Not part of the CLI's own
  # public contract, hence `@doc false`.
  @doc false
  def parse_depth("infinity"), do: :infinity
  def parse_depth(n), do: String.to_integer(n)

  # `--diff` walks git history via `Codegraph.GitSource`, which shells out
  # `git ls-tree`/`git show` from a `cwd` those commands expect to already
  # be inside the target repo. Resolving that `cwd` from `--path` itself
  # (via `git rev-parse --show-toplevel`, same as everywhere else in
  # `--path`'s handling: `path` may be absolute, or a relative one that
  # escapes the current project) — rather than assuming `File.cwd!()` IS
  # that repo — means `mix codegraph --diff` can point at any git repo's
  # source from anywhere, not just when invoked from inside that repo.
  # `path` itself doesn't move: it's rewritten to be relative to the
  # resolved root, since that's what `git show <ref>:<path>` expects.
  @doc false
  def diff_root(path) do
    expanded = Path.expand(path)

    case System.cmd("git", ["rev-parse", "--show-toplevel"], cd: expanded, stderr_to_stdout: true) do
      {root, 0} ->
        root = String.trim(root)
        {root, Path.relative_to(expanded, root)}

      {error, _} ->
        Mix.raise("--diff requires --path (#{path}) to be inside a git repository: #{error}")
    end
  end

  # A trailing "/N" (digits only) is treated as an arity, marking this
  # root as one specific function rather than a whole module — module
  # names can't end in "/N", so there's no ambiguity to resolve.
  @root_function_pattern ~r/^(.+)\.([^.\/]+)\/(\d+)$/

  @doc false
  def parse_root(str) do
    case Regex.run(@root_function_pattern, str) do
      [_, mod_str, fun_str, arity_str] ->
        {:function, Module.concat([mod_str]), String.to_atom(fun_str), String.to_integer(arity_str)}

      nil ->
        {:module, Module.concat([str])}
    end
  end
end
