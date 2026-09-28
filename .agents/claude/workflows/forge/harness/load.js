import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'

// Built phase scripts live flat beside forge/, where the Workflow registry reads them.
export const WORKFLOWS_DIR = join(import.meta.dir, '..', '..')

const AsyncFunction = (async () => {}).constructor
const HOOKS = ['agent', 'parallel', 'pipeline', 'phase', 'log', 'args', 'budget', 'workflow', 'Date', 'Math']

const unavailable = what => () => { throw new Error(`${what} is unavailable in workflow scripts`) }

// The real runtime rejects these because they break resume; a script that uses them
// must fail here too, or the sim passes code the real runtime refuses.
const GuardedDate = new Proxy(Date, {
  apply: unavailable('Date()'),
  construct(target, argv) {
    if (!argv.length) unavailable('new Date()')()
    return new target(...argv)
  },
  get: (target, key) => (key === 'now' ? unavailable('Date.now()') : target[key]),
})
const GuardedMath = new Proxy(Math, {
  get: (target, key) => (key === 'random' ? unavailable('Math.random()') : target[key]),
})

export function loadNamed(name, dir = WORKFLOWS_DIR) {
  const path = join(dir, `${name}.js`)
  if (!existsSync(path)) throw new Error(`workflow not built: ${path}`)
  const source = readFileSync(path, 'utf8')
  // The registry could not be probed for name vs file resolution; forge pins file = meta.name.
  const declared = source.match(/^export const meta\s*=\s*\{[^}]*?\bname:\s*'([^']+)'/m)
  if (!declared || declared[1] !== name) throw new Error(`${path}: meta.name must equal the file name "${name}"`)
  return new AsyncFunction(...HOOKS, source.replace(/^export const meta\s*=/m, 'const meta ='))
}

export async function runWorkflow(name, args, agent, { dir = WORKFLOWS_DIR, onLog = () => {}, depth = 0 } = {}) {
  const fn = loadNamed(name, dir)
  const parallel = thunks => Promise.all(thunks.map(t => Promise.resolve().then(t).catch(() => null)))
  const pipeline = (items, ...stages) =>
    Promise.all(items.map(async (item, i) => {
      try {
        let value = item
        for (const stage of stages) value = await stage(value, item, i)
        return value
      } catch {
        return null
      }
    }))
  const workflow = async (child, childArgs) => {
    if (depth > 0) throw new Error('workflow() nests one level only')
    return runWorkflow(child, childArgs, agent, { dir, onLog, depth: depth + 1 })
  }
  const budget = { total: null, spent: () => 0, remaining: () => Infinity }
  return fn(agent, parallel, pipeline, () => {}, onLog, args, budget, workflow, GuardedDate, GuardedMath)
}
