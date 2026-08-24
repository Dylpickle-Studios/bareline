import { createCipheriv, createHash, createHmac, randomBytes } from 'node:crypto';
import { createReadStream, createWriteStream } from 'node:fs';
import { appendFile, stat, writeFile } from 'node:fs/promises';
import { pipeline } from 'node:stream/promises';
import type { AppConfig } from '../config/config.js';
import type { Database } from '../database/database.js';
import { SecretBox } from '../security/secret-box.js';

export class BackupDestinationService {
  private readonly secrets: SecretBox;
  constructor(
    private readonly database: Database,
    config: AppConfig,
  ) {
    this.secrets = new SecretBox(config.security.masterKey);
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
    const bodyHash = await sha256File(filePath);
    const now = new Date();
    const date = now.toISOString().replace(/[:-]|\.\d{3}/g, '');
    const shortDate = date.slice(0, 8);
    const key = [row.object_prefix, objectName].filter(Boolean).join('/');
    const endpoint = new URL(row.endpoint);
    endpoint.pathname = `/${encodeURIComponent(row.bucket)}/${key.split('/').map(encodeURIComponent).join('/')}`;
    const access = this.secrets.decrypt(
      row.access_key_encrypted,
      `backup-destination:${row.name}:access`,
    );
    const secret = this.secrets.decrypt(
      row.secret_key_encrypted,
      `backup-destination:${row.name}:secret`,
    );
    const headers = `host:${endpoint.host}\nx-amz-content-sha256:${bodyHash}\nx-amz-date:${date}\n`;
    const signedHeaders = 'host;x-amz-content-sha256;x-amz-date';
    const canonical = `PUT\n${endpoint.pathname}\n\n${headers}\n${signedHeaders}\n${bodyHash}`;
    const scope = `${shortDate}/${row.region}/s3/aws4_request`;
    const toSign = `AWS4-HMAC-SHA256\n${date}\n${scope}\n${createHash('sha256').update(canonical).digest('hex')}`;
    const signingKey = hmac(
      hmac(hmac(hmac(`AWS4${secret}`, shortDate), row.region), 's3'),
      'aws4_request',
    );
    const signature = createHmac('sha256', signingKey).update(toSign).digest('hex');
    try {
      const response = await fetch(endpoint, {
        method: 'PUT',
        headers: {
          'x-amz-content-sha256': bodyHash,
          'x-amz-date': date,
          authorization: `AWS4-HMAC-SHA256 Credential=${access}/${scope}, SignedHeaders=${signedHeaders}, Signature=${signature}`,
        },
        body: createReadStream(filePath) as never,
        duplex: 'half',
      } as RequestInit);
      if (!response.ok) throw new Error(`S3 returned HTTP ${String(response.status)}`);
      this.database
        .prepare('UPDATE backup_destinations SET last_success_at=?,last_error=NULL WHERE id=?')
        .run(now.toISOString(), id);
    } catch (error) {
      const message = error instanceof Error ? error.message.slice(0, 500) : 'Upload failed';
      this.database
        .prepare('UPDATE backup_destinations SET last_error=? WHERE id=?')
        .run(message, id);
      throw new BackupDestinationError('Encrypted backup upload failed', 502);
    }
  }

  static async encryptFile(source: string, destination: string, encodedKey: string): Promise<void> {
    const key = Buffer.from(encodedKey, 'base64url');
    if (key.length !== 32)
      throw new BackupDestinationError('Backup encryption key must decode to 32 bytes');
    const nonce = randomBytes(12);
    const cipher = createCipheriv('aes-256-gcm', key, nonce);
    await writeFile(
      destination,
      Buffer.concat([Buffer.from('BARELINE-BACKUP\0', 'ascii'), Buffer.from([1]), nonce]),
      { mode: 0o600, flag: 'wx' },
    );
    await pipeline(
      createReadStream(source),
      cipher,
      createWriteStream(destination, { flags: 'a', mode: 0o600 }),
    );
    await appendFile(destination, cipher.getAuthTag());
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
function hmac(key: string | Buffer, value: string): Buffer {
  return createHmac('sha256', key).update(value).digest();
}
async function sha256File(path: string): Promise<string> {
  const info = await stat(path);
  if (!info.isFile()) throw new BackupDestinationError('Backup upload must be a file');
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(path) as AsyncIterable<Buffer>) hash.update(chunk);
  return hash.digest('hex');
}
function validEndpoint(value: string): string {
  const url = new URL(value);
  if (url.protocol !== 'https:' || url.username || url.password || url.pathname !== '/')
    throw new BackupDestinationError('S3 endpoint must be an HTTPS origin');
  return url.toString();
}
function safeSegment(value: string, label: string): string {
  const result = value.trim();
  if (!/^[A-Za-z0-9._-]{1,100}$/.test(result)) throw new BackupDestinationError(`Invalid ${label}`);
  return result;
}
export class BackupDestinationError extends Error {
  constructor(
    message: string,
    readonly statusCode = 400,
  ) {
    super(message);
  }
}
