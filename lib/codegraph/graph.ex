defmodule Codegraph.Graph do
  @moduledoc """
  The in-memory graph model produced by the analyzer and consumed by the
  LiveView UI: modules containing function nodes, connected by call edges.
  See SPEC.md ("Graph model") for the shape this is meant to hold.
  """

  defmodule Node do
    @moduledoc "A function node, or the module it belongs to (`function: nil`)."
    defstruct [:module, :function, :arity, :external, :status, :hash]

    @type t :: %__MODULE__{
            module: module() | String.t(),
            function: atom() | nil,
            arity: non_neg_integer() | nil,
            external: boolean(),
            status: :added | :removed | :modified | :unchanged,
            hash: integer() | nil
          }
  end

  defmodule Edge do
    @moduledoc "A directed call edge between two fully-qualified function nodes."
    defstruct [:from, :to, :status]

    @type t :: %__MODULE__{
            from: Codegraph.Graph.Node.t(),
            to: Codegraph.Graph.Node.t(),
            status: :added | :removed | :unchanged
          }
  end

  defstruct nodes: [], edges: []

  @type t :: %__MODULE__{nodes: [Node.t()], edges: [Edge.t()]}
end
