// A small local HTTP server for the pages of `buckets inspect`. It listens only on 127.0.0.1 on a free port, answers
// only GET and HEAD, rejects requests whose Host or Origin is not its own address, and shuts down after a period
// without requests while no event stream is open. Each path is a route, so the page, its bundle and its endpoints
// are plain handlers.
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import type { AddressInfo, Socket } from 'node:net';

export interface WebResponse {
  status: number;
  headers?: Record<string, string>;
  body?: string;
}

export interface WebRequest {
  /** Turns this request into a Server-Sent Events stream. The route handler must then return `STREAMING`. */
  openEventStream(): EventStream;
}

/** Returned by a route handler that took over the response with `openEventStream()`. */
export const STREAMING = Symbol('streaming');

export type RouteHandler = (req: WebRequest) => WebResponse | typeof STREAMING;

export interface WebServerOptions {
  /** The handler of each path, such as `/` or `/snapshot.json`. HEAD runs the GET handler and drops the body. */
  routes: Record<string, RouteHandler>;
  /** Shuts the server down after this long without a request, unless an event stream is open. */
  idleTimeoutMs: number;
}

export interface WebServer {
  /** `http://127.0.0.1:<port>/` */
  url: string;
  port: number;
  /** Stops accepting requests, ends open event streams and resolves once every connection is closed. */
  close(): Promise<void>;
  /** Resolves when the server has closed, for any reason. */
  closed: Promise<void>;
}

export interface EventStream {
  /** Sends one event whose data is `json`, text that is already JSON, so a broadcast serializes once. */
  send(event: string, json: string): void;
  /** Aborted when the client disconnects or the server closes. */
  signal: AbortSignal;
}

/** Sends events to every open stream of one kind, for pages that update live. */
export class EventHub {
  private readonly streams = new Set<EventStream>();

  /** A GET route handler that opens a stream and keeps it until the client leaves. */
  handler(): RouteHandler {
    return (req) => {
      const stream = req.openEventStream();
      this.streams.add(stream);
      stream.signal.addEventListener('abort', () => this.streams.delete(stream), { once: true });
      return STREAMING;
    };
  }

  broadcast(event: string, json: string): void {
    for (const stream of this.streams) stream.send(event, json);
  }
}

/**
 * The Content Security Policy of every response, which allows only what the inspect page uses: its script, its
 * stylesheet, fetch and the event stream from the server itself, and a worker from a blob: URL, so the page bundle
 * carries its worker inline and the offline export works the same way. Inline styles are allowed, because the page
 * sets row positions and indents in style attributes. Images only from the server, for the favicon request that
 * browsers make. No inline script, no framing, no forms.
 */
