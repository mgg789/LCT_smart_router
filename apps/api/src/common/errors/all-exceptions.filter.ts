import {
  type ArgumentsHost,
  Catch,
  type ExceptionFilter,
  HttpException,
  HttpStatus,
  Logger,
} from '@nestjs/common';
import type { Response } from 'express';
import { currentRequestId } from '../logging/request-context';
import type { ErrorCode } from './error-codes';
import type { ErrorResponseBody } from './error-response';
import { SysError } from './sys.error';

/**
 * Single translation point from thrown value to HTTP response.
 *
 * Unknown failures are logged with their stack but answered with a bare
 * `INTERNAL_ERROR`: an internal message may name tables, queries or configuration, and
 * none of that belongs in a client-facing body.
 */
@Catch()
export class AllExceptionsFilter implements ExceptionFilter {
  private readonly logger = new Logger(AllExceptionsFilter.name);

  catch(exception: unknown, host: ArgumentsHost): void {
    const response = host.switchToHttp().getResponse<Response>();
    const { status, body } = this.translate(exception);

    if (status >= HttpStatus.INTERNAL_SERVER_ERROR) {
      const stack = exception instanceof Error ? exception.stack : undefined;
      this.logger.error(
        `Unhandled failure: ${exception instanceof Error ? exception.message : String(exception)}`,
        stack,
      );
    }

    response.status(status).json(body);
  }

  private translate(exception: unknown): { status: number; body: ErrorResponseBody } {
    const requestId = currentRequestId() ?? null;

    if (exception instanceof SysError) {
      return {
        status: exception.status,
        body: {
          error: {
            code: exception.code,
            message: exception.message,
            details: exception.details,
            requestId,
          },
        },
      };
    }

    if (exception instanceof HttpException) {
      const status = exception.getStatus();
      return {
        status,
        body: {
          error: {
            code: this.codeForHttpStatus(status),
            message: exception.message,
            details: {},
            requestId,
          },
        },
      };
    }

    return {
      status: HttpStatus.INTERNAL_SERVER_ERROR,
      body: {
        error: {
          code: 'INTERNAL_ERROR',
          message: 'Internal error',
          details: {},
          requestId,
        },
      },
    };
  }

  private codeForHttpStatus(status: number): ErrorCode {
    switch (status) {
      case HttpStatus.UNAUTHORIZED:
        return 'UNAUTHENTICATED';
      case HttpStatus.FORBIDDEN:
        return 'FORBIDDEN';
      case HttpStatus.NOT_FOUND:
        return 'NOT_FOUND';
      case HttpStatus.CONFLICT:
        return 'VERSION_CONFLICT';
      case HttpStatus.UNPROCESSABLE_ENTITY:
      case HttpStatus.BAD_REQUEST:
        return 'VALIDATION_FAILED';
      default:
        return 'INTERNAL_ERROR';
    }
  }
}
