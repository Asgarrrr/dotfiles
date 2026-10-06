import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { runWorkflow } from './load.js'
import { SIM_DIR, simAgents } from './fakes.js'
import { git, makeRepo } from './repo.js'

export async function runForge({ sim, repo, args = {}, overrides = {} }) {
  const fixture = JSON.parse(readFileSync(join(SIM_DIR, sim, 'task.json'), 'utf8'))
  repo = repo || makeRepo(fixture.app)
  const { agent, calls } = simAgents(sim, overrides)
  const logs = []
  const fullArgs = { task: fixture.task, dir: repo, runId: 'sim', ...args }
  const result = await runWorkflow('forge', fullArgs, agent, { onLog: m => logs.push(m) })
  const runDir = join(repo, '.claude', 'runs', fullArgs.runId)
  return {
    result, calls, logs, repo, runDir,
    json: rel => JSON.parse(readFileSync(join(runDir, rel), 'utf8')),
    ledger: () => readFileSync(join(runDir, 'ledger.md'), 'utf8'),
    git: argv => git(repo, argv),
  }
}
