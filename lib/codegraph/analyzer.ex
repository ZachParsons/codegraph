defmodule Codegraph.Analyzer do
  @moduledoc """
  Parses Elixir source (via `Code.string_to_quoted!/2`, no compilation) into
  a `Codegraph.Graph`: modules, their `def`/`defp` functions, and the calls
  made from each function body.

  This is a best-effort static walk, not a full compiler:
    - Local calls are only recognized when parenthesized (`foo(x)`), since
      `foo` alone is ambiguous with a variable reference in the raw AST.
    - Remote calls via an `alias`ed name (`alias Foo.Bar, as: FB; FB.baz()`)
      resolve to the literal alias (`FB.baz/1`), not the real target,
      since we don't run the compiler's alias-resolution table.
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
    acc = walk(quoted, %{module: nil, function: nil}, %{nodes: MapSet.new(), edges: MapSet.new()})
    %Graph{nodes: MapSet.to_list(acc.nodes), edges: MapSet.to_list(acc.edges)}
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
    walk(body, %{ctx | module: mod, function: nil}, acc)
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
      hash: :erlang.phash2(body)
    }

    acc = add_node(acc, node)
    walk(body, %{ctx | function: {name, arity}}, acc)
  end

  # -- pipe: rhs's arity gets +1 for the piped-in lhs argument --
  defp walk({:|>, _, [lhs, rhs]}, ctx, acc) do
    acc = walk(lhs, ctx, acc)
    walk_pipe_rhs(rhs, ctx, acc)
  end

  # -- remote call: Mod.fun(args) --
  defp walk({{:., _, [mod_ast, fun]}, _, args}, ctx, acc) when is_atom(fun) and is_list(args) do
    acc =
      case resolve_call_target(mod_ast, ctx.module) do
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
      case resolve_call_target(mod_ast, ctx.module) do
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

  defp resolve_alias({:__aliases__, _, parts}, nil), do: Module.concat(parts)
  defp resolve_alias({:__aliases__, _, parts}, parent), do: Module.concat([parent | parts])
  defp resolve_alias(_other, parent), do: parent || :"UnresolvedModule"

  defp resolve_call_target({:__aliases__, _, parts}, _current), do: Module.concat(parts)
  defp resolve_call_target({:__MODULE__, _, _}, current), do: current
  defp resolve_call_target(mod, _current) when is_atom(mod), do: mod
  defp resolve_call_target(_dynamic, _current), do: nil

  defp maybe_add_edge(acc, %{module: mod, function: {fname, arity}}, target_mod, fun, target_arity) do
    from = %Node{module: mod, function: fname, arity: arity, external: false, status: :unchanged}
    to = %Node{module: target_mod, function: fun, arity: target_arity, external: false, status: :unchanged}
    add_edge(acc, %Edge{from: from, to: to, status: :unchanged})
  end

  defp maybe_add_edge(acc, _ctx_without_function, _target_mod, _fun, _arity), do: acc

  defp add_node(acc, node), do: %{acc | nodes: MapSet.put(acc.nodes, node)}
  defp add_edge(acc, edge), do: %{acc | edges: MapSet.put(acc.edges, edge)}
end
