import { describe, expect, it, vi } from 'vitest';
import {
  SOURCE_API_NONCE,
  isSourcePathBlocked,
  sourceAuthGate,
} from './source.routes';

function createMockResponse() {
  const res = {
    status: vi.fn(),
    json: vi.fn(),
  };
  res.status.mockReturnValue(res);
  return res;
}

describe('Source API security gate', () => {
  it('rejects requests without the source nonce', () => {
    const req = { headers: {}, hostname: 'reverie.example', ip: '203.0.113.10' };
    const res = createMockResponse();
    const next = vi.fn();

    sourceAuthGate(req as any, res as any, next);

    expect(next).not.toHaveBeenCalled();
    expect(res.status).toHaveBeenCalledWith(403);
    expect(res.json).toHaveBeenCalledWith({ error: 'Source API is internal-only. Access denied.' });
  });

  it('does not trust a forged Host: localhost request', () => {
    const req = { headers: { host: 'localhost' }, hostname: 'localhost', ip: '203.0.113.10' };
    const res = createMockResponse();
    const next = vi.fn();

    sourceAuthGate(req as any, res as any, next);

    expect(next).not.toHaveBeenCalled();
    expect(res.status).toHaveBeenCalledWith(403);
  });

  it('allows requests with the boot-generated source nonce', () => {
    const req = {
      headers: { 'x-source-nonce': SOURCE_API_NONCE },
      hostname: 'reverie.example',
      ip: '127.0.0.1',
    };
    const res = createMockResponse();
    const next = vi.fn();

    sourceAuthGate(req as any, res as any, next);

    expect(next).toHaveBeenCalledOnce();
    expect(res.status).not.toHaveBeenCalled();
  });
});

describe('Source API blocked path policy', () => {
  it('does not block harmless source files that contain credential words', () => {
    expect(isSourcePathBlocked('src/components/CredentialVault.tsx')).toBe(false);
    expect(isSourcePathBlocked('src/lib/secretManager.ts')).toBe(false);
  });

  it('blocks secret-bearing file conventions and key material', () => {
    const blockedPaths = [
      '.env.production',
      'credentials/.env',
      'config/credentials.json',
      'config/google-application-credentials.yaml',
      'config/service-account.json',
      'config/app-secrets.yml',
      'certs/server.pfx',
      'certs/cert.crt',
      'certs/client.cer',
      'keys/id_rsa',
      'keys/id_ed25519',
      'keys/private.pem',
      'keys/private.key',
      'keys/bundle.p12',
    ];

    for (const path of blockedPaths) {
      expect(isSourcePathBlocked(path), path).toBe(true);
    }
  });
});
