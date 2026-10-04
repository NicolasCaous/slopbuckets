// A small local HTTP server for the browser pages of the CLI (`buckets refresh --web`, later `buckets inspect`).
// It listens only on 127.0.0.1 on a free port, rejects requests whose Host or Origin is not its own address,
// requires a per-server token on every request that is not a GET or HEAD, and shuts down after a period
// without requests. Pages, endpoints and assets are plain routes, so a command adds its own.
import { randomBytes, timingSafeEqual } from 'node:crypto';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo, Socket } from 'node:net';

/** The header that carries the server token on requests that change state. Pages read the token from a meta tag. */
export const TOKEN_HEADER = 'x-buckets-token';

const MAX_BODY_BYTES = 64 * 1024;

export interface WebResponse {
  status: number;
  headers?: Record<string, string>;
  body?: string | Buffer;
  /** Runs once the response is fully sent, for example to shut down the server after the last answer. */
  onFinish?: () => void;
}

export interface WebRequest {
  method: string;
  url: URL;
  headers: IncomingMessage['headers'];
  /** Reads and parses a JSON body. Throws an HttpError (400 or 413) for a bad body. */
  json(): Promise<unknown>;
  /** Turns this request into a Server-Sent Events stream. The route handler must then return `STREAMING`. */
  openEventStream(): EventStream;
  /** Aborted when the client disconnects. */
  signal: AbortSignal;
}

export type RouteHandler = (req: WebRequest) => WebResponse | typeof STREAMING | Promise<WebResponse | typeof STREAMING>;

export interface Route {
  method: 'GET' | 'POST';
  path: string;
  handler: RouteHandler;
}

/** Returned by a route handler that took over the response with `openEventStream()`. */
export const STREAMING = Symbol('streaming');

export class HttpError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
    this.name = 'HttpError';
  }
}

export interface WebServerOptions {
  routes: Route[];
  /** Shuts the server down after this long without a request. Open event streams do not count as activity. */
  idleTimeoutMs?: number;
  /** Called when the idle timeout fires, before the server closes. */
  onIdle?: () => void;
  /** Fixed port, for tests that need one. The default 0 asks the system for a free port. */
  port?: number;
  /** Fixed token, for tests. The default is 32 random bytes. */
  token?: string;
  /**
   * When true, only requests that carry the server token reset the idle timer, so a page that is open and active
   * keeps the server alive, while plain GET requests (anyone who has the link) do not. Default false: every
   * request counts.
   */
  idleResetRequiresToken?: boolean;
  /** Shuts the server down this long after it started, whatever the activity. No limit when absent. */
  maxLifetimeMs?: number;
  /** Called when the maximum lifetime ends, before the server closes. Defaults to `onIdle`. */
  onMaxLifetime?: () => void;
  /**
   * Time to receive a whole request (headers and body) and the headers alone. A client that holds a request open
   * is disconnected after this. Node's defaults (5 minutes and 1 minute) apply when absent.
   */
  requestTimeoutMs?: number;
  headersTimeoutMs?: number;
  /** How long an idle keep-alive connection stays open. Node's default (5 seconds) applies when absent. */
  keepAliveTimeoutMs?: number;
}

export interface WebServer {
  /** `http://127.0.0.1:<port>/` */
  url: string;
  port: number;
  /** The value a page must send in the `x-buckets-token` header on POST requests. */
  token: string;
  /** Resets the idle timer, for activity the server cannot see, such as a native dialog that is open. */
  touch(): void;
  /** Stops accepting requests, ends open event streams and resolves once every connection is closed. */
  close(): Promise<void>;
  /** Resolves when the server has closed, for any reason. */
  closed: Promise<void>;
}

export interface EventStream {
  /** Sends one event. `data` is serialized as JSON. */
  send(event: string, data: unknown): void;
  /** Ends the stream. */
  close(): void;
  /** Aborted when the client disconnects or the stream is closed. */
  signal: AbortSignal;
}

/** Sends events to every open stream of one kind, for pages that update live. */
export class EventHub {
  private readonly streams = new Set<EventStream>();