const CONTENT_SECURITY_POLICY = [
  "default-src 'none'",
  "script-src 'self'",
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self'",
  'worker-src blob:',
  "connect-src 'self'",
  "base-uri 'none'",
  "form-action 'none'",
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

/**
 * Why a request must be refused, or null when it may pass.
 *
 * - Only GET and HEAD: the server changes nothing, so another web page has nothing to post to it.
 * - Host must be exactly `127.0.0.1:<port>` or `localhost:<port>`. This stops DNS rebinding: a page on
 *   evil.example that resolves its name to 127.0.0.1 still sends `Host: evil.example`.
 * - Origin, when present, must be `http://127.0.0.1:<port>` or `http://localhost:<port>`.
 * - Sub-resource requests that the browser marks as cross-site are refused. Navigations are allowed,
 *   because the human may open the link from a chat in another site.
 */
function rejectReason(req: IncomingMessage, port: number): string | null {
  if (req.method !== 'GET' && req.method !== 'HEAD') return 'only GET and HEAD are allowed';
  const host = req.headers.host?.toLowerCase();
  if (host !== `127.0.0.1:${port}` && host !== `localhost:${port}`) return 'unexpected Host header';
  const origin = req.headers.origin?.toLowerCase();
  if (origin !== undefined && origin !== `http://127.0.0.1:${port}` && origin !== `http://localhost:${port}`) return 'unexpected Origin header';
  const site = req.headers['sec-fetch-site'];
  if ((site === 'cross-site' || site === 'same-site') && req.headers['sec-fetch-mode'] !== 'navigate') return 'cross-site request';
  return null;
}

function send(res: ServerResponse, response: WebResponse, head: boolean): void {
  res.writeHead(response.status, { ...SECURITY_HEADERS, ...response.headers });
  res.end(head ? undefined : response.body);
}

function text(body: string, status: number): WebResponse {
  return { status, headers: { 'content-type': 'text/plain; charset=utf-8' }, body: `${body}\n` };
}

export async function startWebServer(options: WebServerOptions): Promise<WebServer> {
  const routes = new Map(Object.entries(options.routes));
  const sockets = new Set<Socket>();
  const streams = new Set<AbortController>();
  let port = 0;
  let idleTimer: NodeJS.Timeout | undefined;
  let closing: Promise<void> | undefined;

  // Every request is a small GET, so a client that holds one open is dropped after 10 seconds without its headers,
  // or 30 seconds in all. Node checks these limits every connectionsCheckingInterval. Event streams are responses,
  // which these limits do not cover.
  const server = createServer({ requestTimeout: 30_000, headersTimeout: 10_000, connectionsCheckingInterval: 1000 }, (req, res) => {
    touch();
    handle(req, res);
  });
  server.on('connection', (socket) => {
    sockets.add(socket);
    socket.once('close', () => sockets.delete(socket));
  });

  function handle(req: IncomingMessage, res: ServerResponse): void {
    const head = req.method === 'HEAD';
    const reason = rejectReason(req, port);
    if (reason !== null) return send(res, text(`Forbidden: ${reason}.`, 403), head);
    const handler = routes.get(new URL(req.url ?? '/', `http://127.0.0.1:${port}`).pathname);
    if (!handler) return send(res, text('Not found.', 404), head);
    const response = handler({ openEventStream: () => openStream(res) });
    if (response !== STREAMING) send(res, response, head);
  }

  function openStream(res: ServerResponse): EventStream {
    const controller = new AbortController();
    res.writeHead(200, { ...SECURITY_HEADERS, 'content-type': 'text/event-stream; charset=utf-8', connection: 'keep-alive', 'x-accel-buffering': 'no' });
    res.write(': connected\n\n');
    // A comment every 25 seconds keeps proxies and the browser from dropping a quiet stream.
    const ping = setInterval(() => res.write(': ping\n\n'), 25_000);
    ping.unref();
    streams.add(controller);
    res.once('close', () => controller.abort());
    controller.signal.addEventListener(
      'abort',
      () => {
        clearInterval(ping);
        streams.delete(controller);
        if (!res.writableEnded) res.end();
        // A page that reloads closes its stream and opens a new one, so the idle time counts from the close.
        touch();
      },
      { once: true },
    );
    return {
      signal: controller.signal,
      send(event, json) {
        if (!res.writableEnded && !res.destroyed) res.write(`event: ${event.replace(/[\r\n]/g, '')}\ndata: ${json}\n\n`);
      },
    };
  }

  function touch(): void {
    if (closing) return;
    clearTimeout(idleTimer);
    idleTimer = setTimeout(() => (streams.size > 0 ? touch() : void close()), options.idleTimeoutMs);
  }

  const closed = new Promise<void>((resolve) => server.once('close', () => resolve()));

  function close(): Promise<void> {
    if (closing) return closing;
    closing = new Promise<void>((resolve) => {
      for (const stream of [...streams]) stream.abort();
      // After the streams, since each one that ends sets the timer again.
      clearTimeout(idleTimer);
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
    server.listen(0, '127.0.0.1', () => {
      server.off('error', reject);
      resolve();
    });
  });
  port = (server.address() as AddressInfo).port;
  touch();

  return { url: `http://127.0.0.1:${port}/`, port, close, closed };
}
