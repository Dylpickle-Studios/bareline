import { createCipheriv, createHash, createHmac, randomBytes, randomUUID } from 'node:crypto';
import { lookup } from 'node:dns/promises';
import { createReadStream, createWriteStream } from 'node:fs';
import { request as httpsRequest } from 'node:https';
import { isIP } from 'node:net';
import { appendFile, link, rm, stat, writeFile } from 'node:fs/promises';
import { pipeline } from 'node:stream/promises';
import type { AppConfig } from '../config/config.js';
import type { Database } from '../database/database.js';
import { SecretBox } from '../security/secret-box.js';

export interface ResolvedBackupEndpoint {
  address: string;
  family: 4 | 6;
}

export interface BackupDestinationPolicy {
  /** Maximum source bytes accepted by one upload. Defaults to limits.archiveBytes. */
  maxUploadBytes?: number;
  /** Maximum response bytes accepted from the remote endpoint. */
  maxResponseBytes?: number;
  /** Wall-clock limit for DNS resolution and the HTTPS request. */
  timeoutMs?: number;
  /** Deployment hook for an additional explicit egress/endpoint allowlist. */
  validateEndpoint?: (endpoint: URL) => void | Promise<void>;
  /** Optional resolver for deployments with a controlled DNS boundary. */
  resolveEndpoint?: (hostname: string) => Promise<readonly ResolvedBackupEndpoint[]>;
}

const defaultTimeoutMs = 30_000;
const defaultResponseBytes = 64 * 1024;

export class BackupDestinationService {
  private readonly secrets: SecretBox;
  private readonly policy: Required<
    Pick<BackupDestinationPolicy, 'maxUploadBytes' | 'maxResponseBytes' | 'timeoutMs'>
  > &
    Omit<BackupDestinationPolicy, 'maxUploadBytes' | 'maxResponseBytes' | 'timeoutMs'>;

  constructor(
    private readonly database: Database,
    config: AppConfig,
    policy: BackupDestinationPolicy = {},
  ) {
    this.secrets = new SecretBox(config.security.masterKey);
    this.policy = {
      ...policy,
      maxUploadBytes: policy.maxUploadBytes ?? config.limits.archiveBytes,
      maxResponseBytes: policy.maxResponseBytes ?? defaultResponseBytes,
      timeoutMs: policy.timeoutMs ?? defaultTimeoutMs,
    };
    validatePositiveLimit(this.policy.maxUploadBytes, 'maximum upload size');
    validatePositiveLimit(this.policy.maxResponseBytes, 'maximum response size');
    validatePositiveLimit(this.policy.timeoutMs, 'upload timeout');
  }

  save(
    actorUserId: number,
    input: {
      name: string;
      endpoint: string;
      region: string;
      bucket: string;
      prefix: string;
      accessKey: string;
      secretKey: string;
    },
  ): void {
    const name = input.name.trim();
    const endpoint = validEndpoint(input.endpoint);
    const region = safeSegment(input.region, 'region');
    const bucket = safeSegment(input.bucket, 'bucket');
    const prefix = input.prefix.replace(/^\/+|\/+$/g, '');
    if (!name || name.length > 100 || prefix.includes('..') || prefix.length > 500)
      throw new BackupDestinationError('Invalid backup destination');
    if (!input.accessKey || !input.secretKey)
      throw new BackupDestinationError(
        'Backup credentials are required through the protected environment',
      );
    const context = `backup-destination:${name}`;
    this.database
      .prepare(
        `INSERT INTO backup_destinations(name, endpoint, region, bucket, object_prefix,
      access_key_encrypted, secret_key_encrypted, created_by, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(name) DO UPDATE SET endpoint=excluded.endpoint, region=excluded.region, bucket=excluded.bucket,
      object_prefix=excluded.object_prefix, access_key_encrypted=excluded.access_key_encrypted,
      secret_key_encrypted=excluded.secret_key_encrypted, enabled=1`,
      )
      .run(
        name,
        endpoint,
        region,
        bucket,
        prefix,
        this.secrets.encrypt(input.accessKey, `${context}:access`),
        this.secrets.encrypt(input.secretKey, `${context}:secret`),
        actorUserId,
        new Date().toISOString(),
      );
  }

