/**
 * Dispatcher-facing view types.
 *
 * The wire contract lives in `@lct/shared`. This file re-exports it so existing
 * dashboard imports keep one path. Absolute times are Unix-epoch seconds.
 */
export type * from '@lct/shared';
