import { createDecipheriv, randomBytes } from 'node:crypto';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { BackupDestinationService } from '../src/backup/backup-destination-service.js';

describe('off-site backup encryption', () => {
  it('writes a versioned authenticated envelope that does not contain plaintext', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'bareline-backup-envelope-'));
    const source = join(directory, 'backup.tar');
    const destination = join(directory, 'backup.enc');
    const plaintext = Buffer.from('private repository backup contents');
    const key = randomBytes(32);
    writeFileSync(source, plaintext);
    await BackupDestinationService.encryptFile(source, destination, key.toString('base64url'));
    const encrypted = readFileSync(destination);
    expect(encrypted.includes(plaintext)).toBe(false);
    expect(encrypted.subarray(0, 16).toString('ascii')).toBe('BARELINE-BACKUP\0');
    expect(encrypted[16]).toBe(1);
    const decipher = createDecipheriv('aes-256-gcm', key, encrypted.subarray(17, 29));
    decipher.setAuthTag(encrypted.subarray(-16));
    expect(Buffer.concat([decipher.update(encrypted.subarray(29, -16)), decipher.final()])).toEqual(
      plaintext,
    );
  });
});
