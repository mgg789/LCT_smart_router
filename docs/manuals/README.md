# Мануалы (руководства пользователя)

Печатные руководства пользователя NAVIX. Пользовательские документы — на русском
(см. AGENTS.md); этот README — тоже пользовательский, поэтому на русском.

## Состав

| Файл | Что это |
|---|---|
| `engineer-manual.pdf` | **Руководство инженера** — печатная инструкция для выездного инженера (12 страниц A4) |
| `engineer-manual.html` | Исходник руководства: правки текста и вёрстки делаются здесь, затем PDF пересобирается |
| `assets/` | Скриншоты приложения (релиз), логотип `logo-dark.png`, шрифты из `apps/web/public/fonts` |

## Как пересобрать PDF

HTML → PDF через Playwright (страницы A4 заданы в `.page`, `@page { size: A4; margin: 0 }`):

```bash
node <путь>/html2pdf-next.js docs/manuals/engineer-manual.html \
  --output docs/manuals/engineer-manual.pdf --width 210mm --height 297mm
```

`html2pdf-next.js` — из набора PDF-скилла ZCode (`pdf/0.1.7/skills/pdf/scripts/`).
Требуются модуль `playwright` (есть в pnpm-сторе репозитория, подключается через
`NODE_PATH=node_modules/.pnpm/playwright@<ver>/node_modules`) и chromium
(`PLAYWRIGHT_CHROMIUM_PATH`, либо системный Chrome). После сборки выставляются
метаданные PDF (Title/Author/Subject/Creator = NAVIX).

## Стиль

Оформление повторяет приложение инженера (`apps/web/src/figma-engineer`,
дизайн-токены из `apps/web/src/index.css`): фон `#f1f1f1`, чернила `#272930`,
акцент `#ffc72c`, шрифты Murs Gothic (дисплейный) + Inter. Скриншоты лежат рядом
с руководством, чтобы при изменении UI их можно было заменить точечно.
