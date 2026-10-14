/**
 * Sum the integers from 1 through n. Nonpositive integers return 0.
 * The caller guarantees an integer input and a safe integer result.
 * Time: O(n) for positive n. Auxiliary space: O(1).
 */
export function sum_to_n_a(n: number): number {
  let sum = 0;

  for (let i = 1; i <= n; i++) {
    sum += i;
  }

  return sum;
}

/**
 * Recursively halve the problem using S(2k) = 2S(k) + k * k.
 * For odd n, add the remaining term n.
 * Time: O(log n). Auxiliary space: O(log n) for the call stack.
 */
export function sum_to_n_b(n: number): number {
  if (n <= 0) {
    return 0;
  }

  const half = Math.floor(n / 2);
  const pairedSum = 2 * sum_to_n_b(half) + half * half;

  return pairedSum + (n % 2 === 0 ? 0 : n);
}

/**
 * Use the arithmetic series formula n(n + 1)/2.
 * Divide the even factor first to keep intermediate results safe integers.
 * Time: O(1). Auxiliary space: O(1).
 */
export function sum_to_n_c(n: number): number {
  if (n <= 0) {
    return 0;
  }

  return n % 2 === 0 ? (n / 2) * (n + 1) : n * ((n + 1) / 2);
}
