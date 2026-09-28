export type User = { id: string; role: 'admin' | 'member' }

export function exportReport(user: User): { status: number; body?: string } {
  return { status: 200, body: 'id,total\n1,100\n' }
}
