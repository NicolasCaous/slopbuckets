import { request } from 'node:http';
import { afterEach, describe, expect, it } from 'vitest';
import { httpRequest, pagePost } from '../testing/http.js';
import { EventHub, json, rejectReason, startWebServer, TOKEN_HEADER, type WebServer } from './server.js';

const servers: WebServer[] = [];
afterEach(async () => {
  for (const server of servers.splice(0)) await server.close();
});

async function start(options: Partial<Parameters<typeof startWebServer>[0]> = {}): Promise<WebServer> {
  const server = await startWebServer({
    routes: [
      { method: 'GET', path: '/', handler: () => json({ hello: 'page' }) },
      { method: 'POST', path: '/api/echo', handler: async (req) => json({ got: await req.json() }) },
    ],
    ...options,
  });
  servers.push(server);
  return server;
}

describe('startWebServer', () => {
  it('listens on 127.0.0.1 on a free port and serves routes with security headers', async () => {
    const server = await start();
    expect(server.url).toBe(`http://127.0.0.1:${server.port}/`);
    expect(server.port).toBeGreaterThan(0);
    const res = await httpRequest(server.port);
    expect(res.status).toBe(200);
    expect(JSON.parse(res.body)).toEqual({ hello: 'page' });
    expect(res.headers['content-security-policy']).toContain("default-src 'none'");
    expect(res.headers['content-security-policy']).toContain("frame-ancestors 'none'");
    expect(res.headers['x-frame-options']).toBe('DENY');
    expect(res.headers['cache-control']).toBe('no-store');
    expect(res.headers['access-control-allow-origin']).toBeUndefined();
  });

  it('accepts localhost:<port> as the Host too', async () => {
    const server = await start();
    expect((await httpRequest(server.port, { headers: { host: `localhost:${server.port}` } })).status).toBe(200);
  });

  it.each([
    ['another host name', (port: number) => ({ host: `evil.example:${port}` })],
    ['the right name with another port', (port: number) => ({ host: `127.0.0.1:${port + 1}` })],
    ['no port', () => ({ host: '127.0.0.1' })],
    ['a rebinding name', (port: number) => ({ host: `127.0.0.1.nip.io:${port}` })],
    ['the IPv6 loopback', (port: number) => ({ host: `[::1]:${port}` })],
  ])('rejects a request with %s in Host', async (_, headers) => {
    const server = await start();
    const res = await httpRequest(server.port, { headers: headers(server.port) });
    expect(res.status).toBe(403);
    expect(res.body).toContain('Host');
  });

  it.each([
    ['another site', 'https://evil.example'],
    ['another port', 'http://127.0.0.1:1'],
    ['https on the right port', (port: number) => `https://127.0.0.1:${port}`],
    ['a null origin', 'null'],
  ])('rejects an Origin from %s, even on GET', async (_, origin) => {
    const server = await start();
    const value = typeof origin === 'function' ? origin(server.port) : origin;
    const res = await httpRequest(server.port, { headers: { origin: value } });
    expect(res.status).toBe(403);
    expect(res.body).toContain('Origin');
  });

  it('accepts its own origin', async () => {
    const server = await start();
    expect((await httpRequest(server.port, { headers: { origin: `http://localhost:${server.port}`, host: `localhost:${server.port}` } })).status).toBe(200);
  });

  it('rejects cross-site sub-resource requests but allows a cross-site navigation', async () => {
    const server = await start();
    expect((await httpRequest(server.port, { headers: { 'sec-fetch-site': 'cross-site', 'sec-fetch-mode': 'no-cors' } })).status).toBe(403);
    expect((await httpRequest(server.port, { headers: { 'sec-fetch-site': 'cross-site', 'sec-fetch-mode': 'navigate' } })).status).toBe(200);
  });

  it('needs the Origin and the token on a POST', async () => {
    const server = await start();
    const ok = await pagePost(server, '/api/echo', { a: 1 });
    expect(ok.status).toBe(200);
    expect(JSON.parse(ok.body)).toEqual({ got: { a: 1 } });

    const noToken = await httpRequest(server.port, { method: 'POST', path: '/api/echo', headers: { origin: `http://127.0.0.1:${server.port}`, 'content-type': 'application/json' }, body: '{}' });
    expect(noToken.status).toBe(403);
    const wrongToken = await pagePost(server, '/api/echo', {}, { [TOKEN_HEADER]: 'nope' });
    expect(wrongToken.status).toBe(403);
    const noOrigin = await httpRequest(server.port, { method: 'POST', path: '/api/echo', headers: { [TOKEN_HEADER]: server.token, 'content-type': 'application/json' }, body: '{}' });
    expect(noOrigin.status).toBe(403);
    const formPost = await pagePost(server, '/api/echo', {}, { 'content-type': 'application/x-www-form-urlencoded' });
    expect(formPost.status).toBe(415);
  });

  it('answers 404 for unknown paths, 405 for a wrong method and refuses CORS preflights', async () => {
    const server = await start();
    expect((await httpRequest(server.port, { path: '/nope' })).status).toBe(404);
    const wrong = await httpRequest(server.port, { path: '/api/echo' });
    expect(wrong.status).toBe(405);
    expect(wrong.headers.allow).toBe('POST');
    const preflight = await httpRequest(server.port, { method: 'OPTIONS', path: '/api/echo', headers: { origin: 'https://evil.example', 'access-control-request-method': 'POST' } });
    expect(preflight.status).toBe(403);
  });

  it('rejects a body that is too large or not JSON', async () => {
    const server = await start();
    const big = await pagePost(server, '/api/echo', { blob: 'x'.repeat(70 * 1024) });
    expect(big.status).toBe(413);
    const bad = await httpRequest(server.port, {
      method: 'POST',
      path: '/api/echo',
      headers: { origin: `http://127.0.0.1:${server.port}`, 'content-type': 'application/json', [TOKEN_HEADER]: server.token },
      body: '{not json',
    });
    expect(bad.status).toBe(400);
  });

  it('closes after the idle timeout and calls onIdle', async () => {
    let idle = 0;
    const server = await start({ idleTimeoutMs: 80, onIdle: () => idle++ });
    await server.closed;
    expect(idle).toBe(1);
    await expect(httpRequest(server.port)).rejects.toThrow();
  });

  it('resets the idle timer on each request', async () => {
    let idle = 0;
    // The requests span twice the idle time, and each gap leaves a wide margin for a busy machine, where a timer
    // can fire a few hundred milliseconds late.
    const server = await start({ idleTimeoutMs: 800, onIdle: () => idle++ });
    for (let i = 0; i < 8; i++) {
      await new Promise((r) => setTimeout(r, 200));
      await httpRequest(server.port);
    }
    expect(idle).toBe(0);
    await server.closed;
    expect(idle).toBe(1);
  });

  it('streams Server-Sent Events and ends the streams on close', async () => {
    const hub = new EventHub();
    const server = await start({
      routes: [{ method: 'GET', path: '/events', handler: hub.handler(() => ({ event: 'hello', data: { n: 0 } })) }],
    });
    const received: string[] = [];
    const ended = new Promise<number | undefined>((resolve, reject) => {
      const req = request({ host: '127.0.0.1', port: server.port, path: '/events', headers: { host: `127.0.0.1:${server.port}`, accept: 'text/event-stream' }, agent: false }, (res) => {
        res.setEncoding('utf8');
        res.on('data', (chunk: string) => {
          received.push(chunk);
          if (received.join('').includes('event: hello')) hub.broadcast('tick', { n: 1 });
        });
        res.on('end', () => resolve(res.statusCode));
      });
      req.on('error', reject);
      req.end();
    });
    await new Promise<void>((resolve) => {
      const wait = setInterval(() => {
        if (received.join('').includes('event: tick')) {
          clearInterval(wait);
          resolve();
        }
      }, 10);
    });
    expect(hub.size).toBe(1);
    await server.close();
    expect(await ended).toBe(200);
    const text = received.join('');
    expect(text).toContain('event: hello\ndata: {"n":0}\n\n');
    expect(text).toContain('event: tick\ndata: {"n":1}\n\n');
    expect(hub.size).toBe(0);
  });
});

