import { describe, expect, test } from 'bun:test'
import { spawnSync } from 'node:child_process'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { makeRepo, git } from './repo.js'
import { loadNamed, runWorkflow } from './load.js'

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
