defmodule Codegraph.Web.GraphLive do
  use Phoenix.LiveView

  alias Codegraph.{Diff, Scope}

  def mount(_params, _session, socket) do
    opts = Application.get_env(:codegraph, :cli_opts, [])
    globs = Keyword.get(opts, :globs, ["lib/**/*.ex"])
    cwd = Keyword.get(opts, :cwd, File.cwd!())
    roots = Keyword.get(opts, :roots, [])
    depth = Keyword.get(opts, :depth, 2)
    diff = Keyword.get(opts, :diff)

    graph = build_graph(diff, globs, cwd, roots, depth)

    graph_json =
      Jason.encode!(%{
        nodes: Enum.map(graph.nodes, &node_json/1),
        edges: Enum.map(graph.edges, &edge_json/1)
      })

    {:ok,
     assign(socket,
       graph_json: graph_json,
       node_count: length(graph.nodes),
       edge_count: length(graph.edges),
       roots: roots,
       diff: diff
     )}
  end

  defp build_graph(nil, globs, cwd, roots, depth) do
    project = Scope.project_graph(globs, cwd)
    scoped(project, roots, depth)
  end

  defp build_graph({ref_a, ref_b}, globs, cwd, roots, depth) do
    graph_a = Scope.project_graph_at(ref_a, globs, cwd) |> scoped(roots, depth)
    graph_b = Scope.project_graph_at(ref_b, globs, cwd) |> scoped(roots, depth)
    Diff.diff(graph_a, graph_b)
  end

  defp scoped(project, [], _depth), do: project
  defp scoped(project, roots, depth), do: Scope.scope(project, roots, depth)

  def render(assigns) do
    ~H"""
    <div style="font-family: -apple-system, sans-serif; color: #eee; background: #0b0b0f; min-height: 100vh; margin: 0;">
      <header style="padding: 1rem 1.5rem; border-bottom: 1px solid #222;">
        <h1 style="margin: 0 0 0.25rem; font-size: 1.25rem;">codegraph</h1>
        <p style="opacity: 0.6; margin: 0; font-size: 0.85rem;">
          {@node_count} nodes, {@edge_count} edges
          <%= if @roots != [] do %>
            &middot; root: {Enum.map_join(@roots, ", ", &inspect/1)}
          <% end %>
          <%= if @diff do %>
            &middot; diff: {elem(@diff, 0)}..{elem(@diff, 1)}
          <% end %>
        </p>
        <div :if={@diff} style="display: flex; gap: 1rem; margin-top: 0.5rem; font-size: 0.8rem;">
          <span><span style={legend_dot("#3fb950")}></span> added</span>
          <span><span style={legend_dot("#f85149")}></span> removed</span>
          <span><span style={legend_dot("#d29922")}></span> modified</span>
        </div>
      </header>
      <div id="graph" phx-hook="GraphViz" phx-update="ignore" data-graph={@graph_json}></div>
    </div>
    """
  end

  defp legend_dot(color) do
    "display:inline-block; width:9px; height:9px; border-radius:50%; background:#{color}; margin-right:4px;"
  end

  defp node_json(n) do
    %{
      module: inspect(n.module),
      function: n.function,
      arity: n.arity,
      external: n.external,
      status: n.status,
      params: n.params,
      spec_args: n.spec_args,
      spec_return: n.spec_return
    }
  end

  defp edge_json(e) do
    %{from: node_json(e.from), to: node_json(e.to), status: e.status}
  end
end
