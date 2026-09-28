// Pure helpers shared by every forge phase. No imports, no I/O: build.js strips
// `export` and inlines this file into each workflow script.

// ---------- sha256 (scripts have no crypto API) ----------

const SHA_K = [
  0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5,
  0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174,
  0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
  0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967,
  0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85,
  0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
  0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3,
  0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2,
]

function utf8Bytes(str) {
  const out = []
  for (const ch of str) {
    const c = ch.codePointAt(0)
    if (c < 0x80) out.push(c)
    else if (c < 0x800) out.push(0xc0 | (c >> 6), 0x80 | (c & 63))
    else if (c < 0x10000) out.push(0xe0 | (c >> 12), 0x80 | ((c >> 6) & 63), 0x80 | (c & 63))
    else out.push(0xf0 | (c >> 18), 0x80 | ((c >> 12) & 63), 0x80 | ((c >> 6) & 63), 0x80 | (c & 63))
  }
  return out
}

const rotr = (x, n) => (x >>> n) | (x << (32 - n))

export const byteLength = str => utf8Bytes(str).length

export function sha256(str) {
  const bytes = utf8Bytes(str)
  const bitLen = bytes.length * 8
  bytes.push(0x80)
  while (bytes.length % 64 !== 56) bytes.push(0)
  const hi = Math.floor(bitLen / 0x100000000)
  const lo = bitLen >>> 0
  bytes.push((hi >>> 24) & 255, (hi >>> 16) & 255, (hi >>> 8) & 255, hi & 255,
    (lo >>> 24) & 255, (lo >>> 16) & 255, (lo >>> 8) & 255, lo & 255)
  const H = [0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a, 0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19]
  const W = new Array(64)
  for (let i = 0; i < bytes.length; i += 64) {
    for (let t = 0; t < 16; t++) {
      W[t] = (bytes[i + 4 * t] << 24) | (bytes[i + 4 * t + 1] << 16) | (bytes[i + 4 * t + 2] << 8) | bytes[i + 4 * t + 3]
    }
    for (let t = 16; t < 64; t++) {
      const s0 = rotr(W[t - 15], 7) ^ rotr(W[t - 15], 18) ^ (W[t - 15] >>> 3)
      const s1 = rotr(W[t - 2], 17) ^ rotr(W[t - 2], 19) ^ (W[t - 2] >>> 10)
      W[t] = (W[t - 16] + s0 + W[t - 7] + s1) | 0
    }
    let [a, b, c, d, e, f, g, h] = H
    for (let t = 0; t < 64; t++) {
      const t1 = (h + (rotr(e, 6) ^ rotr(e, 11) ^ rotr(e, 25)) + ((e & f) ^ (~e & g)) + SHA_K[t] + W[t]) | 0
      const t2 = ((rotr(a, 2) ^ rotr(a, 13) ^ rotr(a, 22)) + ((a & b) ^ (a & c) ^ (b & c))) | 0
      h = g; g = f; f = e; e = (d + t1) | 0; d = c; c = b; b = a; a = (t1 + t2) | 0
    }
    H[0] = (H[0] + a) | 0; H[1] = (H[1] + b) | 0; H[2] = (H[2] + c) | 0; H[3] = (H[3] + d) | 0
    H[4] = (H[4] + e) | 0; H[5] = (H[5] + f) | 0; H[6] = (H[6] + g) | 0; H[7] = (H[7] + h) | 0
  }
  return H.map(x => (x >>> 0).toString(16).padStart(8, '0')).join('')
}

// ---------- JUnit ----------

