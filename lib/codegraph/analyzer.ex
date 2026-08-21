defmodule Codegraph.Analyzer do
  @moduledoc """
  Parses Elixir source (via `Code.string_to_quoted!/2`, no compilation) into
  a `Codegraph.Graph`: modules, their `def`/`defp` functions, and the calls
  made from each function body.

  This is a best-effort static walk, not a full compiler:
    - Local calls are only recognized when parenthesized (`foo(x)`), since
      `foo` alone is ambiguous with a variable reference in the raw AST.
    - `alias` (plain, `as:`, and multi-alias `Mod.{A, B}` forms) is tracked
      per module, module-wide regardless of where it's declared (same
      approximation as @spec below) — but only within the same file. An
      alias declared in one file has no effect on a call to that alias'
      name written in a *different* file, since each file is analyzed
      independently with no cross-file symbol table.
    - Calls through captures (`&Mod.fun/1`), `apply/3`, or dynamically
      built module names are not resolved.
  These gaps are acceptable for a call-graph visualization: unresolved or
  misattributed edges are rare in idiomatic code and don't block the tool
  from being useful.
  """

  alias Codegraph.Graph
  alias Codegraph.Graph.{Node, Edge}

  @skip_words ~w(
    def defp defmodule defmacro defmacrop defprotocol defimpl defdelegate
    defexception defstruct defguard defguardp defoverridable defrecord
    if unless case cond for with try receive fn quote unquote unquote_splicing
    import alias require use super __block__ __aliases__ when
  )a

  # Operators/syntax nodes that are shaped like calls in the raw AST but
  # aren't meaningful "calls" for a call-graph visualization.
  @skip_operators [
    :&,
    :/,
    :.,
    :%,
    :%{},
    :{},
    :<<>>,
    :=,
    :<-,
    :"\\",
    :^,
    :|,
    :..,
    :...,
    :->,
    :"::",
    :"~",
    :"@",
    :+,
    :-,
    :*,
    :++,
    :--,
    :==,
    :!=,
    :===,
    :!==,
    :<,
    :>,
    :<=,
    :>=,
    :&&,
    :||,
    :!,
    :and,
    :or,
    :not,
    :in,
    :<>
  ]

  @skip_call_heads @skip_words ++ @skip_operators

  @doc "Analyze one file's source text into a `Codegraph.Graph`."
  @spec analyze_source(String.t(), String.t()) :: Graph.t()
  def analyze_source(source, file \\ "nofile") when is_binary(source) do
    quoted = Code.string_to_quoted!(source, file: file)

    acc =
      walk(quoted, %{module: nil, function: nil, aliases: %{}}, %{
        nodes: MapSet.new(),
        edges: [],
        specs: %{}
      })

    # @spec can appear before or after the def it describes, so specs are
    # collected separately during the walk and attached to their matching
    # node here, once the whole file (and thus every @spec) has been seen.
    nodes =
      acc.nodes
      |> MapSet.to_list()
      |> Enum.map(fn node ->
        case Map.get(acc.specs, {node.module, node.function, node.arity}) do
          nil -> node
          spec -> %{node | spec_args: spec.args, spec_return: spec.return}
        end
      end)

    # Edges accumulate by prepending (see add_edge/2), so this reverses
    # back to call order before deduping — Enum.uniq/1 keeps each
    # element's FIRST occurrence, which after the reverse is its first
    # appearance in the source, not its last.
    edges = acc.edges |> Enum.reverse() |> Enum.uniq()

    %Graph{nodes: nodes, edges: edges}
  end

  @doc "Analyze a file on disk into a `Codegraph.Graph`."
  @spec analyze_file(Path.t()) :: Graph.t()
  def analyze_file(path) do
    path |> File.read!() |> analyze_source(path)
  end

  # -- defmodule: register the module, descend with new module context --
  defp walk({:defmodule, _, [alias_ast, [do: body]]}, ctx, acc) do
    mod = resolve_alias(alias_ast, ctx.module)
    acc = add_node(acc, %Node{module: mod, external: false, status: :unchanged})
    walk(body, %{ctx | module: mod, function: nil, aliases: collect_aliases(body)}, acc)
  end

  # -- def/defp: register the function, descend with new function context --
  defp walk({kind, _, [head, [do: body]]}, ctx, acc) when kind in [:def, :defp] and not is_nil(ctx.module) do
    {name, arity} = fun_head(head)

    node = %Node{
      module: ctx.module,
      function: name,
      arity: arity,
      external: false,
      status: :unchanged,
      hash: :erlang.phash2(body),
      params: fun_params(head)
    }

    acc = add_node(acc, node)
    walk(body, %{ctx | function: {name, arity}}, acc)
  end

  # -- @spec: record the type signature, keyed by module/name/arity, to be
  # attached to its matching node after the whole file has been walked
  # (a @spec can be written above or below the def it describes) --
  defp walk({:@, _, [{:spec, _, [{:"::", _, [head, return_type]}]}]}, ctx, acc)
       when not is_nil(ctx.module) do
    {name, arg_types} = spec_head(head)
    key = {ctx.module, name, length(arg_types)}
    spec = %{args: Enum.map(arg_types, &Macro.to_string/1), return: Macro.to_string(return_type)}
    %{acc | specs: Map.put(acc.specs, key, spec)}
  end

  # -- pipe: rhs's arity gets +1 for the piped-in lhs argument --
  defp walk({:|>, _, [lhs, rhs]}, ctx, acc) do
    acc = walk(lhs, ctx, acc)
    walk_pipe_rhs(rhs, ctx, acc)
  end

  # -- remote call: Mod.fun(args) --
  defp walk({{:., _, [mod_ast, fun]}, _, args}, ctx, acc) when is_atom(fun) and is_list(args) do
    acc =
      case resolve_call_target(mod_ast, ctx) do
        nil -> acc
        target -> maybe_add_edge(acc, ctx, target, fun, length(args))
      end

    walk(args, ctx, walk(mod_ast, ctx, acc))
  end

  # -- everything else shaped like a call/special-form: fun(args) --
  defp walk({name, _, args}, ctx, acc) when is_atom(name) and is_list(args) do
    acc =
      if ctx.module && ctx.function && name not in @skip_call_heads do
        maybe_add_edge(acc, ctx, ctx.module, name, length(args))
      else
        acc
      end

    walk(args, ctx, acc)
  end

  defp walk({a, b}, ctx, acc), do: walk(b, ctx, walk(a, ctx, acc))
  defp walk(list, ctx, acc) when is_list(list), do: Enum.reduce(list, acc, &walk(&1, ctx, &2))
  defp walk(_other, _ctx, acc), do: acc

  defp walk_pipe_rhs({{:., _, [mod_ast, fun]}, _, args}, ctx, acc) when is_atom(fun) and is_list(args) do
    acc =
      case resolve_call_target(mod_ast, ctx) do
        nil -> acc
        target -> maybe_add_edge(acc, ctx, target, fun, length(args) + 1)
      end

    walk(args, ctx, walk(mod_ast, ctx, acc))
  end

  defp walk_pipe_rhs({name, _, args}, ctx, acc) when is_atom(name) and is_list(args) and name not in @skip_call_heads do
    acc =
      if ctx.module && ctx.function do
        maybe_add_edge(acc, ctx, ctx.module, name, length(args) + 1)
      else
        acc
      end

    walk(args, ctx, acc)
  end

  defp walk_pipe_rhs(other, ctx, acc), do: walk(other, ctx, acc)

  defp fun_head({:when, _, [inner, _guard]}), do: fun_head(inner)

  defp fun_head({name, _, args}) when is_atom(name) do
    {name, if(is_list(args), do: length(args), else: 0)}
  end

  # Readable text for each parameter, straight from the def head's own
  # patterns — handles plain vars, defaults, and destructuring patterns
  # alike via Macro.to_string/1, rather than hand-writing a pattern-to-
  # string pretty-printer for each AST shape Elixir allows there.
  defp fun_params({:when, _, [inner, _guard]}), do: fun_params(inner)

  defp fun_params({_name, _, args}) do
    args |> List.wrap() |> Enum.map(&Macro.to_string/1)
  end

  # Same idea as fun_head/1, but keeps the raw (type) argument ASTs
  # instead of just their count, since @spec callers need to stringify
  # each one.
  defp spec_head({:when, _, [inner, _guard]}), do: spec_head(inner)

  defp spec_head({name, _, args}) when is_atom(name) do
    {name, List.wrap(args)}
  end

  defp resolve_alias({:__aliases__, _, parts}, nil), do: Module.concat(parts)
  defp resolve_alias({:__aliases__, _, parts}, parent), do: Module.concat([parent | parts])
  defp resolve_alias(_other, parent), do: parent || :"UnresolvedModule"

  # `Mod.fun()` where `Mod`'s first segment matches a tracked alias (e.g.
  # `alias Broadway.Topology; Topology.RateLimiter.foo()`) resolves through
  # the alias to the real module (Broadway.Topology.RateLimiter), not the
  # literal written segment — without this, idiomatic aliased calls to a
  # project's own other modules were misresolved as external, since the
  # literal alias name rarely matches any module actually defined anywhere.
  defp resolve_call_target({:__aliases__, _, [first | rest]}, ctx) do
    case Map.get(ctx.aliases, first) do
      nil -> Module.concat([first | rest])
      aliased when rest == [] -> aliased
      aliased -> Module.concat([aliased | rest])
    end
  end

  defp resolve_call_target({:__MODULE__, _, _}, ctx), do: ctx.module
  defp resolve_call_target(mod, _ctx) when is_atom(mod), do: mod
  defp resolve_call_target(_dynamic, _ctx), do: nil

  # Scans a module's body for `alias` statements (plain, `as:`, and
  # multi-alias `Mod.{A, B}` forms) and returns the resulting alias-name
  # to real-module map. Applied module-wide (see moduledoc) rather than
  # threaded incrementally through the walk, since ctx flows top-down
  # through the AST and wouldn't otherwise reach sibling statements later
  # in the same block.
  defp collect_aliases(ast), do: do_collect_aliases(ast, %{})

  defp do_collect_aliases({:alias, _, [mod_ast]}, acc) do
    Map.merge(acc, alias_bindings(mod_ast, []))
  end

  defp do_collect_aliases({:alias, _, [mod_ast, opts]}, acc) when is_list(opts) do
    Map.merge(acc, alias_bindings(mod_ast, opts))
  end

  defp do_collect_aliases({_, _, args}, acc) when is_list(args) do
    Enum.reduce(args, acc, &do_collect_aliases/2)
  end

  defp do_collect_aliases({a, b}, acc) do
    acc = do_collect_aliases(a, acc)
    do_collect_aliases(b, acc)
  end

  defp do_collect_aliases(list, acc) when is_list(list) do
    Enum.reduce(list, acc, &do_collect_aliases/2)
  end

  defp do_collect_aliases(_other, acc), do: acc

  # `alias Mod.{A, B}` — the multi-alias macro call `Mod.{}(A, B)`.
  defp alias_bindings({{:., _, [base_ast, :{}]}, _, items}, _opts) do
    base =
      case base_ast do
        {:__aliases__, _, base_parts} -> base_parts
        _ -> []
      end

    items
    |> Enum.filter(&match?({:__aliases__, _, _}, &1))
    |> Map.new(fn {:__aliases__, _, sub_parts} ->
      {List.last(sub_parts), Module.concat(base ++ sub_parts)}
    end)
  end

  # `alias Mod.Sub` (binds the last segment) or `alias Mod.Sub, as: Name`.
  defp alias_bindings({:__aliases__, _, parts}, opts) do
    key =
      case Keyword.get(opts, :as) do
        {:__aliases__, _, [as_name]} -> as_name
        _ -> List.last(parts)
      end

    %{key => Module.concat(parts)}
  end

  defp alias_bindings(_other, _opts), do: %{}

  defp maybe_add_edge(acc, %{module: mod, function: {fname, arity}}, target_mod, fun, target_arity) do
    from = %Node{module: mod, function: fname, arity: arity, external: false, status: :unchanged}
    to = %Node{module: target_mod, function: fun, arity: target_arity, external: false, status: :unchanged}
    add_edge(acc, %Edge{from: from, to: to, status: :unchanged})
  end

  defp maybe_add_edge(acc, _ctx_without_function, _target_mod, _fun, _arity), do: acc

  defp add_node(acc, node), do: %{acc | nodes: MapSet.put(acc.nodes, node)}
  defp add_edge(acc, edge), do: %{acc | edges: [edge | acc.edges]}
end
