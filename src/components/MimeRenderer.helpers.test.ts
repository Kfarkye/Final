import { describe, it, expect } from 'vitest';
import {
  normalizeBase64,
  decodeBase64UTF8,
  maybeWrapJson,
  DATA_URI_RE,
} from './MimeRenderer';

// ── FIX #3: base64url normalization + repadding ──────────────────────────
describe('normalizeBase64', () => {
  it('maps url-safe "-" to "+"', () => {
    expect(normalizeBase64('-w==')).toBe('+w==');
  });
  it('maps url-safe "_" to "/"', () => {
    expect(normalizeBase64('_w==')).toBe('/w==');
  });
  it('strips whitespace and newlines', () => {
    expect(normalizeBase64('aG\nVs bG8=')).toBe('aGVsbG8=');
  });
  it('re-pads length remainder 2', () => {
    expect(normalizeBase64('aGVsbG')).toBe('aGVsbG==');
  });
  it('re-pads length remainder 3', () => {
    expect(normalizeBase64('aGk')).toBe('aGk=');
  });
  it('throws on impossible length (remainder 1)', () => {
    expect(() => normalizeBase64('aGVsb')).toThrow(/Invalid Base64 length/);
  });
  it('leaves already-padded standard base64 untouched', () => {
    expect(normalizeBase64('aGVsbG8=')).toBe('aGVsbG8=');
  });
});

// ── FIX #3: full decode (runs in jsdom/browser env with atob + TextDecoder) ─
// NOTE: requires a DOM-like test environment (`environment: 'jsdom'` in Vitest)
describe('decodeBase64UTF8', () => {
  const b64 = (s: string) => btoa(unescape(encodeURIComponent(s)));
  const b64url = (s: string) => b64(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');

  it('decodes standard base64', () => {
    expect(decodeBase64UTF8(b64('hello world'))).toBe('hello world');
  });
  it('decodes URL-safe base64 (base64url)', () => {
    expect(decodeBase64UTF8(b64url('café+/data'))).toBe('café+/data');
  });
  it('decodes UTF-8 multibyte (é)', () => {
    expect(decodeBase64UTF8(b64('café'))).toBe('café');
  });
  it('decodes 4-byte emoji', () => {
    expect(decodeBase64UTF8(b64('😀'))).toBe('😀');
  });
  it('tolerates whitespace/newlines in payload', () => {
    const chunked = b64('multi line payload').match(/.{1,4}/g)!.join('\n');
    expect(decodeBase64UTF8(chunked)).toBe('multi line payload');
  });
  it('throws on malformed payload', () => {
    expect(() => decodeBase64UTF8('aGVsb')).toThrow(/Invalid Base64/);
  });
});

// ── FIX #2: data URI regex matches multi-line payloads ───────────────────
describe('DATA_URI_RE', () => {
  it('matches a multi-line base64 image payload', () => {
    const uri = 'data:image/png;base64,iVBOR\nw0KGg==';
    const m = uri.match(DATA_URI_RE);
    expect(m).not.toBeNull();
    expect(m![1]).toBe('image/png');
    expect(m![2]).toBe('base64');
  });
  it('matches a single-line plain payload', () => {
    const m = 'data:text/plain,hello'.match(DATA_URI_RE);
    expect(m![3]).toBe('hello');
  });
  it('matches google-apps mail mime', () => {
    const m = 'data:application/vnd.google-apps.mail;base64,e30='.match(DATA_URI_RE);
    expect(m![1]).toBe('application/vnd.google-apps.mail');
  });
  it('captures the charset/encoding parameter', () => {
    const m = 'data:text/html;charset=utf-8,<b>hi</b>'.match(DATA_URI_RE);
    expect(m![2]).toBe('charset=utf-8');
    expect(m![3]).toBe('<b>hi</b>');
  });
  it('REGRESSION: old single-line regex would reject multi-line', () => {
    const OLD = /^data:([^;,]+)(?:;([^,]+))?,(.*)$/;
    const multiline = 'data:image/png;base64,iVB\nOR==';
    expect(OLD.test(multiline)).toBe(false); // the bug
    expect(DATA_URI_RE.test(multiline)).toBe(true); // the fix
  });
});

// ── FIX #4: JSON auto-fence is opt-in / non-surprising ───────────────────
describe('maybeWrapJson', () => {
  it('does NOT wrap a flat single-line array', () => {
    expect(maybeWrapJson('[1,2,3]')).toBe('[1,2,3]');
  });
  it('does NOT wrap a flat scalar-only object', () => {
    expect(maybeWrapJson('{"a":1}')).toBe('{"a":1}');
  });
  it('wraps a nested object', () => {
    expect(maybeWrapJson('{"a":{"b":1}}')).toMatch(/^```json\n/);
  });
  it('wraps a multi-line object', () => {
    expect(maybeWrapJson('{\n  "a": 1\n}')).toMatch(/^```json\n/);
  });
  it('wraps an array of objects', () => {
    expect(maybeWrapJson('[{"x":1}]')).toMatch(/^```json\n/);
  });
  it('passes through prose containing brackets', () => {
    expect(maybeWrapJson('hello [world]')).toBe('hello [world]');
  });
  it('passes through invalid JSON unchanged', () => {
    expect(maybeWrapJson('{not json}')).toBe('{not json}');
  });
  it('passes through plain prose unchanged', () => {
    expect(maybeWrapJson('just text')).toBe('just text');
  });
});
