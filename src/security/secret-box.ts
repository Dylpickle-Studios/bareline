import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';

export class SecretBox {
  private readonly key: Buffer;

  constructor(encodedKey: string | undefined) {
    if (!encodedKey)
      throw new SecretConfigurationError('A security master key is required for encrypted secrets');
    this.key = Buffer.from(encodedKey, 'base64url');
    if (this.key.length !== 32)
      throw new SecretConfigurationError('Security master key must decode to 32 bytes');
  }

  encrypt(plaintext: string, context: string): Buffer {
    const nonce = randomBytes(12);
    const cipher = createCipheriv('aes-256-gcm', this.key, nonce);
    cipher.setAAD(Buffer.from(context, 'utf8'));
    const encrypted = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
    return Buffer.concat([Buffer.from([1]), nonce, cipher.getAuthTag(), encrypted]);
  }

  decrypt(value: Buffer, context: string): string {
    if (value.length < 30 || value[0] !== 1)
      throw new SecretConfigurationError('Encrypted secret format is invalid');
    const nonce = value.subarray(1, 13);
    const tag = value.subarray(13, 29);
    const ciphertext = value.subarray(29);
    const decipher = createDecipheriv('aes-256-gcm', this.key, nonce);
    decipher.setAAD(Buffer.from(context, 'utf8'));
    decipher.setAuthTag(tag);
    return Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString('utf8');
  }
}

export class SecretConfigurationError extends Error {
  readonly statusCode = 503;
}
