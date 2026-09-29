export class AppError extends Error {
  constructor(
    public readonly status: number,
    message: string,
    public readonly code: string = 'ERROR',
    public readonly details?: unknown,
  ) {
    super(message);
    this.name = 'AppError';
  }
}

export const badRequest = (message: string, details?: unknown) =>
  new AppError(400, message, 'BAD_REQUEST', details);
export const unauthorized = (message = 'Not authenticated') =>
  new AppError(401, message, 'UNAUTHORIZED');
export const notFound = (message = 'Not found') => new AppError(404, message, 'NOT_FOUND');
export const serviceUnavailable = (message: string) =>
  new AppError(503, message, 'SERVICE_UNAVAILABLE');
