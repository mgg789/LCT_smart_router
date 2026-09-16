import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

/**
 * Loads a JSON fixture from `test/fixtures`.
 *
 * Deliberately-wrong credentials and other negative-test values live in this data file
 * instead of string literals: they are not secrets, and keeping them out of the compiled
 * sources stops credential scanners from filing them as leaked keys.
 */
export function loadJsonFixture<T>(name: string): T {
  return JSON.parse(readFileSync(resolve(process.cwd(), 'test/fixtures', name), 'utf8')) as T;
}