  /** A GET route handler that opens a stream and keeps it until the client leaves. `hello` is sent first, when given. */
  handler(hello?: () => { event: string; data: unknown }): RouteHandler {
    return (req) => {
      const stream = req.openEventStream();
      this.streams.add(stream);
      stream.signal.addEventListener('abort', () => this.streams.delete(stream), { once: true });
      if (hello) {
        const first = hello();
        stream.send(first.event, first.data);
      }
      return STREAMING;
    };
  }

  broadcast(event: string, data: unknown): void {
    for (const stream of this.streams) stream.send(event, data);
  }

  get size(): number {
    return this.streams.size;
  }

  closeAll(): void {
    for (const stream of [...this.streams]) stream.close();
  }
}

// ---- response helpers ----

export function json(body: unknown, status = 200): WebResponse {
  return { status, headers: { 'content-type': 'application/json; charset=utf-8' }, body: `${JSON.stringify(body)}\n` };
}

export function htmlPage(body: string, status = 200): WebResponse {
  return { status, headers: { 'content-type': 'text/html; charset=utf-8' }, body };
}

export function text(body: string, status = 200): WebResponse {
  return { status, headers: { 'content-type': 'text/plain; charset=utf-8' }, body: `${body}\n` };
}

/** A static asset embedded in the bundle. */
export function asset(body: string, contentType: string): RouteHandler {
  return () => ({ status: 200, headers: { 'content-type': contentType }, body });
}

/**
 * The Content Security Policy of every response: scripts, styles, images and requests only from the server
 * itself, plus the site fonts from Google Fonts. No inline script, no framing, no form posts elsewhere. Forms may
 * submit to the server itself: the inspect page's search and simulations are GET forms that also work without the
 * script, and any request that changes state still needs the token header, which a plain form cannot send.
 */
export const CONTENT_SECURITY_POLICY = [
  "default-src 'none'",
  "script-src 'self'",
  "style-src 'self' https://fonts.googleapis.com",
  "font-src 'self' https://fonts.gstatic.com",
  "img-src 'self' data:",
  "connect-src 'self'",
  "base-uri 'none'",
  "form-action 'self'",
  "frame-ancestors 'none'",
].join('; ');

const SECURITY_HEADERS: Record<string, string> = {
  'content-security-policy': CONTENT_SECURITY_POLICY,
  'x-content-type-options': 'nosniff',
  'x-frame-options': 'DENY',
  'referrer-policy': 'no-referrer',
  'cross-origin-opener-policy': 'same-origin',
  'cross-origin-resource-policy': 'same-origin',
  'cache-control': 'no-store',
};

// ---- request checks ----

/**
 * Why a request must be refused, or null when it may pass. Exported for tests.
 *
 * - Host must be exactly `127.0.0.1:<port>` or `localhost:<port>`. This stops DNS rebinding: a page on
 *   evil.example that resolves its name to 127.0.0.1 still sends `Host: evil.example`.
 * - Origin, when present, must be `http://127.0.0.1:<port>` or `http://localhost:<port>`.
 * - A request that is not GET or HEAD must carry a matching Origin and the server token, so another web
 *   page cannot post to the server even with a simple form.
 * - Sub-resource requests that the browser marks as cross-site are refused. Navigations are allowed,
 *   because the human may open the link from a chat in another site.
 */
export function rejectReason(req: Pick<IncomingMessage, 'method' | 'headers'>, port: number, token: string): string | null {
  const allowedHosts = new Set([`127.0.0.1:${port}`, `localhost:${port}`]);
  const host = req.headers.host?.toLowerCase();
  if (host === undefined || !allowedHosts.has(host)) return 'unexpected Host header';
  const allowedOrigins = new Set([`http://127.0.0.1:${port}`, `http://localhost:${port}`]);
  const origin = req.headers.origin;
  if (origin !== undefined && !allowedOrigins.has(origin.toLowerCase())) return 'unexpected Origin header';
  const site = req.headers['sec-fetch-site'];
  const mode = req.headers['sec-fetch-mode'];
  if ((site === 'cross-site' || site === 'same-site') && mode !== 'navigate') return 'cross-site request';
  const method = req.method ?? 'GET';
  if (method !== 'GET' && method !== 'HEAD') {
    if (origin === undefined) return 'missing Origin header';
    if (!sameToken(req.headers[TOKEN_HEADER], token)) return 'missing or wrong token';
  }
  return null;
}

