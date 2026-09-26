import { renderToStaticMarkup } from 'react-dom/server';
import { expect, it } from 'vitest';
import { AiMarkdown, parseAssistantFollowUp } from './AiMarkdown';
import { DashboardAi, DISPATCHER_QUICK_QUESTIONS, thoughtLabel } from './DispatcherAiPane';

it('names the thought duration in Russian', () => {
  expect(thoughtLabel(1)).toBe('Думал 1 секунду');
  expect(thoughtLabel(2)).toBe('Думал 2 секунды');
  expect(thoughtLabel(5)).toBe('Думал 5 секунд');
  expect(thoughtLabel(11)).toBe('Думал 11 секунд');
  expect(thoughtLabel(21)).toBe('Думал 21 секунду');
});

it('renders classic markdown instead of the source marks', () => {
  const html = renderToStaticMarkup(
    <AiMarkdown text={'**жирный** и *курсив*\n\n- пункт\n\n`код`\n\n```\nблок\n```'} />,
  );
  expect(html).toContain('<strong');
  expect(html).toContain('жирный');
  expect(html).toContain('<em');
  expect(html).toContain('<li');
  expect(html).toContain('<code');
  expect(html).toContain('<pre');
  expect(html).not.toContain('**жирный**');
});

it('accepts only bounded, clean assistant-question hashes', () => {
  const question = 'Почему заявка осталась без исполнителя?';
  expect(parseAssistantFollowUp(`#assistant-question=${encodeURIComponent(question)}`)).toBe(
    question,
  );
  expect(parseAssistantFollowUp('https://example.com/help')).toBeNull();
  expect(parseAssistantFollowUp('#assistant-question=')).toBeNull();
  expect(parseAssistantFollowUp('#assistant-question=bad%ZZ')).toBeNull();
  expect(
    parseAssistantFollowUp(`#assistant-question=${encodeURIComponent(`${'x'.repeat(501)}`)}`),
  ).toBeNull();
  expect(
    parseAssistantFollowUp(`#assistant-question=${encodeURIComponent('строка\nвторая')}`),
  ).toBeNull();
  expect(
    parseAssistantFollowUp(`#assistant-question=${encodeURIComponent('javascript:alert(1)')}`),
  ).toBeNull();
  expect(
    parseAssistantFollowUp(`#assistant-question=${encodeURIComponent('вопрос')}&next=1`),
  ).toBeNull();
});

it('renders a follow-up as a draft-only button and preserves safe external markdown links', () => {
  const question = 'Сравни рассчитанные варианты';
  const encoded = encodeURIComponent(question);
  const html = renderToStaticMarkup(
    <AiMarkdown
      text={`[Уточнить сравнение](#assistant-question=${encoded}) и [документация](https://example.com/guide)`}
      onFollowUp={() => undefined}
    />,
  );
  expect(html).toContain('<button type="button"');
  expect(html).toContain('Уточнить сравнение');
  expect(html).not.toContain(`href="#assistant-question=${encoded}"`);
  expect(html).toContain('<a href="https://example.com/guide"');
  expect(html).toContain('target="_blank"');
});

it('disables a valid follow-up button when no draft callback is available', () => {
  const html = renderToStaticMarkup(
    <AiMarkdown text="[Посмотреть контекст](#assistant-question=Посмотреть%20контекст)" />,
  );
  expect(html).toContain('<button type="button" disabled=""');
});

it('renders the dispatcher composer before a session is open', () => {
  const html = renderToStaticMarkup(<DashboardAi token={null} />);
  expect(html).toContain('Спроси меня о чем нибудь...');
  expect(html).toContain('Сообщение ассистенту');
  expect(html).toContain('Загружаем диалог');
});

it('offers generic dispatcher prompts about reasons and calculated alternatives', () => {
  expect(DISPATCHER_QUICK_QUESTIONS).toEqual([
    'Что влияет на назначение заявок?',
    'Сравни рассчитанные варианты плана',
  ]);
});
