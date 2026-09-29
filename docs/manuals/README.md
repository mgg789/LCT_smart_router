# Мануалы (руководства пользователя)

Печатные руководства пользователя NAVIX. Пользовательские документы — на русском
(см. AGENTS.md); этот README — тоже пользовательский, поэтому на русском.

## Состав

| Файл | Что это |
|---|---|
| `engineer-manual.pdf` | **Руководство инженера** — печатная инструкция для выездного инженера (12 страниц A4) |
| `engineer-manual.html` | Исходник руководства: правки текста и вёрстки делаются здесь, затем PDF пересобирается |
| `dispatcher-manual.pdf` | **Руководство диспетчера** — печатная инструкция по дашборду (17 страниц A4) |
| `dispatcher-manual.html` | Исходник руководства диспетчера |
| `assets/` | Скриншоты приложения (релиз), логотип `logo-dark.png`, шрифты из `apps/web/public/fonts` |

## Как пересобрать PDF

HTML → PDF через Playwright (страницы A4 заданы в `.page`, `@page { size: A4; margin: 0 }`):

```bash
node <путь>/html2pdf-next.js docs/manuals/engineer-manual.html \
  --output docs/manuals/engineer-manual.pdf --width 210mm --height 297mm
```

`html2pdf-next.js` — внешний инструмент PDF-скилла ZCode
(`pdf/0.1.7/skills/pdf/scripts/`), он не входит в этот репозиторий.
Требуются модуль `playwright` (есть в pnpm-сторе репозитория, подключается через
`NODE_PATH=node_modules/.pnpm/playwright@<ver>/node_modules`) и chromium
(`PLAYWRIGHT_CHROMIUM_PATH`, либо системный Chrome). После сборки выставляются
метаданные PDF (Title/Author/Subject/Creator = NAVIX).

Без этого внешнего инструмента можно использовать установленный Playwright.
Из корня репозитория после `pnpm install --frozen-lockfile`, PowerShell:

```powershell
@'
import { chromium } from '@playwright/test';
import { pathToFileURL } from 'node:url';
import { resolve } from 'node:path';

// Use an installed Edge on Windows; omit channel for a Playwright Chromium installation.
const browser = await chromium.launch({ channel: 'msedge', headless: true });
try {
  const page = await browser.newPage();
  await page.goto(pathToFileURL(resolve('docs/manuals/dispatcher-manual.html')).href);
  await page.emulateMedia({ media: 'print' });
  await page.evaluate(() => document.fonts.ready);
  await page.pdf({
    path: 'docs/manuals/dispatcher-manual.pdf',
    printBackground: true,
    preferCSSPageSize: true,
    margin: { top: '0', right: '0', bottom: '0', left: '0' },
  });
} finally {
  await browser.close();
}
'@ | node --input-type=module
```

Для инженера замените имя в двух путях на `engineer-manual`. Зависимости браузера
не устанавливаются этой командой: нужен уже установленный Edge или Chromium
Playwright. Проверьте число страниц (диспетчер 17, инженер 12), шрифты, изображения
и изменённые страницы после печати. `page.pdf` сохраняет заголовок HTML, но для
Author/Subject/Creator требуется отдельное обновление PDF-метаданных.

29.09.2026 руководство диспетчера пересобрано с общим бюджетом AI-объяснений и
актуальными настройками графиков. Проверены страницы 12/15, весь рендер и 17
страниц итогового PDF. Руководство инженера в этом проходе не пересобиралось.

## Стиль

Оформление повторяет приложение инженера (`apps/web/src/figma-engineer`,
дизайн-токены из `apps/web/src/index.css`): фон `#f1f1f1`, чернила `#272930`,
акцент `#ffc72c`, шрифты Murs Gothic (дисплейный) + Inter. Скриншоты лежат рядом
с руководством, чтобы при изменении UI их можно было заменить точечно.
