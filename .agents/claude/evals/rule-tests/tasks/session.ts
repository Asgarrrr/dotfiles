// Pre-edit state for task `expiry`. Baseline for excess_distance.

export interface Session {
  token: string;
  createdAt: number;
}

const store = new Map<string, Session>();

export function get(token: string): Session | undefined {
  return store.get(token);
}

export function put(session: Session): void {
  store.set(session.token, session);
}
