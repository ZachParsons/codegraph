defmodule B do
  def step(x) do
    C.deep(x)
  end
end

defmodule C do
  def deep(x), do: x
end
