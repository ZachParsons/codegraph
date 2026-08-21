defmodule Codegraph.Web.GraphLive do
  use Phoenix.LiveView

  def mount(_params, _session, socket) do
    {:ok, assign(socket, :status, "analysis engine not yet implemented")}
  end

  def render(assigns) do
    ~H"""
    <div style="font-family: -apple-system, sans-serif; padding: 2rem;">
      <h1>codegraph</h1>
      <p>{@status}</p>
    </div>
    """
  end
end
