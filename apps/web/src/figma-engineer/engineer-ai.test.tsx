import { expect, it } from 'vitest';
import { engineerGreeting, ENGINEER_QUICK_QUESTIONS } from './EngineerAiPane';

it('greets the engineer by their first name and stays unnamed otherwise', () => {
  expect(engineerGreeting('Анна Петрова')).toBe('Анна, с чего начнем сегодня?');
  expect(engineerGreeting('Инженер')).toBe('С чего начнем сегодня?');
  expect(engineerGreeting(null)).toBe('С чего начнем сегодня?');
  expect(engineerGreeting('  ')).toBe('С чего начнем сегодня?');
});

it('offers three contextual first-turn questions for an engineer', () => {
  expect(ENGINEER_QUICK_QUESTIONS).toEqual([
    'Покажи контекст моего выезда',
    'Помоги разобраться в проблеме',
    'Я уже проверил … что дальше?',
  ]);
});