function unescapeXml(s) {
  return s
    .replace(/&#x([0-9a-f]+);/gi, (_, h) => String.fromCodePoint(parseInt(h, 16)))
    .replace(/&#(\d+);/g, (_, d) => String.fromCodePoint(Number(d)))
    .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&apos;/g, "'")
    .replace(/&amp;/g, '&')
}

const normFile = f => (f || '').replace(/^\.\//, '')

// Reads full JUnit XML or the grep stream the runner returns (open tags, closing
// tags and `<failure type="…"` fragments, one per line).
export function parseJunit(xml) {
  const cases = []
  for (const m of String(xml).matchAll(/<testcase\b([^>]*?)(\/>|>([\s\S]*?)<\/testcase>)/g)) {
    const attrs = {}
    for (const a of m[1].matchAll(/([\w:-]+)="([^"]*)"/g)) attrs[a[1]] = unescapeXml(a[2])
    const body = m[3] || ''
    const failure = body.match(/<(?:failure|error)\b[^>]*?\btype="([^"]*)"/)
    const failed = /<(?:failure|error)\b/.test(body)
    cases.push({
      name: attrs.name,
      file: normFile(attrs.file),
      outcome: failed ? 'fail' : /<skipped\b/.test(body) ? 'skip' : 'pass',
      failureType: failed ? (failure ? unescapeXml(failure[1]) : '') : null,
    })
  }
  return cases
}

// A test missing from the report was never collected: an import or compile error
// removes the whole file from bun's XML.
export function outcomes(tests, cases) {
  return tests.map(t => {
    const c = cases.find(k => k.name === t.name && k.file === normFile(t.file))
    return c ? c.outcome : 'not-collected'
  })
}

export function junitCommand(testCmd, outFile) {
  if (/^bun test\b/.test(testCmd)) return `${testCmd} --reporter=junit --reporter-outfile=${q(outFile)}`
  return null
}

// ---------- triage ----------

export const SIGNALS = ['persistence', 'auth', 'money', 'concurrency', 'untrusted-input', 'public-api', 'data-loss']
const TIERS = ['S', 'M', 'L']

export function sizeOf(files, newModules = 0) {
  const n = new Set(files).size
  if (n > 8) return 'L'
  if (n > 2 || newModules > 0) return 'M'
  return 'S'
}

export const raiseTier = (a, b) => (TIERS.indexOf(a) >= TIERS.indexOf(b) ? a : b)

export function riskOf(signals, dismissedIds) {
  const live = signals.filter(s => !dismissedIds.includes(s.id))
  return { risk: live.length ? 'high' : 'low', signals: live }
}

export function parseDismiss(list) {
  return (list || []).map(item => {
    const m = String(item).match(/^\s*([\w-]+)\s*:\s*(\S.*)$/)
    if (!m) throw new Error(`dismiss "${item}" needs a reason: "<signal id>: <reason>"`)
    return { id: m[1], reason: m[2].trim() }
  })
}

// SPEC §6 table — the only source for council, shadow, checkpoints and attackers.
export function dosing(tier, risk) {
  const high = risk === 'high'
  const small = tier === 'S'
  return {
    council: !small && high,
    shadow: high,
    checkpointAfterPlan: !(small && !high),
    checkpointAfterSlice: !small && high,
    attackers: high ? ['opus', 'opus'] : [small ? 'sonnet' : 'opus'],
    mutation: high,
  }
}

// ---------- plan checks ----------

export const KINDS = ['behavior', 'negative', 'preserve', 'migration', 'concurrency', 'property']
const REQUIRED = {
  auth: ['negative'],
  persistence: ['migration', 'negative'],
  concurrency: ['concurrency'],
  'untrusted-input': ['property', 'negative'],
  money: ['negative'],
  'data-loss': ['negative'],
  'public-api': ['preserve'],
}
const CLAUSE_FIELDS = ['id', 'kind', 'input', 'action', 'expected', 'source']

export function checkPlan(plan, { signals = [], sources = [] } = {}) {
  const slices = (plan && plan.slices) || []
  if (!slices.length) return ['plan has no slices']
  const problems = []
  const seen = new Set()
  const used = new Set()
  const signalIds = [...new Set(signals.map(s => s.id))]
  for (const slice of slices) {
    if (!slice.files || !slice.files.length) problems.push(`${slice.id}: no files`)
    if (!slice.spec || !slice.spec.length) { problems.push(`${slice.id}: no clauses`); continue }
    for (const c of slice.spec) {
      for (const f of CLAUSE_FIELDS) if (typeof c[f] !== 'string' || !c[f].trim()) problems.push(`${c.id || slice.id}: empty ${f}`)
      if (c.kind && !KINDS.includes(c.kind)) problems.push(`${c.id}: unknown kind ${c.kind}`)
      if (seen.has(c.id)) problems.push(`duplicate clause id ${c.id}`)
      seen.add(c.id)
      used.add(c.source)
    }
    for (const id of signalIds) {
      const need = REQUIRED[id]
      if (need && !slice.spec.some(c => need.includes(c.kind))) {
        problems.push(`${slice.id}: signal ${id} needs a ${need.join(' or ')} clause`)
      }
    }
  }
  const rejected = new Set(((plan && plan.rejected) || []).map(r => r.id))
  for (const s of sources) if (!used.has(s) && !rejected.has(s)) problems.push(`${s} is neither a clause source nor rejected`)
  return problems
}

// ---------- git, shell, run layout ----------

export const q = s => `'${String(s).replace(/'/g, `'\\''`)}'`

const unquotePath = p => (p.startsWith('"') && p.endsWith('"') ? JSON.parse(p) : p)

export function parsePorcelain(text) {
  return String(text).split('\n').filter(l => l.length > 3).map(l => {
    const path = l.slice(3)
    const arrow = path.indexOf(' -> ')
    return unquotePath(arrow >= 0 ? path.slice(arrow + 4) : path)
  })
}

const PROTECTED = [
  /(^|\/)package\.json$/, /(^|\/)bunfig\.toml$/, /(^|\/)tsconfig[^/]*\.json$/,
  /(^|\/)(bun\.lockb?|yarn\.lock|package-lock\.json|pnpm-lock\.yaml|Cargo\.lock|go\.sum|poetry\.lock|uv\.lock)$/,
  /(^|\/)(vitest|jest|playwright|karma|cypress)\.config\.[cm]?[jt]s$/, /(^|\/)(vitest\.workspace|jest\.setup)\.[cm]?[jt]s$/,
  /(^|\/)(pyproject\.toml|pytest\.ini|setup\.cfg|tox\.ini|conftest\.py|Cargo\.toml|go\.mod|Makefile)$/,
  /^\.github\//, /^\.gitlab-ci\.yml$/, /^\.circleci\//,
]

// Editing the harness is how a green run lies (SPEC §6).
export const isProtected = path => PROTECTED.some(re => re.test(path))

export function paths(dir, runId) {
  const base = String(dir).replace(/\/+$/, '')
  // Worktrees sit beside the repo, not in it: inside, the user's own test runner
  // would collect every test in every forge worktree.
  const wtRoot = `${base}.forge/${runId}`
  return { dir: base, runDir: `${base}/.claude/runs/${runId}`, wtRoot, main: `${wtRoot}/main`, branch: `forge/${runId}/main` }
}

export function ledgerLine(kind, text, sha) {
  return `[${kind}] ${text}${sha ? ` @${String(sha).slice(0, 7)}` : ''}`
}

// No pipe: zsh (the Bash tool's shell here) has no PIPESTATUS, so `suite | tail`
// would report tail's exit code and every suite would read as green.
export const suiteCommand = (cmd, logFile) => `( ${cmd} ) > ${q(logFile)} 2>&1; e=$?; tail -c 3000 ${q(logFile)}; exit $e`

// A run is green when it fails nothing that was not already failing at baseline.
// On a green baseline the exit code must also be 0: an import error removes a
// whole file from the report without adding a failing case.
export function suiteOk(res, baselineFailing = []) {
  const known = new Set(baselineFailing)
  const fresh = res.cases.filter(c => c.outcome === 'fail' && !known.has(`${c.file} › ${c.name}`))
  return fresh.length === 0 && (known.size > 0 || res.exit === 0)
}