  list() {
    return this.database
      .prepare(
        `SELECT id,name,endpoint,region,bucket,object_prefix AS objectPrefix,enabled,
      last_success_at AS lastSuccessAt,last_error AS lastError FROM backup_destinations ORDER BY name`,
      )
      .all();
  }

  async upload(id: number, filePath: string, objectName: string): Promise<void> {
    const row = this.database
      .prepare('SELECT * FROM backup_destinations WHERE id=? AND enabled=1')
      .get(id) as DestinationRow | undefined;
    if (!row) throw new BackupDestinationError('Backup destination not found', 404);
    const body = await sha256File(filePath, this.policy.maxUploadBytes);
    const now = new Date();
    const date = now.toISOString().replace(/[:-]|\.\d{3}/g, '');
    const shortDate = date.slice(0, 8);
    const object = safeObjectName(objectName);
    const key = [row.object_prefix, object].filter(Boolean).join('/');
    const endpoint = new URL(validEndpoint(row.endpoint));
    endpoint.pathname = `/${encodeURIComponent(row.bucket)}/${key.split('/').map(encodeURIComponent).join('/')}`;
    const access = this.secrets.decrypt(
      row.access_key_encrypted,
      `backup-destination:${row.name}:access`,
    );
    const secret = this.secrets.decrypt(
      row.secret_key_encrypted,
      `backup-destination:${row.name}:secret`,
    );
    const headers = `host:${endpoint.host}\nx-amz-content-sha256:${body.sha256}\nx-amz-date:${date}\n`;
    const signedHeaders = 'host;x-amz-content-sha256;x-amz-date';
    const canonical = `PUT\n${endpoint.pathname}\n\n${headers}\n${signedHeaders}\n${body.sha256}`;
    const scope = `${shortDate}/${row.region}/s3/aws4_request`;
    const toSign = `AWS4-HMAC-SHA256\n${date}\n${scope}\n${createHash('sha256').update(canonical).digest('hex')}`;
    const signingKey = hmac(
      hmac(hmac(hmac(`AWS4${secret}`, shortDate), row.region), 's3'),
      'aws4_request',
    );
    const signature = createHmac('sha256', signingKey).update(toSign).digest('hex');
    try {
      await this.policy.validateEndpoint?.(endpoint);
      const addresses = await this.resolveEndpoint(normalizeHostname(endpoint.hostname));
      const address = addresses[0];
      if (!address) throw new BackupDestinationError('Backup endpoint did not resolve', 502);
      await putFile(
        address,
        endpoint,
        filePath,
        {
          'content-length': String(body.bytes),
          'x-amz-content-sha256': body.sha256,
          'x-amz-date': date,
          authorization: `AWS4-HMAC-SHA256 Credential=${access}/${scope}, SignedHeaders=${signedHeaders}, Signature=${signature}`,
        },
        this.policy.timeoutMs,
        this.policy.maxResponseBytes,
      );
      this.database
        .prepare('UPDATE backup_destinations SET last_success_at=?,last_error=NULL WHERE id=?')
        .run(now.toISOString(), id);
    } catch (error) {
      const message = error instanceof Error ? error.message.slice(0, 500) : 'Upload failed';
      this.database
        .prepare('UPDATE backup_destinations SET last_error=? WHERE id=?')
        .run(message, id);
      if (error instanceof BackupDestinationError && error.statusCode < 500) throw error;
      throw new BackupDestinationError('Encrypted backup upload failed', 502);
    }
  }

  static async encryptFile(source: string, destination: string, encodedKey: string): Promise<void> {
    const key = Buffer.from(encodedKey, 'base64url');
    if (key.length !== 32)
      throw new BackupDestinationError('Backup encryption key must decode to 32 bytes');
    const nonce = randomBytes(12);
    const cipher = createCipheriv('aes-256-gcm', key, nonce);
    const temporary = `${destination}.staging-${randomUUID()}`;
    try {
      await writeFile(
        temporary,
        Buffer.concat([Buffer.from('BARELINE-BACKUP\0', 'ascii'), Buffer.from([1]), nonce]),
        { mode: 0o600, flag: 'wx' },
      );
      await pipeline(
        createReadStream(source),
        cipher,
        createWriteStream(temporary, { flags: 'a', mode: 0o600 }),
      );
      await appendFile(temporary, cipher.getAuthTag());
      await link(temporary, destination);
    } finally {
      await rm(temporary, { force: true });
    }
  }

