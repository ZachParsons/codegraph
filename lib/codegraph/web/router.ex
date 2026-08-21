defmodule Codegraph.Web.Router do
  use Phoenix.Router
  import Phoenix.LiveView.Router

  pipeline :browser do
    plug :accepts, ["html"]
    plug :fetch_session
    plug :fetch_live_flash
  end

  scope "/", Codegraph.Web do
    pipe_through :browser

    live "/", GraphLive
  end
end
