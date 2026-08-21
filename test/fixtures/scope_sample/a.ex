defmodule A do
  def entry(x) do
    B.step(x) |> Enum.map(& &1)
  end
end
