defmodule Codegraph.Graph do
  @moduledoc """
  The in-memory graph model produced by the analyzer and consumed by the
  LiveView UI: modules containing function nodes, connected by call edges.
  See SPEC.md ("Graph model") for the shape this is meant to hold.
  """

  defmodule Node do
    @moduledoc """
    A function node, or the module it belongs to (`function: nil`).

    `level` is `nil` until `Codegraph.Scope.scope/3` sets it: the number of
    *modules* (not function calls) between this node's module and the
    nearest root module, used by the UI to lay callers of the same module
    out at the same visual depth regardless of how many calls deep their
    own internal call structure goes.

    `visibility` is `:public` for a `def`, `:private` for a `defp`, and
    `nil` for a module node (`function: nil`) or an external one (never
    analyzed, so its own visibility is unknown).

    `stdlib` is true for an external node whose module resolves (via
    `Codegraph.Scope.stdlib_module?/1`) to the Erlang/OTP or Elixir
    installation itself, as opposed to a third-party dependency — the
    UI hides these by default, since a call like `Enum.map/2` is rarely
    the architectural insight this tool exists to surface. Always false
    for a node this tool actually analyzed (`external: false`).
    """
    defstruct [
      :module,
      :function,
      :arity,
      :external,
      :status,
      :hash,
      :params,
      :spec_args,
      :spec_return,
      :level,
      :visibility,
      stdlib: false
    ]

    @type t :: %__MODULE__{
            module: module() | String.t(),
            function: atom() | nil,
            arity: non_neg_integer() | nil,
            external: boolean(),
            status: :added | :removed | :modified | :unchanged,
            hash: integer() | nil,
            params: [String.t()] | nil,
            spec_args: [String.t()] | nil,
            spec_return: String.t() | nil,
            level: non_neg_integer() | nil,
            visibility: :public | :private | nil,
            stdlib: boolean()
          }
  end

  defmodule Edge do
    @moduledoc "A directed call edge between two fully-qualified function nodes."
    defstruct [:from, :to, :status, kind: :call]

    @type t :: %__MODULE__{
            from: Codegraph.Graph.Node.t(),
            to: Codegraph.Graph.Node.t(),
            status: :added | :removed | :unchanged,
            kind: :call | :caller
          }
  end

  defstruct nodes: [], edges: []

  @type t :: %__MODULE__{nodes: [Node.t()], edges: [Edge.t()]}
end