describe('rejectReason', () => {
  const port = 4321;
  const token = 't0ken';
  it.each([
    [{ method: 'GET', headers: { host: '127.0.0.1:4321' } }, null],
    [{ method: 'HEAD', headers: { host: 'LOCALHOST:4321' } }, null],
    [{ method: 'GET', headers: {} }, 'unexpected Host header'],
    [{ method: 'POST', headers: { host: '127.0.0.1:4321', 'x-buckets-token': token } }, 'missing Origin header'],
    [{ method: 'POST', headers: { host: '127.0.0.1:4321', origin: 'http://127.0.0.1:4321' } }, 'missing or wrong token'],
    [{ method: 'POST', headers: { host: '127.0.0.1:4321', origin: 'http://127.0.0.1:4321', 'x-buckets-token': token } }, null],
    [{ method: 'DELETE', headers: { host: '127.0.0.1:4321', origin: 'http://127.0.0.1:4321', 'x-buckets-token': 't0ke' } }, 'missing or wrong token'],
  ])('%j -> %s', (req, expected) => {
    expect(rejectReason(req, port, token)).toBe(expected);
  });
});

describe('startWebServer limits', () => {
  it('disconnects a request whose body is held open past the request timeout', async () => {
    const server = await start({ requestTimeoutMs: 300 });
    const outcome = await new Promise<string>((resolve) => {
      const req = request({
        host: '127.0.0.1',
        port: server.port,
        method: 'POST',
        path: '/api/echo',
        agent: false,
        headers: { host: `127.0.0.1:${server.port}`, origin: `http://127.0.0.1:${server.port}`, 'content-type': 'application/json', 'content-length': '100', [TOKEN_HEADER]: server.token },
      });
      req.on('response', (res) => resolve(`status ${res.statusCode}`));
      req.on('error', () => resolve('closed'));
      req.write('{"a":');
      setTimeout(() => resolve('still open'), 4000).unref();
    });
    expect(outcome).not.toBe('still open');
    // The server still answers others.
    expect((await pagePost(server, '/api/echo', { b: 1 })).status).toBe(200);
  });

  it('resets the idle timer only for requests with the token when asked to', async () => {
    let idle = false;
    const server = await start({ idleTimeoutMs: 800, idleResetRequiresToken: true, onIdle: () => (idle = true) });
    const start_ = Date.now();
    while (!idle && Date.now() - start_ < 8000) {
      await httpRequest(server.port).catch(() => undefined);
      await new Promise((r) => setTimeout(r, 40));
    }
    expect(idle).toBe(true);

    let idle2 = false;
    const kept = await start({ idleTimeoutMs: 800, idleResetRequiresToken: true, onIdle: () => (idle2 = true) });
    for (let i = 0; i < 8; i++) {
      await pagePost(kept, '/api/echo', {});
      await new Promise((r) => setTimeout(r, 200));
    }
    expect(idle2).toBe(false);
  });

  it('closes after the maximum lifetime whatever the activity', async () => {
    let ended = '';
    const server = await start({ idleTimeoutMs: 10_000, maxLifetimeMs: 200, onIdle: () => (ended = 'idle'), onMaxLifetime: () => (ended = 'lifetime') });
    const closed = server.closed.then(() => true);
    while (ended === '') {
      await pagePost(server, '/api/echo', {}).catch(() => undefined);
      await new Promise((r) => setTimeout(r, 30));
    }
    expect(ended).toBe('lifetime');
    expect(await closed).toBe(true);
  });
});