function sameToken(given: string | string[] | undefined, token: string): boolean {
  if (typeof given !== 'string') return false;
  const a = Buffer.from(given);
  const b = Buffer.from(token);
  return a.length === b.length && timingSafeEqual(a, b);
}

async function readBody(req: IncomingMessage): Promise<string> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    const buffer = typeof chunk === 'string' ? Buffer.from(chunk) : (chunk as Buffer);
    size += buffer.length;
    if (size > MAX_BODY_BYTES) throw new HttpError(413, 'request body too large');
    chunks.push(buffer);
  }
  return Buffer.concat(chunks).toString('utf8');
}

/** Runs `fn` at most once. */
function once(fn: () => void): () => void {
  let called = false;
  return () => {
    if (called) return;
    called = true;
    fn();
  };
}

function send(res: ServerResponse, response: WebResponse, head: boolean): void {
  if (response.onFinish) {
    // 'finish' when the response went out, 'close' when the client left first. Either way the answer is final.
    const done = once(response.onFinish);
    res.once('finish', done);
    res.once('close', done);
  }
  res.writeHead(response.status, { ...SECURITY_HEADERS, ...response.headers });
  res.end(head ? undefined : response.body);
}

export async function startWebServer(options: WebServerOptions): Promise<WebServer> {
  const token = options.token ?? randomBytes(32).toString('base64url');
  const routes = new Map<string, Route>();
  for (const route of options.routes) routes.set(`${route.method} ${route.path}`, route);
  const sockets = new Set<Socket>();
  const streams = new Set<EventStream>();
  let port = 0;
  let idleTimer: NodeJS.Timeout | undefined;
  let lifetimeTimer: NodeJS.Timeout | undefined;
  let closing: Promise<void> | undefined;

  const requestTimeout = options.requestTimeoutMs;
  const headersTimeout = options.headersTimeoutMs ?? (requestTimeout !== undefined ? Math.min(requestTimeout, 60_000) : undefined);
  const shortest = Math.min(requestTimeout ?? Infinity, headersTimeout ?? Infinity);
  const server: Server = createServer(
    {
      ...(requestTimeout !== undefined ? { requestTimeout } : {}),
      ...(headersTimeout !== undefined ? { headersTimeout: Math.min(headersTimeout, requestTimeout ?? headersTimeout) } : {}),
      ...(options.keepAliveTimeoutMs !== undefined ? { keepAliveTimeout: options.keepAliveTimeoutMs } : {}),
      // Node checks the request timeouts on this interval (30 seconds by default), so short timeouts need a short one.
      ...(shortest !== Infinity ? { connectionsCheckingInterval: Math.max(50, Math.min(1000, Math.floor(shortest / 2))) } : {}),
    },
    (req, res) => {
      if (!options.idleResetRequiresToken || sameToken(req.headers[TOKEN_HEADER], token)) touch();
      void handle(req, res);
    },
  );
  server.on('connection', (socket) => {
    sockets.add(socket);
    socket.once('close', () => sockets.delete(socket));
  });

  async function handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const head = req.method === 'HEAD';
    const reason = rejectReason(req, port, token);
    if (reason !== null) {
      send(res, text(`Forbidden: ${reason}.`, 403), head);
      return;
    }
    const url = new URL(req.url ?? '/', `http://127.0.0.1:${port}`);
    const method = head ? 'GET' : (req.method ?? 'GET');
    const route = routes.get(`${method} ${url.pathname}`);
    if (!route) {
      const exists = [...routes.values()].some((r) => r.path === url.pathname);
      send(res, exists ? { ...text('Method not allowed.', 405), headers: { 'content-type': 'text/plain; charset=utf-8', allow: allowed(url.pathname) } } : text('Not found.', 404), head);
      return;
    }
    const controller = new AbortController();
    res.once('close', () => controller.abort());
    let streaming = false;
    const request: WebRequest = {
      method,
      url,
      headers: req.headers,
      signal: controller.signal,
      async json() {
        const type = req.headers['content-type'] ?? '';
        if (!type.toLowerCase().startsWith('application/json')) throw new HttpError(415, 'expected a JSON body');
        const body = await readBody(req);
        try {
          return body === '' ? null : (JSON.parse(body) as unknown);
        } catch {
          throw new HttpError(400, 'invalid JSON body');
        }
      },
      openEventStream() {
        streaming = true;
        return openStream(res, controller, streams);
      },
    };
    try {
      const response = await route.handler(request);
      if (response === STREAMING) {
        if (!streaming) throw new Error(`route ${route.path} returned STREAMING without opening a stream`);
        return;
      }
      // The client may have left while the handler ran, for example a closed tab while the dialog was open.
      // The handler's decision still stands, so its onFinish runs anyway.
      if (!res.headersSent && !res.destroyed) send(res, response, head);
      else response.onFinish?.();
    } catch (error) {
      if (res.headersSent || res.destroyed) return;
      if (error instanceof HttpError) send(res, json({ error: error.message }, error.status), head);
      else send(res, json({ error: 'internal error', detail: error instanceof Error ? error.message : String(error) }, 500), head);
    }
  }

  function allowed(pathname: string): string {
    const methods: string[] = [...routes.values()].filter((r) => r.path === pathname).map((r) => r.method);
    if (methods.includes('GET')) methods.push('HEAD');
    return methods.join(', ');
  }

  function touch(): void {
    if (options.idleTimeoutMs === undefined || closing) return;
    if (idleTimer) clearTimeout(idleTimer);
    idleTimer = setTimeout(() => {
      options.onIdle?.();
      void close();
    }, options.idleTimeoutMs);
  }

  const closed = new Promise<void>((resolve) => server.once('close', () => resolve()));

  function close(): Promise<void> {
    if (closing) return closing;
    if (idleTimer) clearTimeout(idleTimer);
    if (lifetimeTimer) clearTimeout(lifetimeTimer);
    closing = new Promise<void>((resolve) => {
      for (const stream of [...streams]) stream.close();
      server.close(() => resolve());
      server.closeIdleConnections();
      // Responses still in flight get a moment to finish, then every socket is closed.
      const force = setTimeout(() => {
        server.closeAllConnections();
        for (const socket of sockets) socket.destroy();
      }, 1000);
      force.unref();
    });
    return closing;
  }

  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(options.port ?? 0, '127.0.0.1', () => {
      server.off('error', reject);
      resolve();
    });
  });
  port = (server.address() as AddressInfo).port;
  touch();
  if (options.maxLifetimeMs !== undefined) {
    lifetimeTimer = setTimeout(() => {
      if (closing) return;
      (options.onMaxLifetime ?? options.onIdle)?.();
      void close();
    }, options.maxLifetimeMs);
  }

  return { url: `http://127.0.0.1:${port}/`, port, token, touch, close, closed };
}

function openStream(res: ServerResponse, controller: AbortController, streams: Set<EventStream>): EventStream {
  res.writeHead(200, {
    ...SECURITY_HEADERS,
    'content-type': 'text/event-stream; charset=utf-8',
    connection: 'keep-alive',
    'x-accel-buffering': 'no',
  });
  res.write(': connected\n\n');
  // A comment every 25 seconds keeps proxies and the browser from dropping a quiet stream.
  const ping = setInterval(() => res.write(': ping\n\n'), 25_000);
  ping.unref();
  const stream: EventStream = {
    signal: controller.signal,
    send(event, data) {
      if (res.writableEnded || res.destroyed) return;
      const name = event.replace(/[\r\n]/g, '');
      const payload = JSON.stringify(data);
      res.write(`event: ${name}\ndata: ${payload}\n\n`);
    },
    close() {
      if (!res.writableEnded) res.end();
      controller.abort();
    },
  };
  streams.add(stream);
  controller.signal.addEventListener(
    'abort',
    () => {
      clearInterval(ping);
      streams.delete(stream);
    },
    { once: true },
  );
  return stream;
}
