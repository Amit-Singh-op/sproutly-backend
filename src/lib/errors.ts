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
