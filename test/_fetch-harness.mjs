import assert from 'node:assert/strict'

const ENDPOINT_SEGMENT_PATTERN = /^[A-Za-z0-9_$.-]+$/
const DEFAULT_OWNER_PEER = Object.freeze({ id: 'owner-peer', principal: { kind: 'owner' } })

export function assertValidDshFetchRoute(route) {
  assert.ok(typeof route?.path === 'string' && route.path.startsWith('/api/'), `route path must live under /api/: ${route?.path}`)
  const segments = route.path.slice('/api/'.length).split('/')
  assert.ok(
    segments.length > 0 && segments.every(seg => seg && seg !== '.' && seg !== '..' && ENDPOINT_SEGMENT_PATTERN.test(seg)),
    `invalid DSH fetch route segments: ${route.path}`,
  )
  assert.ok(Array.isArray(route.methods) && route.methods.length > 0, `route must declare methods: ${route.path}`)
  assert.equal(new Set(route.methods).size, route.methods.length, `route repeats method: ${route.path}`)
  for (const method of route.methods) {
    assert.ok(['GET', 'HEAD', 'POST'].includes(method), `unsupported DSH fetch method ${method}`)
  }
  assert.ok(['buffered', 'streaming'].includes(route.requestBody), `invalid requestBody mode: ${route.requestBody}`)
  assert.equal(typeof route.fetch, 'function')
}

/**
 * Mirrors DSH's HostConnectionService.fetch.register + createSharedFetchHandler('/api').
 * Enforces exact path/method matching and owner-only principal access.
 */
export function createFetchHarness() {
  const routes = new Map()
  let disposedCount = 0

  const connection = {
    on() {},
    fetch: {
      register(route) {
        assertValidDshFetchRoute(route)
        assert.ok(!routes.has(route.path), `duplicate fetch route ${route.path}`)
        const entry = {
          path: route.path,
          methods: new Set(route.methods),
          requestBody: route.requestBody,
          fetch: route.fetch,
        }
        routes.set(route.path, entry)
        let removed = false
        return async () => {
          if (removed) return
          removed = true
          disposedCount += 1
          routes.delete(route.path)
        }
      },
    },
  }

  async function dispatch(rawUrl, { method = 'GET', headers = {}, body, signal, peer = DEFAULT_OWNER_PEER } = {}) {
    const url = new URL(rawUrl, 'http://dsh.internal')
    const upper = String(method || 'GET').toUpperCase()
    const entry = routes.get(url.pathname)
    if (!entry || !entry.methods.has(upper)) {
      return new Response('not found', { status: 404 })
    }
    if (peer?.principal?.kind !== 'owner') {
      return new Response('forbidden', { status: 403 })
    }
    const reqHeaders = new Headers(headers)
    if (body !== undefined && !(body instanceof ReadableStream) && !reqHeaders.has('content-type')) {
      reqHeaders.set('content-type', 'application/json')
    }
    const init = {
      method: upper,
      headers: reqHeaders,
      signal,
    }
    if (body !== undefined && upper !== 'GET' && upper !== 'HEAD') {
      if (body instanceof ReadableStream) {
        init.body = body
        init.duplex = 'half'
      } else if (typeof body === 'string' || body instanceof Uint8Array || Buffer.isBuffer(body)) {
        init.body = body
      } else {
        init.body = JSON.stringify(body)
      }
    }
    const request = new Request(url, init)
    const response = await entry.fetch(request)
    if (signal) assert.equal(request.signal.aborted, signal.aborted, 'request must follow the dispatch signal')
    return response
  }

  async function call(method, rawUrl, body = null, headers = {}, extra = {}) {
    const res = await dispatch(rawUrl, {
      method,
      headers: {
        'x-career-agent': '1',
        ...(body !== null && body !== undefined ? { 'content-type': 'application/json' } : {}),
        ...headers,
      },
      ...(body !== null && body !== undefined ? { body } : {}),
      ...extra,
    })
    const raw = await res.text()
    let data = null
    try { data = raw ? JSON.parse(raw) : null } catch {}
    return {
      status: res.status,
      headers: Object.fromEntries(res.headers.entries()),
      raw,
      data,
      json: data,
    }
  }

  return {
    connection,
    routes,
    get disposedCount() { return disposedCount },
    dispatch,
    call,
  }
}
