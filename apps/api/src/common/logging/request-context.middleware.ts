import { Injectable, type NestMiddleware } from '@nestjs/common';
import type { NextFunction, Request, Response } from 'express';
import { newRequestId, runWithRequestContext } from './request-context';

/** Header a caller may supply to join its own trace to ours. */
export const REQUEST_ID_HEADER = 'x-request-id';

@Injectable()
export class RequestContextMiddleware implements NestMiddleware {
  use(req: Request, res: Response, next: NextFunction): void {
    const incoming = req.header(REQUEST_ID_HEADER);
    const requestId = incoming && incoming.length <= 128 ? incoming : newRequestId();
    res.setHeader(REQUEST_ID_HEADER, requestId);
    runWithRequestContext({ requestId }, () => next());
  }
}
