// Pre-edit state for task `retry`. This file is the baseline for
// excess_distance — arXiv:2609.04061 measures edit distance against the
// original code, not against a reference solution.

export async function fetchUser(id: string) {
  const res = await fetch(`/api/users/${id}`);

  if (!res.ok) {
    throw new Error(`fetchUser failed: ${res.status}`);
  }

  return res.json();
}
