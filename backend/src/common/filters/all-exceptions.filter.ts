/**
 * all-exceptions.filter.ts
 * ---------------------------------------------------------------------------
 * Catches EVERY error in the app and turns it into one consistent JSON shape:
 *
 *   { statusCode, error, message, path, requestId, timestamp }
 *
 * Why it matters:
 *  - The frontend only has to understand ONE error format.
 *  - Unexpected crashes never leak stack traces or internal details to users;
 *    the full detail goes to the server log instead, tagged with a request id
 *    so you can find it.
 */
import {
  ArgumentsHost,
  Catch,
  ExceptionFilter,
  HttpException,
  HttpStatus,
  Logger,
} from '@nestjs/common';
import type { Request, Response } from 'express';

@Catch()
export class AllExceptionsFilter implements ExceptionFilter {
  private readonly logger = new Logger(AllExceptionsFilter.name);

  catch(exception: unknown, host: ArgumentsHost): void {
    const ctx = host.switchToHttp();
    const response = ctx.getResponse<Response>();
    const request = ctx.getRequest<Request>();

    let statusCode = HttpStatus.INTERNAL_SERVER_ERROR;
    let error = 'Internal Server Error';
    let message: string | string[] = 'Something went wrong. Please try again later.';

    if (exception instanceof HttpException) {
      // Expected errors (404, 403, validation failures...) are safe to show.
      statusCode = exception.getStatus();
      const body = exception.getResponse();

      if (typeof body === 'string') {
        message = body;
        error = HttpStatus[statusCode] ?? error;
      } else {
        const parsed = body as { message?: string | string[]; error?: string };
        message = parsed.message ?? exception.message;
        error = parsed.error ?? error;
      }
    } else {
      // Unexpected errors: log everything privately, show nothing sensitive.
      const err = exception instanceof Error ? exception : new Error(String(exception));
      this.logger.error(
        { requestId: (request as Request & { id?: string }).id, path: request.url },
        err.stack ?? err.message,
      );
    }

    response.status(statusCode).json({
      statusCode,
      error,
      message,
      path: request.url,
      requestId: (request as Request & { id?: string }).id,
      timestamp: new Date().toISOString(),
    });
  }
}