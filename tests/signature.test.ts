import { describe, expect, it } from 'vitest';
import { signatureInfo, tagVerificationInfo } from '../src/git/git-browser.js';

describe('signature presentation', () => {
  it('never equates cryptographic validity with a trusted identity', () => {
    const signature = signatureInfo('G', 'Example signer', 'ABCD', '012345');
    expect(signature).toMatchObject({
      state: 'valid',
      identityTrusted: false,
      signer: 'Example signer',
      fingerprint: '012345',
    });
    expect(signature.label).toContain('identity not trusted');
  });

  it('distinguishes unsigned, bad, unavailable-key, and verification errors', () => {
    expect(signatureInfo('N').state).toBe('unsigned');
    expect(signatureInfo('B').state).toBe('invalid');
    expect(signatureInfo('?').state).toBe('unknown');
    expect(signatureInfo('E').state).toBe('error');
  });

  it('maps tag verifier diagnostics without exposing them to the UI', () => {
    const valid = tagVerificationInfo(
      0,
      '[GNUPG:] GOODSIG ABCD Example Signer\n[GNUPG:] VALIDSIG 012345 2026-01-01',
    );
    expect(valid).toMatchObject({
      state: 'valid',
      signer: 'Example Signer',
      keyId: 'ABCD',
      fingerprint: '012345',
      identityTrusted: false,
    });
    expect(tagVerificationInfo(1, '[GNUPG:] NO_PUBKEY ABCD').state).toBe('unknown');
    expect(tagVerificationInfo(1, '[GNUPG:] BADSIG ABCD Example').state).toBe('invalid');
    expect(tagVerificationInfo(128, '/private/path: verifier failed').state).toBe('error');
  });
});
