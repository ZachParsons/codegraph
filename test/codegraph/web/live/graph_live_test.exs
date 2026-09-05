defmodule Codegraph.Web.GraphLiveTest do
  use ExUnit.Case, async: false

  alias Codegraph.Web.GraphLive

  # `mount/3` is the one place that wires Scope's graph together with the
  # JSON payload the browser's D3 rendering depends on. This doesn't drive
  # a real LiveView connection (no endpoint/router needed for that) — it
  # just pins that shape, so a change to node/edge fields or to the
  # cli_opts contract shows up here instead of only in the browser.

  @fixtures Path.join(__DIR__, "../../../fixtures/scope_sample")

  setup do
    previous = Application.get_env(:codegraph, :cli_opts)
    on_exit(fn -> Application.put_env(:codegraph, :cli_opts, previous) end)
  end

  test "mount builds the whole-project graph and assigns its JSON" do
    Application.put_env(:codegraph, :cli_opts,
      globs: ["*.ex"],
      cwd: @fixtures,
      roots: [],
      depth: 2,
      module_depth: :infinity,
      diff: nil
    )

    assert {:ok, socket} = GraphLive.mount(%{}, %{}, %Phoenix.LiveView.Socket{})

    assert socket.assigns.roots == []
    assert socket.assigns.diff == nil
    assert socket.assigns.node_count > 0
    assert socket.assigns.edge_count > 0

    assert %{"nodes" => nodes, "edges" => edges} = Jason.decode!(socket.assigns.graph_json)
    assert length(nodes) == socket.assigns.node_count
    assert length(edges) == socket.assigns.edge_count
    assert Enum.any?(nodes, &(&1["module"] == "B" and &1["function"] == "step"))
  end

  test "mount scopes the graph to --root when one is given" do
    Application.put_env(:codegraph, :cli_opts,
      globs: ["*.ex"],
      cwd: @fixtures,
      roots: [{:module, A}],
      depth: 0,
      module_depth: :infinity,
      diff: nil
    )

    assert {:ok, socket} = GraphLive.mount(%{}, %{}, %Phoenix.LiveView.Socket{})

    assert socket.assigns.roots == [{:module, A}]
    assert %{"nodes" => nodes} = Jason.decode!(socket.assigns.graph_json)
    assert Enum.any?(nodes, &(&1["module"] == "A" and &1["function"] == "entry"))
    refute Enum.any?(nodes, &(&1["module"] == "C"))
  end
end
