export const DEFAULT_CODEX_STREAM_ERROR_MESSAGE = 'Codex stream stopped before completing.';

const nonEmptyString = (value: unknown): string | null => {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
};

const parsePayload = (payload: unknown): unknown => {
  if (typeof payload !== 'string') return payload;
  const trimmed = payload.trim();
  if (!trimmed) return null;

  try {
    return JSON.parse(trimmed);
  } catch {
    return trimmed;
  }
};

export function extractCodexStreamErrorMessage(payload: unknown): string {
  const parsed = parsePayload(payload);
  const direct = nonEmptyString(parsed);
  if (direct) return direct;

  if (!parsed || typeof parsed !== 'object') {
    return DEFAULT_CODEX_STREAM_ERROR_MESSAGE;
  }

  const record = parsed as Record<string, unknown>;
  const directField =
    nonEmptyString(record.message) ||
    nonEmptyString(record.error) ||
    nonEmptyString(record.reason) ||
    nonEmptyString(record.code);
  if (directField) return directField;

  if (record.error && typeof record.error === 'object') {
    const nested = record.error as Record<string, unknown>;
    const nestedField =
      nonEmptyString(nested.message) ||
      nonEmptyString(nested.error) ||
      nonEmptyString(nested.reason) ||
      nonEmptyString(nested.code);
    if (nestedField) return nestedField;
  }

  return DEFAULT_CODEX_STREAM_ERROR_MESSAGE;
}

export function formatCodexStreamError(payload: unknown): string {
  return `\n\n**Codex stopped:** ${extractCodexStreamErrorMessage(payload)}`;
}
