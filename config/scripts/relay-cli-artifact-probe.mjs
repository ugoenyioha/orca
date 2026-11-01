import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises'
import { createServer } from 'node:net'
import { isAbsolute, join } from 'node:path'

const [executable, ...prefix] = process.argv.slice(2)
assert(executable && isAbsolute(executable), 'provide an absolute built executable')
const guard = 'orchestration.check.manual-ack.expected-dispatch.v1'
const message = { id: 'msg_fixture', run_id: 'run_fixture', from_handle: 'dispatch:ctx_origin',
  to_handle: 'term_fixture', subject: 'fixture', body: 'body', type: 'status', payload: '{"value":7}',
  delivery_contract: 'current_delivery', delivered_at: 123, thread_id: 'thread_fixture' }

async function probe(mode) {
  const root = await mkdtemp('/tmp/orca-cli-probe-')
  const home = join(root, 'home'), data = join(root, 'data'), endpoint = join(root, 'r.sock')
  const authToken = randomBytes(24).toString('hex')
  const sockets = new Set(), requests = []
  let fixtureError, child, closed
  const server = createServer(socket => {
    sockets.add(socket)
    socket.once('close', () => sockets.delete(socket))
    socket.on('error', error => { fixtureError ??= error })
    socket.setEncoding('utf8')
    let buffer = ''
    socket.on('data', chunk => {
      buffer += chunk
      while (buffer.includes('\n')) {
        const end = buffer.indexOf('\n'), line = buffer.slice(0, end)
        buffer = buffer.slice(end + 1)
        if (!line.trim()) continue
        try {
          const request = JSON.parse(line)
          assert.equal(request.authToken, authToken)
          requests.push(request)
          const envelope = { id: request.id, _meta: { runtimeId: 'runtime_fixture' } }
          let response
          if (request.method === 'status.get') {
            response = { ...envelope, ok: true, result: { runtimeId: 'runtime_fixture',
              rendererGraphEpoch: 1, graphStatus: 'ready', authoritativeWindowId: null, liveTabCount: 0,
              capabilities: ['orchestration.contract.v1', ...(mode === 'missing' ? [] : [guard])] } }
          } else {
            assert.equal(request.method, 'orchestration.checkDurable', 'unexpected legacy fallback')
            response = mode === 'oldhost'
              ? { ...envelope, ok: false, error: { code: 'method_not_found', message: 'Unknown strict method' } }
              : { ...envelope, ok: true, result: { runId: 'run_fixture', dispatchId: 'ctx_fixture',
                  deliveryId: 'delivery_fixture', count: 1, messages: [message],
                  ...(mode === 'legacy' ? { legacyCompatibility: { ackMessageIds: [message.id] } } : {}) } }
          }
          socket.write(JSON.stringify(response) + '\n')
        } catch (error) { fixtureError ??= error; socket.destroy() }
      }
    })
  })
  try {
    await mkdir(home, { mode: 0o700 })
    await mkdir(data, { mode: 0o700 })
    await new Promise((resolve, reject) => { server.once('error', reject); server.listen(endpoint, resolve) })
    await writeFile(join(data, 'orca-runtime.json'), JSON.stringify({ runtimeId: 'runtime_fixture',
      pid: process.pid, transports: [{ kind: 'unix', endpoint }], authToken, startedAt: Date.now() }), { mode: 0o600 })
    const env = { ...process.env }
    for (const key of Object.keys(env)) if (key.startsWith('ORCA_')) delete env[key]
    delete env.NODE_OPTIONS
    Object.assign(env, { HOME: home, ORCA_USER_DATA_PATH: data, XDG_CONFIG_HOME: join(home, 'config'),
      XDG_DATA_HOME: join(home, 'data'), XDG_STATE_HOME: join(home, 'state'), XDG_CACHE_HOME: join(home, 'cache') })
    child = spawn(executable, [...prefix, 'orchestration', 'check', '--durable', '--terminal', 'term_fixture',
      '--expected-dispatch', 'ctx_fixture', '--json'], { cwd: root, env, stdio: ['ignore', 'pipe', 'pipe'] })
    let stdout = '', stderr = ''
    child.stdout.setEncoding('utf8').on('data', chunk => { stdout += chunk })
    child.stderr.setEncoding('utf8').on('data', chunk => { stderr += chunk })
    closed = new Promise(resolve => {
      child.once('error', error => { fixtureError ??= error })
      child.once('close', code => resolve(code))
    })
    let timedOut = false
    const timer = setTimeout(() => { timedOut = true; child.kill('SIGKILL') }, 15000)
    let code
    try { code = await closed } finally { clearTimeout(timer) }
    if (fixtureError) throw fixtureError
    assert.equal(timedOut, false, `${mode}: timeout`)
    assert(requests.some(request => request.method === 'status.get'), 'missing discovery')
    assert.equal(requests.filter(request => request.method === 'orchestration.check').length, 0)
    const checks = requests.filter(request => request.method === 'orchestration.checkDurable')
    if (mode === 'missing') {
      assert.notEqual(code, 0)
      assert.equal(checks.length, 0)
    } else {
      assert.equal(checks.length, 1)
      assert.equal(checks[0].params.expectedDispatchId, 'ctx_fixture')
      assert.equal(checks[0].params.ack, undefined)
      if (mode === 'full') {
        assert.equal(code, 0, stderr)
        assert.deepEqual(JSON.parse(stdout).result.messages, [message])
      } else {
        assert.notEqual(code, 0)
        assert.match(stdout + stderr, mode === 'oldhost' ? /method_not_found/ : /incompatible_runtime/)
      }
    }
    console.log(`PASS ${mode}`)
  } finally {
    if (child && child.exitCode === null && child.signalCode === null) child.kill('SIGKILL')
    if (closed) await closed
    for (const socket of sockets) socket.destroy()
    if (server.listening) await new Promise(resolve => server.close(resolve))
    await rm(root, { recursive: true, force: true })
  }
}

try {
  for (const mode of ['full', 'missing', 'legacy', 'oldhost']) await probe(mode)
} catch (error) {
  console.error(`FAIL artifact probe: ${error instanceof Error ? error.message : 'unknown error'}`)
  process.exitCode = 1
}
