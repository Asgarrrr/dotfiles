// Pre-edit state for task `discount`. Baseline for excess_distance.

export interface Line {
  price: number;
  qty: number;
}

export function subtotal(lines: Line[]): number {
  return lines.reduce((sum, l) => sum + l.price * l.qty, 0);
}

export function total(lines: Line[], taxRate: number): number {
  return subtotal(lines) * (1 + taxRate);
}
