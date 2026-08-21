defmodule Codegraph.Web.Router do
  use Phoenix.Router
  import Phoenix.LiveView.Router

  pipeline :browser do
    plug :accepts, ["html"]
    plug :fetch_session
    plug :fetch_live_flash
    plug :put_root_layout, html: {Codegraph.Web.Layouts, :root}
    plug :protect_from_forgery
    plug :no_store
  end

  scope "/", Codegraph.Web do
    pipe_through :browser

    live "/", GraphLive
  end

  # The dead-rendered page embeds a session token tied to this specific
  # server run; letting the browser cache and replay it (e.g. after a
  # restart) fails LiveView's session verification on WS connect.
  defp no_store(conn, _opts) do
    Plug.Conn.put_resp_header(conn, "cache-control", "no-store")
  end
end
