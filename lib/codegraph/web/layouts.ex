defmodule Codegraph.Web.Layouts do
  use Phoenix.Component

  def root(assigns) do
    ~H"""
    <!DOCTYPE html>
    <html lang="en">
      <head>
        <meta charset="utf-8" />
        <meta name="viewport" content="width=device-width, initial-scale=1.0" />
        <meta name="csrf-token" content={Plug.CSRFProtection.get_csrf_token()} />
        <title>codegraph</title>
        <script defer src="/vendor/phoenix.js">
        </script>
        <script defer src="/vendor/phoenix_live_view.js">
        </script>
        <script defer src="/vendor/d3.min.js">
        </script>
        <script defer src="/vendor/d3-dag.min.js">
        </script>
        <script defer src="/js/graph_hook.js">
        </script>
        <script defer src="/js/app.js">
        </script>
      </head>
      <body>
        {@inner_content}
      </body>
    </html>
    """
  end
end
