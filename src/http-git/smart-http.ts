import { spawn } from 'node:child_process';
import type { Readable } from 'node:stream';
import type { FastifyReply } from 'fastify';
import type { AppConfig } from '../config/config.js';
import { ManagedProcess, controlledGitEnvironment, gitSafetyArguments } from '../git/git-runner.js';

const allowedServices = new Set(['git-upload-pack', 'git-receive-pack']);

export interface SmartHttpRequest {
  method: string;
  pathSuffix: string;
  queryService?: string;
  contentType?: string;
  contentLength?: string;
  body?: Readable;
  authenticatedUserId?: number;
}

export async function serveSmartHttp(
  config: AppConfig,
  repositoryPath: string,
  request: SmartHttpRequest,
  reply: FastifyReply,
): Promise<void> {
  const service = request.queryService;
  if (service && !allowedServices.has(service)) throw new SmartHttpInputError();
  if (!/^(?:info\/refs|git-upload-pack|git-receive-pack)$/.test(request.pathSuffix)) {
    throw new SmartHttpInputError();
  }
  const repositoryName = repositoryPath.split('/').at(-1);
  const repositoryRoot = repositoryPath.slice(0, -(repositoryName?.length ?? 0) - 1);
  if (!repositoryName) throw new SmartHttpInputError();
  const transferLimit = config.limits.archiveBytes;
  const declaredLength = Number(request.contentLength ?? '0');
  if (
    request.contentLength !== undefined &&
    (!Number.isSafeInteger(declaredLength) || declaredLength < 0 || declaredLength > transferLimit)
  ) {
    throw new SmartHttpInputError(413);
  }
  const query = service ? `service=${encodeURIComponent(service)}` : '';
  const child = spawn(config.git.executable, [...gitSafetyArguments, 'http-backend'], {
    shell: false,
    stdio: ['pipe', 'pipe', 'pipe'],
    env: controlledGitEnvironment({
      GIT_HTTP_EXPORT_ALL: '1',
      GIT_PROJECT_ROOT: repositoryRoot,
      PATH_INFO: `/${repositoryName}/${request.pathSuffix}`,
      QUERY_STRING: query,
      REQUEST_METHOD: request.method,
      CONTENT_TYPE: request.contentType ?? '',
      CONTENT_LENGTH: request.contentLength ?? '',
      ...(request.authenticatedUserId ? { REMOTE_USER: String(request.authenticatedUserId) } : {}),
    }),
  });

  let headerBuffer = Buffer.alloc(0);
  let headersSent = false;
  let stderr = '';
  let responseBytes = 0;
  let requestBytes = 0;
  reply.hijack();

  const completion = new Promise<void>((resolve, reject) => {
    const proc = new ManagedProcess(child, {
      timeoutMs: Math.max(config.git.timeoutMs, 120_000),
      onTimeout: () => new Error('Git HTTP transfer exceeded its time limit'),
      onSettle: (error) => {
        if (error) reject(error);
      },
    });
    const cancelled = (): Error => new Error('Git HTTP transfer was cancelled');
    if (request.body) {
      proc.cancelOn(request.body, 'aborted', cancelled());
      proc.cancelOn(request.body, 'error', cancelled());
    }
    proc.cancelOn(reply.raw, 'close', cancelled());
    const succeed = (): void => {
      proc.settle();
      resolve();
    };

    child.on('error', () => {
      proc.settle(new Error('Unable to start Git HTTP backend'));
    });
    child.stderr.on('data', (chunk: Buffer) => {
      if (stderr.length < 4096) stderr += chunk.toString('utf8');
    });
    child.stdout.on('data', (chunk: Buffer) => {
      responseBytes += chunk.length;
      if (responseBytes > transferLimit) {
        proc.terminate(new Error('Git HTTP response exceeded the transfer limit'));
        return;
      }
      if (headersSent) {
        reply.raw.write(chunk);
        return;
      }
      headerBuffer = Buffer.concat([headerBuffer, chunk]);
      if (headerBuffer.length > 32 * 1024) {
        proc.terminate(new Error('Git HTTP response headers exceeded limit'));
        return;
      }
      const separator = headerBuffer.indexOf('\r\n\r\n');
      const alternateSeparator = headerBuffer.indexOf('\n\n');
      const index = separator >= 0 ? separator : alternateSeparator;
      if (index < 0) return;
      const separatorLength = separator >= 0 ? 4 : 2;
      let parsed: { status: number; headers: Record<string, string> };
      try {
        parsed = parseCgiHeaders(headerBuffer.subarray(0, index).toString('latin1'));
      } catch (error) {
        proc.terminate(error instanceof Error ? error : new Error('Invalid Git HTTP response header'));
        return;
      }
      reply.raw.writeHead(parsed.status, parsed.headers);
      headersSent = true;
      reply.raw.write(headerBuffer.subarray(index + separatorLength));
      headerBuffer = Buffer.alloc(0);
    });
    child.on('close', (code) => {
      if (code !== 0) {
        if (!headersSent)
          proc.settle(new Error(`Git HTTP backend failed: ${stderr.slice(0, 500)}`));
        else {
          reply.raw.destroy();
          proc.settle(new Error('Git HTTP backend failed during transfer'));
        }
        return;
      }
      if (!headersSent) {
        proc.settle(new Error('Git HTTP backend returned no headers'));
        return;
      }
      reply.raw.end();
      succeed();
    });

    request.body?.on('data', (chunk: Buffer | string) => {
      requestBytes += typeof chunk === 'string' ? Buffer.byteLength(chunk) : chunk.length;
      if (requestBytes > transferLimit)
        proc.terminate(new Error('Git HTTP request exceeded the transfer limit'));
    });
  });

  if (request.body) request.body.pipe(child.stdin);
  else child.stdin.end();
  await completion;
}

function parseCgiHeaders(value: string): { status: number; headers: Record<string, string> } {
  let status = 200;
  const headers: Record<string, string> = {};
  for (const line of value.split(/\r?\n/)) {
    const colon = line.indexOf(':');
    if (colon <= 0) throw new Error('Invalid Git HTTP response header');
    const name = line.slice(0, colon).trim();
    const headerValue = line.slice(colon + 1).trim();
    if (!/^[A-Za-z0-9-]+$/.test(name) || /[\r\n]/.test(headerValue))
      throw new Error('Invalid Git HTTP response header');
    if (name.toLowerCase() === 'status') status = Number.parseInt(headerValue, 10);
    else headers[name] = headerValue;
  }
  return { status, headers };
}

export class SmartHttpInputError extends Error {
  readonly statusCode: number;

  constructor(statusCode = 400) {
    super(statusCode === 413 ? 'Git transfer is too large' : 'Invalid Git HTTP request');
    this.statusCode = statusCode;
  }
}
