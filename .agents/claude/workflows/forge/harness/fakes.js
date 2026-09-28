import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { cpSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'

export const SIM_DIR = join(import.meta.dir, '..', 'fixtures', 'sim')
const DEFAULT_TAIL = 4000

export const sha256 = data => createHash('sha256').update(data).digest('hex')

export function readCtx(prompt) {
  const line = String(prompt).split('\n').find(l => l.startsWith('FORGE_CTX '))
  if (!line) throw new Error('prompt has no FORGE_CTX line')
  return JSON.parse(line.slice('FORGE_CTX '.length))
}

// The runner is the only role whose fake does real work in every scenario: every
// SHA and exit code a check asserts on comes from here, as it will in a live run.
export function runCommands(commands) {
  return {
    results: commands.map(({ cmd, cwd, tail = DEFAULT_TAIL }) => {
      // Without a cwd, spawnSync runs in the harness package: real exit codes, wrong tree.
      if (!cwd) throw new Error(`runner command has no cwd: ${cmd}`)
      // zsh: the Bash tool runs the user's shell, and bash-only syntax must fail here too.
      const r = spawnSync('zsh', ['-c', cmd], { cwd, encoding: 'utf8' })
      return { cmd, exit: r.status ?? -1, tail: ((r.stdout || '') + (r.stderr || '')).slice(-tail) }
    }),
  }
}

export function honestScribe({ writes = [], reads = [] }) {
  const files = []
  for (const { path, content } of writes) {
    mkdirSync(dirname(path), { recursive: true })
    writeFileSync(path, content)
    const disk = readFileSync(path)
    files.push({ path, sha256: sha256(disk), bytes: disk.length })
  }
  for (const path of reads) {
    if (!existsSync(path)) { files.push({ path, missing: true }); continue }
    const content = readFileSync(path, 'utf8')
    files.push({ path, content, sha256: sha256(content), bytes: Buffer.byteLength(content) })
  }
  return { files }
}

// A model that skips the write cannot compute a sha256 in its head; it returns
// something hash-shaped instead. SPEC §14 scenario 10.
export function lyingScribe({ writes = [] }) {
  return {
    files: writes.map(({ path, content }) => ({
      path, sha256: sha256(`not written: ${path}`), bytes: Buffer.byteLength(content),
    })),
  }
}

export function simAgents(simName, overrides = {}) {
  const sim = join(SIM_DIR, simName)
  const json = file => JSON.parse(readFileSync(join(sim, file), 'utf8'))
  const copyInto = (variant, worktree) => cpSync(join(sim, variant), worktree, { recursive: true })
  const defaults = {
    runner: ctx => runCommands(ctx.commands),
    scribe: honestScribe,
    scout: () => json('scout.json'),
    seat: () => ({ concerns: [] }),
    planner: () => json('plan.json'),
    shadow: () => json('shadow.json'),
    comparator: () => json('compare.json'),
    critic: ctx => ({ verdicts: ctx.clauses.map(c => ({ clause: c.id, verdict: 'ok' })) }),
    builder: ctx => {
      copyInto(ctx.stage, ctx.worktree)
      return ctx.stage === 'A' ? json('builder-A.json') : { done: true }
    },
    judge: ctx => ({ verdicts: ctx.items.map(i => ({ ref: i.ref, verdict: 'valid' })) }),
    red: () => ({ bugs: [] }),
    blue: ctx => ({ results: ctx.bugs.map(b => ({ bug: b.id, outcome: 'reject', clause: b.clause })) }),
    reviewer: () => ({ findings: [] }),
  }
  const roles = { ...defaults, ...overrides }
  const calls = []
  const agent = async (prompt, opts = {}) => {
    const role = String(opts.label || '').split(':')[0]
    const ctx = readCtx(prompt)
    calls.push({ role, label: opts.label, ctx, opts })
    if (!roles[role]) throw new Error(`no fake for role "${role}" (label ${opts.label})`)
    return roles[role](ctx, { sim, json, copyInto, calls })
  }
  return { agent, calls }
}
