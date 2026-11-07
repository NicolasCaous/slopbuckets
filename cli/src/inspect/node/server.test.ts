import { request } from 'node:http';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { httpRequest } from '../../testing/http.js';
import { EventHub, startWebServer, type WebServer, type WebServerOptions } from './server.js';

const servers: WebServer[] = [];
afterEach(() => vi.useRealTimers());
afterEach(async () => {
  for (const server of servers.splice(0)) await server.close();
});

const page = () => ({ status: 200, headers: { 'content-type': 'text/plain' }, body: 'page' });

async function start(options: Partial<WebServerOptions> = {}): Promise<WebServer> {
  const server = await startWebServer({ routes: { '/': page }, idleTimeoutMs: 60_000, ...options });
  servers.push(server);
  return server;
}

/** Opens a GET of `path` and collects its chunks until the server ends it. */
function openStream(port: number, path: string) {
  const chunks: string[] = [];
  let close = () => {};
  const ended = new Promise<number | undefined>((resolve, reject) => {
    const req = request({ host: '127.0.0.1', port, path, headers: { host: `127.0.0.1:${port}` }, agent: false }, (res) => {
      res.setEncoding('utf8');
      res.on('data', (chunk: string) => chunks.push(chunk));
      res.on('end', () => resolve(res.statusCode));
    });
    close = () => req.destroy();
    req.on('error', reject);
    req.end();
  });
  const until = (part: string) =>
    new Promise<void>((resolve) => {
      const wait = setInterval(() => {
        if (chunks.join('').includes(part)) {
          clearInterval(wait);
          resolve();
        }
      }, 10);
    });
  return { text: () => chunks.join(''), until, ended, close: () => close() };
}

describe('startWebServer', () => {
  it('listens on 127.0.0.1 on a free port and serves routes with security headers', async () => {
    const server = await start();
    expect(server.url).toBe(`http://127.0.0.1:${server.port}/`);
    const res = await httpRequest(server.port);
    expect(res.status).toBe(200);
    expect(res.body).toBe('page');
    expect(res.headers['content-security-policy']).toContain("default-src 'none'");
    expect(res.headers['content-security-policy']).toContain("frame-ancestors 'none'");
    expect(res.headers['x-frame-options']).toBe('DENY');
    expect(res.headers['cache-control']).toBe('no-store');
    expect(res.headers['access-control-allow-origin']).toBeUndefined();
    const head = await httpRequest(server.port, { method: 'HEAD' });
    expect(head.status).toBe(200);
    expect(head.body).toBe('');
    expect((await httpRequest(server.port, { path: '/nope' })).status).toBe(404);
  });

  it('accepts localhost:<port> as the Host and its own origin', async () => {
    const server = await start();
    expect((await httpRequest(server.port, { headers: { host: `localhost:${server.port}`, origin: `http://localhost:${server.port}` } })).status).toBe(200);
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
  ])('rejects an Origin from %s', async (_, origin) => {
    const server = await start();
    const value = typeof origin === 'function' ? origin(server.port) : origin;
    const res = await httpRequest(server.port, { headers: { origin: value } });
    expect(res.status).toBe(403);
    expect(res.body).toContain('Origin');
  });

  it('rejects cross-site sub-resource requests but allows a cross-site navigation', async () => {
    const server = await start();
    expect((await httpRequest(server.port, { headers: { 'sec-fetch-site': 'cross-site', 'sec-fetch-mode': 'no-cors' } })).status).toBe(403);
    expect((await httpRequest(server.port, { headers: { 'sec-fetch-site': 'cross-site', 'sec-fetch-mode': 'navigate' } })).status).toBe(200);
  });

  it.each(['POST', 'PUT', 'DELETE', 'OPTIONS'])('refuses %s, even from its own origin', async (method) => {
    const server = await start();
    const res = await httpRequest(server.port, { method, headers: { origin: `http://127.0.0.1:${server.port}`, 'content-type': 'application/json' }, body: '{}' });
    expect(res.status).toBe(403);
    expect(res.body).toContain('only GET and HEAD');
  });

  it('closes after the idle timeout, and each request resets it', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    const server = await start({ idleTimeoutMs: 800 });
    let closed = false;
    void server.closed.then(() => (closed = true));
    // The requests span six times the idle time.
    for (let i = 0; i < 8; i++) {
      vi.advanceTimersByTime(600);
      await httpRequest(server.port);
    }
    expect(closed).toBe(false);
    vi.advanceTimersByTime(800);
    await server.closed;
    await expect(httpRequest(server.port)).rejects.toThrow();
  });

  it('stays up while an event stream is open, and closes after the idle time once it ends', async () => {
    const hub = new EventHub();
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    const server = await start({ routes: { '/events': hub.handler() }, idleTimeoutMs: 200 });
    let closed = false;
    void server.closed.then(() => (closed = true));
    const stream = openStream(server.port, '/events');
    await stream.until(': connected');
    vi.advanceTimersByTime(600);
    expect(closed).toBe(false);
    stream.close();
    // With fake timers, every check of waitFor moves the clock on, so the idle time after the close passes.
    await vi.waitFor(() => expect(closed).toBe(true));
  });

  it('broadcasts the same JSON text to every stream and ends the streams on close', async () => {
    const hub = new EventHub();
    const server = await start({ routes: { '/events': hub.handler() } });
    const a = openStream(server.port, '/events');
    const b = openStream(server.port, '/events');
    await Promise.all([a.until(': connected'), b.until(': connected')]);
    hub.broadcast('tick', '{"n":1}');
    await Promise.all([a.until('event: tick'), b.until('event: tick')]);
    await server.close();
    expect(await a.ended).toBe(200);
    expect(await b.ended).toBe(200);
    expect(a.text()).toContain('event: tick\ndata: {"n":1}\n\n');
    expect(b.text()).toContain('event: tick\ndata: {"n":1}\n\n');
  });
});
