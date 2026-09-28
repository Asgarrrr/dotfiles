import { cpSync, mkdtempSync } from 'node:fs'
import { execSync } from 'node:child_process'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

export const FIXTURES = join(import.meta.dir, '..', 'fixtures')

export const git = (cwd, args) => execSync(`git ${args}`, { cwd, encoding: 'utf8' }).trim()

export function makeRepo(app = 'app') {
  const repo = mkdtempSync(join(tmpdir(), 'forge-sim-'))
  cpSync(join(FIXTURES, app), repo, { recursive: true })
  execSync(
    'git init -q -b main && git config user.email sim@forge.test && git config user.name forge-sim' +
      ' && git add -A && git commit -q -m base',
    { cwd: repo },
  )
  return repo
}
