// HTTP helpers for the web tests. node:http instead of fetch, because the tests set Host and Origin by hand.
import { request } from 'node:http';

export interface TestResponse {
  status: number;
  headers: Record<string, string | string[] | undefined>;
  body: string;
}

export function httpRequest(
  port: number,
  options: { method?: string; path?: string; headers?: Record<string, string>; body?: string } = {},
): Promise<TestResponse> {
  return new Promise((resolve, reject) => {
    const req = request(
      { host: '127.0.0.1', port, method: options.method ?? 'GET', path: options.path ?? '/', headers: { host: `127.0.0.1:${port}`, ...options.headers }, agent: false },
      (res) => {
        const chunks: Buffer[] = [];
        res.on('data', (chunk: Buffer) => chunks.push(chunk));
        res.on('end', () => resolve({ status: res.statusCode ?? 0, headers: res.headers, body: Buffer.concat(chunks).toString('utf8') }));
        res.on('error', reject);
      },
    );
    req.on('error', reject);
    req.end(options.body);
  });
}