  private async resolveEndpoint(hostname: string): Promise<readonly ResolvedBackupEndpoint[]> {
    const addresses = this.policy.resolveEndpoint
      ? await withTimeout(
          this.policy.resolveEndpoint(hostname),
          this.policy.timeoutMs,
          'Backup endpoint resolution timed out',
        )
      : await withTimeout(
          lookup(hostname, { all: true, verbatim: true }).then((results) =>
            results.map((result) => ({ address: result.address, family: result.family as 4 | 6 })),
          ),
          this.policy.timeoutMs,
          'Backup endpoint resolution timed out',
        );
    if (!addresses.length || addresses.some((address) => !isAllowedPublicAddress(address)))
      throw new BackupDestinationError(
        'Backup endpoint resolves to a forbidden network address',
        400,
      );
    return addresses;
  }
}

interface DestinationRow {
  name: string;
  endpoint: string;
  region: string;
  bucket: string;
  object_prefix: string;
  access_key_encrypted: Buffer;
  secret_key_encrypted: Buffer;
}

interface FileDigest {
  bytes: number;
  sha256: string;
}

function hmac(key: string | Buffer, value: string): Buffer {
  return createHmac('sha256', key).update(value).digest();
}

async function sha256File(path: string, maxBytes: number): Promise<FileDigest> {
  const info = await stat(path);
  if (!info.isFile()) throw new BackupDestinationError('Backup upload must be a file');
  if (info.size > maxBytes)
    throw new BackupDestinationError('Backup upload exceeds the configured maximum size', 413);
  const hash = createHash('sha256');
  let bytes = 0;
  for await (const chunk of createReadStream(path) as AsyncIterable<Buffer>) {
    bytes += chunk.length;
    if (bytes > maxBytes)
      throw new BackupDestinationError('Backup upload exceeds the configured maximum size', 413);
    hash.update(chunk);
  }
  return { bytes, sha256: hash.digest('hex') };
}

async function putFile(
  address: ResolvedBackupEndpoint,
  endpoint: URL,
  filePath: string,
  headers: Record<string, string>,
  timeoutMs: number,
  maxResponseBytes: number,
): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    let settled = false;
    const request = httpsRequest(
      {
        hostname: address.address,
        port: endpoint.port ? Number(endpoint.port) : 443,
        path: `${endpoint.pathname}${endpoint.search}`,
        method: 'PUT',
        headers: { ...headers, host: endpoint.host },
        servername: normalizeHostname(endpoint.hostname),
        rejectUnauthorized: true,
        timeout: timeoutMs,
      },
      (response) => {
        const contentLength = Number(response.headers['content-length'] ?? '');
        if (Number.isFinite(contentLength) && contentLength > maxResponseBytes) {
          response.resume();
          fail(
            new BackupDestinationError(
              'Backup endpoint response exceeds the configured limit',
              502,
            ),
          );
          return;
        }
        let responseBytes = 0;
        response.on('data', (chunk: Buffer | string) => {
          responseBytes += Buffer.byteLength(chunk);
          if (responseBytes > maxResponseBytes) {
            response.resume();
            fail(
              new BackupDestinationError(
                'Backup endpoint response exceeds the configured limit',
                502,
              ),
            );
          }
        });
        response.once('error', fail);
        response.once('end', () => {
          if (response.statusCode && response.statusCode >= 200 && response.statusCode < 300)
            finish();
          else fail(new Error(`S3 returned HTTP ${String(response.statusCode ?? 0)}`));
        });
      },
    );
    const timer = setTimeout(
      () => request.destroy(new Error('Backup upload timed out')),
      timeoutMs,
    );
    const finish = () => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve();
    };
    const fail = (error: unknown) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      request.destroy();
      reject(error instanceof Error ? error : new Error('Backup upload failed'));
    };
    request.once('timeout', () => request.destroy(new Error('Backup upload timed out')));
    request.once('error', fail);
    const body = createReadStream(filePath);
    body.once('error', fail);
    body.pipe(request, { end: true });
  });
}

