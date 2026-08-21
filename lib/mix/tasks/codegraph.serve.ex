defmodule Mix.Tasks.Codegraph.Serve do
  @shortdoc "Starts the codegraph web UI"
  @moduledoc """
  Starts the codegraph web UI against the current project.

      mix codegraph.serve [--port 4444]

  Analysis flags (--root, --depth, --diff) land here once the analyzer
  engine exists; for now this only boots the empty LiveView shell.
  """
  use Mix.Task

  @impl Mix.Task
  def run(args) do
    Mix.Task.run("app.start")

    {opts, _rest, _invalid} = OptionParser.parse(args, strict: [port: :integer])
    port = Keyword.get(opts, :port, 4444)

    Application.put_env(:codegraph, Codegraph.Web.Endpoint,
      http: [ip: {127, 0, 0, 1}, port: port],
      url: [host: "localhost"],
      server: true,
      secret_key_base: Base.encode64(:crypto.strong_rand_bytes(48)),
      live_view: [signing_salt: Base.encode64(:crypto.strong_rand_bytes(8))],
      pubsub_server: Codegraph.Web.PubSub,
      check_origin: false,
      adapter: Bandit.PhoenixAdapter
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
