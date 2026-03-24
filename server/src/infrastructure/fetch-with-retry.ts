/** ネットワーク一時障害（EHOSTUNREACH 等）に対応するリトライ付き fetch ラッパー */

const DEFAULT_MAX_RETRIES = 3;
const DEFAULT_BASE_DELAY_MS = 1000;

/** リトライ対象とするエラーかどうかを判定 */
function isRetryableError(err: unknown): boolean {
  if (!(err instanceof TypeError)) return false;
  const cause = (err as TypeError & { cause?: { code?: string } }).cause;
  if (!cause || typeof cause.code !== 'string') return false;
  const retryableCodes = new Set([
    'EHOSTUNREACH',
    'ECONNRESET',
    'ECONNREFUSED',
    'ETIMEDOUT',
    'ENETUNREACH',
    'EAI_AGAIN',
    'UND_ERR_CONNECT_TIMEOUT',
  ]);
  return retryableCodes.has(cause.code);
}

export interface FetchWithRetryOptions {
  maxRetries?: number;
  baseDelayMs?: number;
}

/**
 * fetch をリトライ付きで実行する。
 * ネットワーク一時障害の場合のみ指数バックオフでリトライし、
 * それ以外のエラーはそのまま throw する。
 */
export async function fetchWithRetry(
  input: string | URL | Request,
  init?: RequestInit,
  options?: FetchWithRetryOptions,
): Promise<Response> {
  const maxRetries = options?.maxRetries ?? DEFAULT_MAX_RETRIES;
  const baseDelay = options?.baseDelayMs ?? DEFAULT_BASE_DELAY_MS;

  let lastError: unknown;

  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      return await fetch(input, init);
    } catch (err) {
      lastError = err;
      if (!isRetryableError(err) || attempt === maxRetries) {
        throw err;
      }
      const delay = baseDelay * 2 ** attempt;
      console.warn(
        `[fetch-retry] attempt ${attempt + 1}/${maxRetries + 1} failed, retrying in ${delay}ms...`,
      );
      await new Promise((r) => setTimeout(r, delay));
    }
  }

  throw lastError;
}
