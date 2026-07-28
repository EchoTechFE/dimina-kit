// The browser build has no node:crypto, so src/shims/crypto.js provides a synchronous
// SHA-256 to back @dimina/compiler's scope-id `createHash('sha256').update(path)
// .digest().readBigUInt64BE(0)`. This asserts the shim is byte-identical to node:crypto
// on every input the compiler can feed it — if they ever diverge, browser-compiled scope
// ids would silently disagree with node-compiled ones.
import nodeCrypto from 'node:crypto'
import { createHash as shimCreateHash } from '../src/shims/crypto.js'

const SAMPLES = [
  'pages/index/index',
  'components/foo/foo',
  '/components/c16wtkpz/index',
  '/components/c1v8pxjl/index',
  '',
  'a',
  'app.json',
  '中文/页面/path',
  'pages/very/deeply/nested/component/index',
  'x'.repeat(1),
  'x'.repeat(55),
  'x'.repeat(56),
  'x'.repeat(64),
  'x'.repeat(120),
  'x'.repeat(1000),
  // Varied bytes across block boundaries — a constant byte exercises the sha256
  // message schedule (w[t] recurrence) weakly; these would catch a w[] indexing typo
  // that repeated-byte inputs mask. Lengths deliberately straddle 55/56/64/65.
  Array.from({ length: 65 }, (_, i) => String.fromCharCode(33 + (i * 7) % 90)).join(''),
  Array.from({ length: 200 }, (_, i) => `seg${(i * 31) % 97}/`).join(''),
  'pages/index/index'.split('').reverse().join('') + '/深/x'.repeat(20),
]

let failed = 0
const fail = (m) => { failed++; console.error(`❌ ${m}`) }

for (const p of SAMPLES) {
  const shimHex = shimCreateHash('sha256').update(p).digest().toString('hex')
  const nodeHex = nodeCrypto.createHash('sha256').update(p).digest('hex')
  const shimId = shimCreateHash('sha256').update(p).digest().readBigUInt64BE(0).toString(36)
  const nodeId = nodeCrypto.createHash('sha256').update(p).digest().readBigUInt64BE(0).toString(36)
  if (shimHex !== nodeHex) fail(`hex mismatch for ${JSON.stringify(p.slice(0, 24))}: shim ${shimHex} != node ${nodeHex}`)
  else if (shimId !== nodeId) fail(`scope-id mismatch for ${JSON.stringify(p.slice(0, 24))}: shim ${shimId} != node ${nodeId}`)
}

// Chained updates must equal a single concatenated update (the compiler only calls
// update once today, but the shim promises standard incremental semantics).
const chained = shimCreateHash('sha256').update('pages/').update('index/').update('index').digest().toString('hex')
const oneShot = nodeCrypto.createHash('sha256').update('pages/index/index').digest('hex')
if (chained !== oneShot) fail(`chained update() != single update(): ${chained} != ${oneShot}`)

// Only sha256 is implemented — anything else must fail loudly, not silently mis-hash.
try {
  shimCreateHash('md5')
  fail('createHash("md5") should throw (shim implements sha256 only)')
} catch { /* expected */ }

console.log(failed ? `\n❌ FAIL (${failed})` : `\n✅ PASS: crypto shim === node:crypto on ${SAMPLES.length} samples + chained + guard`)
process.exit(failed ? 1 : 0)
