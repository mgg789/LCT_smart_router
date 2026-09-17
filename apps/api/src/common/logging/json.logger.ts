import type { LoggerService, LogLevel } from '@nestjs/common';
import { currentRequestId } from './request-context';

const LEVEL_ORDER: Record<string, number> = { debug: 10, info: 20, warn: 30, error: 40 };

function describe(message: unknown): string {
  if (typeof message === 'string') {
    return message;
  }
  if (message instanceof Error) {
    return message.message;
  }
  try {
    return JSON.stringify(message) ?? String(message);
  } catch {
    return String(message);
  }
}

type Level = 'debug' | 'info' | 'warn' | 'error';

/**
 * One structured line per event on stdout.
 *
 * Container logs are the only place these end up, so the format has to be greppable by
 * machine and readable by a human at a demo. Secrets never reach here: login codes,
 * passwords and token values are not passed to the logger at their call sites.
 */
export class JsonLogger implements LoggerService {
  private readonly threshold: number;

  constructor(level: Level = 'info') {
    this.threshold = LEVEL_ORDER[level] ?? LEVEL_ORDER.info ?? 20;
  }

  log(message: unknown, context?: string): void {
    this.write('info', message, context);
  }

  error(message: unknown, stack?: string, context?: string): void {
    this.write('error', message, context, stack);
  }

  warn(message: unknown, context?: string): void {
    this.write('warn', message, context);
  }

  debug(message: unknown, context?: string): void {
    this.write('debug', message, context);
  }

  verbose(message: unknown, context?: string): void {
    this.write('debug', message, context);
  }

  setLogLevels?(_levels: LogLevel[]): void {
    // Levels are owned by LOG_LEVEL in the environment, not by Nest's runtime switch.
  }

  private write(level: Level, message: unknown, context?: string, stack?: string): void {
    if ((LEVEL_ORDER[level] ?? 0) < this.threshold) {
      return;
    }
    const entry: Record<string, unknown> = {
      ts: new Date().toISOString(),
      level,
      msg: describe(message),
    };
    // Nest hands the bootstrap failure to the logger as an Error, whose own enumerable
    // properties are empty -- serializing it directly would print `{}` and hide the
    // reason the process cannot start.
    if (message instanceof Error && !stack) {
      entry.stack = message.stack;
    }
    if (context) {
      entry.context = context;
    }
    const requestId = currentRequestId();
    if (requestId) {
      entry.requestId = requestId;
    }
    if (stack) {
      entry.stack = stack;
    }
    const line = JSON.stringify(entry);
    if (level === 'error') {
      process.stderr.write(`${line}\n`);
    } else {
      process.stdout.write(`${line}\n`);
    }
  }
}
