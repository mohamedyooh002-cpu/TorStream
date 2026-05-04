/**
 * Input validation utilities
 */

/**
 * Validate that a value is a non-empty string within length limits
 */
export function validateString(value: unknown, fieldName: string, minLen = 1, maxLen = 1000): string {
  if (typeof value !== 'string') {
    throw new Error(`${fieldName} must be a string`);
  }
  const trimmed = value.trim();
  if (trimmed.length < minLen) {
    throw new Error(`${fieldName} must be at least ${minLen} characters`);
  }
  if (trimmed.length > maxLen) {
    throw new Error(`${fieldName} must be at most ${maxLen} characters`);
  }
  return trimmed;
}

/**
 * Validate a magnet URI
 */
export function validateMagnetUri(uri: unknown): string {
  if (typeof uri !== 'string') {
    throw new Error('Magnet URI must be a string');
  }
  const trimmed = uri.trim();
  if (!trimmed.startsWith('magnet:?')) {
    throw new Error('Invalid magnet URI format');
  }
  if (trimmed.length > 2000) {
    throw new Error('Magnet URI too long');
  }
  return trimmed;
}

/**
 * Validate an info hash (40 hex characters)
 */
export function validateInfoHash(hash: unknown): string {
  if (typeof hash !== 'string') {
    throw new Error('Info hash must be a string');
  }
  const trimmed = hash.trim().toLowerCase();
  if (!/^[a-f0-9]{40}$/.test(trimmed)) {
    throw new Error('Invalid info hash format (must be 40 hex characters)');
  }
  return trimmed;
}

/**
 * Validate a UUID
 */
export function validateUuid(id: unknown): string {
  if (typeof id !== 'string') {
    throw new Error('ID must be a string');
  }
  const trimmed = id.trim();
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(trimmed)) {
    throw new Error('Invalid UUID format');
  }
  return trimmed;
}

/**
 * Validate pagination parameters
 */
export function validatePagination(page: unknown, limit: unknown): { page: number; limit: number } {
  const p = typeof page === 'string' ? parseInt(page, 10) : (typeof page === 'number' ? page : 1);
  const l = typeof limit === 'string' ? parseInt(limit, 10) : (typeof limit === 'number' ? limit : 20);

  if (isNaN(p) || p < 1) {
    return { page: 1, limit: Math.min(Math.max(l, 1), 100) || 20 };
  }
  return {
    page: p,
    limit: Math.min(Math.max(l, 1), 100)
  };
}

/**
 * Validate sort parameter against allowed values
 */
export function validateSort(sort: unknown, allowed: string[], defaultSort: string): string {
  if (typeof sort !== 'string') return defaultSort;
  if (allowed.includes(sort)) return sort;
  return defaultSort;
}

/**
 * Sanitize input to prevent XSS — strip HTML tags
 */
export function sanitizeHtml(input: unknown): string {
  if (typeof input !== 'string') return '';
  return input
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#039;');
}

/**
 * Validate admin login credentials
 */
export function validateLoginBody(body: unknown): { username: string; password: string } {
  if (!body || typeof body !== 'object') {
    throw new Error('Request body must be an object');
  }
  const b = body as Record<string, unknown>;
  const username = validateString(b.username, 'username', 1, 100);
  const password = validateString(b.password, 'password', 1, 200);
  return { username, password };
}

/**
 * Validate download request body
 */
export function validateDownloadBody(body: unknown): { magnetUri: string; infoHash: string } {
  if (!body || typeof body !== 'object') {
    throw new Error('Request body must be an object');
  }
  const b = body as Record<string, unknown>;
  const magnetUri = validateMagnetUri(b.magnetUri);
  const infoHash = validateInfoHash(b.infoHash);
  return { magnetUri, infoHash };
}

/**
 * Validate batch download request body
 */
export function validateBatchDownloadBody(body: unknown): Array<{ magnetUri: string; infoHash: string }> {
  if (!body || typeof body !== 'object') {
    throw new Error('Request body must be an object');
  }
  const b = body as Record<string, unknown>;
  if (!Array.isArray(b.items) || b.items.length === 0) {
    throw new Error('items must be a non-empty array');
  }
  if (b.items.length > 20) {
    throw new Error('Maximum 20 items per batch');
  }
  return b.items.map((item: unknown, i: number) => {
    try {
      return validateDownloadBody(item);
    } catch (err) {
      throw new Error(`Item ${i}: ${(err as Error).message}`);
    }
  });
}

/**
 * Validate search-and-cache request body
 */
export function validateSearchAndCacheBody(body: unknown): { query: string; maxResults: number } {
  if (!body || typeof body !== 'object') {
    throw new Error('Request body must be an object');
  }
  const b = body as Record<string, unknown>;
  const query = validateString(b.query, 'query', 2, 200);
  const maxResults = typeof b.maxResults === 'number'
    ? Math.min(Math.max(b.maxResults, 1), 20)
    : 5;
  return { query, maxResults };
}
