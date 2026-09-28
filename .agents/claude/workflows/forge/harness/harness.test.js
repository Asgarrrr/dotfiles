import { describe, expect, test } from 'bun:test'
import { spawnSync } from 'node:child_process'
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { makeRepo, git } from './repo.js'
import { loadNamed, runWorkflow } from './load.js'
import { readCtx, sha256, runCommands, honestScribe, lyingScribe, simAgents } from './fakes.js'

describe('repo', () => {
  test('makeRepo commits the fixture app as "base" on main, with a clean tree', () => {
    const repo = makeRepo('app')
    expect(git(repo, 'log -1 --format=%s')).toBe('base')
    expect(git(repo, 'branch --show-current')).toBe('main')
    expect(git(repo, 'status --porcelain')).toBe('')
  })

  test('the fixture app suite is green at base', () => {
    const repo = makeRepo('app')
    const r = spawnSync('bun', ['test'], { cwd: repo, encoding: 'utf8' })
    expect(r.status).toBe(0)
  })
})

function workflowsDir(files) {
  const dir = mkdtempSync(join(tmpdir(), 'forge-wf-'))
  for (const [name, body] of Object.entries(files)) writeFileSync(join(dir, `${name}.js`), body)
  return dir
}
const noAgent = async () => { throw new Error('no agent expected') }

describe('load', () => {
  test('runs a script with meta, args and a top-level return', async () => {
    const dir = workflowsDir({ toy: "export const meta = { name: 'toy', description: 't' }\nreturn { got: args.x, name: meta.name }" })
    expect(await runWorkflow('toy', { x: 1 }, noAgent, { dir })).toEqual({ got: 1, name: 'toy' })
  })

  test('refuses a missing script and a meta.name that differs from the file name', () => {
    const dir = workflowsDir({ odd: "export const meta = { name: 'other', description: 't' }\nreturn 1" })
    expect(() => loadNamed('absent', dir)).toThrow('workflow not built')
    expect(() => loadNamed('odd', dir)).toThrow('meta.name must equal the file name')
  })

  test('Date.now, argless new Date and Math.random throw; Math.max still works', async () => {
    const dir = workflowsDir({
      now: "export const meta = { name: 'now', description: 't' }\nreturn Date.now()",
      fresh: "export const meta = { name: 'fresh', description: 't' }\nreturn new Date()",
      rnd: "export const meta = { name: 'rnd', description: 't' }\nreturn Math.random()",
      max: "export const meta = { name: 'max', description: 't' }\nreturn Math.max(1, 2)",
    })
    await expect(runWorkflow('now', {}, noAgent, { dir })).rejects.toThrow('unavailable')
    await expect(runWorkflow('fresh', {}, noAgent, { dir })).rejects.toThrow('unavailable')
    await expect(runWorkflow('rnd', {}, noAgent, { dir })).rejects.toThrow('unavailable')
    expect(await runWorkflow('max', {}, noAgent, { dir })).toBe(2)
  })

  test('parallel and pipeline turn a throwing item into null', async () => {
    const dir = workflowsDir({
      p: "export const meta = { name: 'p', description: 't' }\n" +
        "const a = await parallel([() => 1, () => { throw new Error('x') }])\n" +
        "const b = await pipeline([1, 2], v => { if (v === 2) throw new Error('y'); return v * 10 }, v => v + 1)\n" +
        'return { a, b }',
    })
    expect(await runWorkflow('p', {}, noAgent, { dir })).toEqual({ a: [1, null], b: [11, null] })
  })

  test('workflow() nests one level: a child calling workflow() throws', async () => {
    const dir = workflowsDir({
      parent: "export const meta = { name: 'parent', description: 't' }\nreturn await workflow('child', { v: 2 })",
      child: "export const meta = { name: 'child', description: 't' }\nreturn args.v",
      deep: "export const meta = { name: 'deep', description: 't' }\nreturn await workflow('parent2')",
      parent2: "export const meta = { name: 'parent2', description: 't' }\nreturn await workflow('child')",
    })
    expect(await runWorkflow('parent', {}, noAgent, { dir })).toBe(2)
    await expect(runWorkflow('deep', {}, noAgent, { dir })).rejects.toThrow('nests one level')
  })

  test('log() messages reach onLog', async () => {
    const dir = workflowsDir({ l: "export const meta = { name: 'l', description: 't' }\nlog('hi')\nreturn 0" })
    const logs = []
    await runWorkflow('l', {}, noAgent, { dir, onLog: m => logs.push(m) })
    expect(logs).toEqual(['hi'])
  })
})

