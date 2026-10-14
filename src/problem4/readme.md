# Three ways to sum to n

`solution.ts` exports three functions that sum the integers from `1` through `n`.
Each returns `15` for `n = 5` and `0` for `n <= 0` (an empty sum).
Inputs are assumed to be integers whose sums are less than
`Number.MAX_SAFE_INTEGER`, as specified in the task.

| Function | Implementation | Time | Auxiliary space |
| --- | --- | --- | --- |
| `sum_to_n_a` | Add each integer in a loop | O(n) | O(1) |
| `sum_to_n_b` | Recursively halve n | O(log n) | O(log n) |
| `sum_to_n_c` | Arithmetic series formula | O(1) | O(1) |

The recursive implementation uses `S(2k) = 2S(k) + k * k`: the upper half
contains the same terms as the lower half, each increased by `k`.
For an odd input, it also adds the last term. Halving limits recursion depth.

The formula implementation divides the even factor before multiplication,
avoiding an intermediate product that could exceed the safe integer range.
