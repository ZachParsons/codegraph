defmodule Mix.Tasks.Codegraph.Serve do
  @shortdoc "Starts the codegraph web UI"
  @moduledoc """
  Starts the codegraph web UI against the current project.

      mix codegraph.serve [--port 4444] [--path lib] \\
        [--root MyApp.Accounts] [--root MyApp.Billing] [--depth 2] \\
        [--diff BASE_REF..HEAD_REF]

  `--root` may be given multiple times to seed the BFS from several
  modules; omit it to render the whole project graph unscoped. `--depth`
  accepts an integer or `infinity`. `--path` is the directory to scan for
  `.ex` files (relative to the current project root); defaults to `lib`.
  `--diff` renders the diff between two git refs (e.g. `main..HEAD`)
  instead of the working tree.
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
        strict: [port: :integer, path: :string, root: :keep, depth: :string, diff: :string]
      )

    port = Keyword.get(opts, :port, 4444)
    path = Keyword.get(opts, :path, "lib")

    roots =
      opts
      |> Keyword.get_values(:root)
      |> Enum.map(&Module.concat([&1]))

    depth =
      case Keyword.get(opts, :depth, "2") do
        "infinity" -> :infinity
        n -> String.to_integer(n)
      end

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

    Application.put_env(:codegraph, :cli_opts,
      globs: [Path.join(path, "**/*.ex")],
      cwd: File.cwd!(),
      roots: roots,
      depth: depth,
      diff: diff
    )

    Application.put_env(:codegraph, Codegraph.Web.Endpoint,
      http: [ip: {127, 0, 0, 1}, port: port],
      url: [host: "localhost"],
      server: true,
      secret_key_base: Base.encode64(:crypto.strong_rand_bytes(48)),
      live_view: [signing_salt: Base.encode64(:crypto.strong_rand_bytes(8))],
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
end