const ctxPrompt = ctx => `Do the thing.\nFORGE_CTX ${JSON.stringify(ctx)}\nThanks.`

describe('fakes', () => {
  test('readCtx parses the FORGE_CTX line and rejects a prompt without one', () => {
    expect(readCtx(ctxPrompt({ a: 1 }))).toEqual({ a: 1 })
    expect(() => readCtx('no context here')).toThrow('FORGE_CTX')
  })

  test('runner executes each command in its cwd and returns exit and tail', () => {
    const cwd = mkdtempSync(join(tmpdir(), 'forge-run-'))
    const r = runCommands([{ cmd: 'pwd', cwd }, { cmd: 'echo boom >&2; exit 3', cwd }])
    expect(r.results[0]).toMatchObject({ exit: 0 })
    expect(r.results[0].tail).toContain('forge-run-')
    expect(r.results[1]).toMatchObject({ exit: 3, tail: 'boom\n' })
  })

  test('runner refuses a command without cwd instead of running in the harness directory', () => {
    expect(() => runCommands([{ cmd: 'pwd' }])).toThrow('cwd')
  })

  test('runner honors a per-command tail length', () => {
    const r = runCommands([{ cmd: 'printf abcdef', cwd: tmpdir(), tail: 3 }])
    expect(r.results[0].tail).toBe('def')
  })

  test('honest scribe writes, then hashes what is on disk', () => {
    const path = join(mkdtempSync(join(tmpdir(), 'forge-scribe-')), 'a', 'b.json')
    const r = honestScribe({ writes: [{ path, content: '{"x":1}' }] })
    expect(readFileSync(path, 'utf8')).toBe('{"x":1}')
    expect(r.files[0]).toEqual({ path, sha256: sha256('{"x":1}'), bytes: 7 })
  })

  test('honest scribe reads back content with its hash, and flags a missing file', () => {
    const dir = mkdtempSync(join(tmpdir(), 'forge-scribe-'))
    honestScribe({ writes: [{ path: join(dir, 'r.json'), content: 'hi' }] })
    const r = honestScribe({ reads: [join(dir, 'r.json'), join(dir, 'nope')] })
    expect(r.files[0]).toMatchObject({ content: 'hi', sha256: sha256('hi') })
    expect(r.files[1]).toMatchObject({ missing: true })
  })

  test('lying scribe writes nothing and returns a hash that is not the content hash', () => {
    const path = join(mkdtempSync(join(tmpdir(), 'forge-scribe-')), 'c.json')
    const r = lyingScribe({ writes: [{ path, content: 'x' }] })
    expect(existsSync(path)).toBe(false)
    expect(r.files[0].sha256).toMatch(/^[0-9a-f]{64}$/)
    expect(r.files[0].sha256).not.toBe(sha256('x'))
  })

  test('simAgents routes on the label prefix, records calls, and rejects an unknown role', async () => {
    const { agent, calls } = simAgents('slugify', { planner: ctx => ({ echoed: ctx.task }) })
    expect(await agent(ctxPrompt({ task: 't' }), { label: 'planner:main' })).toEqual({ echoed: 't' })
    expect(calls).toHaveLength(1)
    expect(calls[0]).toMatchObject({ role: 'planner', label: 'planner:main', ctx: { task: 't' } })
    await expect(agent(ctxPrompt({}), { label: 'wizard:1' })).rejects.toThrow('no fake for role "wizard"')
  })
})