function validEndpoint(value: string): string {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new BackupDestinationError('S3 endpoint must be an HTTPS origin');
  }
  const hostname = normalizeHostname(url.hostname);
  const hostnameFamily = isIP(hostname);
  if (
    url.protocol !== 'https:' ||
    url.username ||
    url.password ||
    url.pathname !== '/' ||
    url.search ||
    url.hash ||
    (url.port && url.port !== '443') ||
    !hostname ||
    isDisallowedHostname(hostname) ||
    (hostnameFamily !== 0 &&
      !isAllowedPublicAddress({ address: hostname, family: hostnameFamily as 4 | 6 }))
  )
    throw new BackupDestinationError('S3 endpoint must be a public HTTPS origin');
  return url.toString();
}

function normalizeHostname(hostname: string): string {
  return hostname.replace(/^\[|\]$/g, '');
}

function safeObjectName(value: string): string {
  const object = value.trim();
  if (
    !object ||
    object.length > 1024 ||
    object.includes('\0') ||
    object.split('/').some((part) => !part || part === '.' || part === '..')
  )
    throw new BackupDestinationError('Invalid backup object name');
  return object;
}

function safeSegment(value: string, label: string): string {
  const result = value.trim();
  if (!/^[A-Za-z0-9._-]{1,100}$/.test(result)) throw new BackupDestinationError(`Invalid ${label}`);
  return result;
}

function validatePositiveLimit(value: number, label: string): void {
  if (!Number.isSafeInteger(value) || value <= 0)
    throw new BackupDestinationError(`Invalid ${label}`);
}

function isDisallowedHostname(hostname: string): boolean {
  const normalized = hostname.toLowerCase().replace(/\.$/, '');
  return (
    normalized === 'localhost' || normalized.endsWith('.localhost') || normalized.endsWith('.local')
  );
}

function isAllowedPublicAddress(value: ResolvedBackupEndpoint): boolean {
  const normalizedAddress = value.address.replace(/^\[|\]$/g, '');
  if (isIP(normalizedAddress) !== value.family) return false;
  const family = value.family;
  if (family === 4) {
    const octets = normalizedAddress.split('.').map(Number);
    if (
      octets.length !== 4 ||
      octets.some((octet) => !Number.isInteger(octet) || octet < 0 || octet > 255)
    )
      return false;
    const [first, second, third] = octets;
    if (first === undefined || second === undefined || third === undefined) return false;
    return !(
      first === 0 ||
      first === 10 ||
      first === 127 ||
      (first === 100 && second >= 64 && second <= 127) ||
      (first === 169 && second === 254) ||
      (first === 172 && second >= 16 && second <= 31) ||
      (first === 192 && second === 0) ||
      (first === 192 && second === 168) ||
      (first === 198 && (second === 18 || second === 19 || second === 51)) ||
      (first === 203 && second === 0 && third === 113) ||
      first >= 224
    );
  }
  const normalized = normalizedAddress.toLowerCase();
  if (normalized.startsWith('::ffff:')) {
    const mapped = normalized.slice('::ffff:'.length);
    if (isIP(mapped) === 4) return isAllowedPublicAddress({ address: mapped, family: 4 });
  }
  return !(
    normalized === '::' ||
    normalized === '::1' ||
    normalized.startsWith('fc') ||
    normalized.startsWith('fd') ||
    normalized.startsWith('fe8') ||
    normalized.startsWith('fe9') ||
    normalized.startsWith('fea') ||
    normalized.startsWith('feb') ||
    normalized.startsWith('ff') ||
    normalized.startsWith('::ffff:10.') ||
    normalized.startsWith('::ffff:127.') ||
    normalized.startsWith('::ffff:192.168.') ||
    normalized.startsWith('::ffff:169.254.')
  );
}

async function withTimeout<T>(promise: Promise<T>, timeoutMs: number, message: string): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<T>((_resolve, reject) => {
        timer = setTimeout(() => {
          reject(new BackupDestinationError(message, 504));
        }, timeoutMs);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

export class BackupDestinationError extends Error {
  constructor(
    message: string,
    readonly statusCode = 400,
  ) {
    super(message);
  }
}
