/** Every client-facing error: JSON `{ code, message }` (+ optional extra fields such as `feature`). */
export class AppError extends Error {
  constructor(readonly status: number, readonly code: string, message: string, readonly extra: Record<string, unknown> = {}) {
    super(message);
  }
}

export const E = {
  badRequest: (message: string, extra?: Record<string, unknown>) => new AppError(400, 'BAD_REQUEST', message, extra),
  unauthorized: (message = 'Please sign in again') => new AppError(401, 'UNAUTHORIZED', message),
  forbidden: (message = 'Not allowed') => new AppError(403, 'FORBIDDEN', message),
  plusRequired: (feature: string) => new AppError(403, 'PLUS_REQUIRED', 'This is a Sproutly Plus feature', { feature }),
  readOnly: () => new AppError(403, 'READ_ONLY', 'You can only read this conversation'),
  notFound: (what = 'Not found') => new AppError(404, 'NOT_FOUND', what),
  conflict: (message: string, extra?: Record<string, unknown>) => new AppError(409, 'CONFLICT', message, extra),
  rateLimited: (message = 'Slow down a little') => new AppError(429, 'RATE_LIMITED', message),
  unavailable: (code: string, message: string) => new AppError(503, code, message),
};

// ---------- what users see for errors that aren't AppErrors ----------
export const GENERIC_MESSAGE = 'Something went wrong. Please try again.';
const INVALID_INPUT = "That didn't look quite right. Please check and try again.";

/** Zod's built-in wording ("Required", "Expected string, received number", …) is for developers, not users. */
const ZOD_DEFAULT = /^(Required|Expected |Invalid |String must|Number must|Array must|Unrecognized|Too (small|big)|Should be|Unexpected)/;

/** A validation failure's user-facing message: our own wording (e.g. "Message is too long") passes through. */
export function publicValidationMessage(issues: { message: string }[]): string {
  const m = issues[0]?.message;
  return m && !ZOD_DEFAULT.test(m) ? m : INVALID_INPUT;
}

/** Framework (Fastify) 4xx errors carry internal wording like "Body cannot be empty when content-type is set to…". */
export function publicHttpMessage(status: number): { code: string; message: string } {
  if (status === 401) return { code: 'UNAUTHORIZED', message: 'Please sign in again' };
  if (status === 403) return { code: 'FORBIDDEN', message: 'Not allowed' };
  if (status === 404) return { code: 'NOT_FOUND', message: 'Not found' };
  if (status === 413) return { code: 'TOO_LARGE', message: 'That is too big to send' };
  if (status === 429) return { code: 'RATE_LIMITED', message: 'Slow down a little' };
  return { code: 'BAD_REQUEST', message: INVALID_INPUT };
}
