import { expect, it } from 'vitest';
import { engineerGreeting } from './EngineerAiPane';

it('greets the engineer by their first name and stays unnamed otherwise', () => {
  expect(engineerGreeting('Анна Петрова')).toBe('Анна, с чего начнем сегодня?');
  expect(engineerGreeting('Инженер')).toBe('С чего начнем сегодня?');
  expect(engineerGreeting(null)).toBe('С чего начнем сегодня?');
  expect(engineerGreeting('  ')).toBe('С чего начнем сегодня?');
});
