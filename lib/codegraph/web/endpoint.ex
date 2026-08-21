defmodule Codegraph.Web.Endpoint do
  use Phoenix.Endpoint, otp_app: :codegraph

  @session_options [
    store: :cookie,
    key: "_codegraph_key",
    signing_salt: "cg_sess",
    same_site: "Lax"
  ]

  socket "/live", Phoenix.LiveView.Socket,
    websocket: [connect_info: [session: @session_options]]

  plug Plug.Session, @session_options
  plug Codegraph.Web.Router
end
