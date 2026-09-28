/**
 * How fast can the screencast actually deliver frames?
 *
 * The page is kept continuously repainting for a fixed stretch, so the measured rate is
 * the capture ceiling rather than a property of whatever happened to animate.
 */
import { chromium } from 'playwright';
import { launchArgs, WEB } from './lib/stand.ts';

const SIZES = [
  { width: 3840, height: 2160 },
  { width: 2880, height: 1620 },
  { width: 1920, height: 1080 },
];
const QUALITIES = [76, 50];

async function measure(
  extraArgs: string[],
  size: { width: number; height: number },
  quality: number,
): Promise<number> {
  const browser = await chromium.launch({ args: [...launchArgs(), ...extraArgs] });
  const context = await browser.newContext({ viewport: size, deviceScaleFactor: 1 });
  const page = await context.newPage();
  await page.goto(WEB, { waitUntil: 'domcontentloaded' });
  // A full-bleed element that repaints every frame, so nothing is idle.
  await page.evaluate(() => {
    const box = document.createElement('div');
    box.style.cssText =
      'position:fixed;inset:0;z-index:99999;background:linear-gradient(90deg,#111,#eee)';
    document.body.append(box);
    const tick = () => {
      box.style.filter = `hue-rotate(${(Date.now() / 4) % 360}deg)`;
      requestAnimationFrame(tick);
    };
    tick();
  });

  const cdp = await context.newCDPSession(page);
  let frames = 0;
  cdp.on('Page.screencastFrame', (frame) => {
    frames += 1;
    void cdp.send('Page.screencastFrameAck', { sessionId: frame.sessionId }).catch(() => {});
  });
  await cdp.send('Page.startScreencast', { format: 'jpeg', quality, everyNthFrame: 1 });
  const started = Date.now();
  await page.waitForTimeout(4000);
  await cdp.send('Page.stopScreencast').catch(() => {});
  const fps = frames / ((Date.now() - started) / 1000);
  await browser.close();
  return fps;
}

async function main() {
  for (const size of SIZES) {
    for (const quality of QUALITIES) {
      const plain = await measure([], size, quality);
      console.log(`${size.width}x${size.height} q${quality}: ${plain.toFixed(1)} fps`);
    }
  }
  const boosted = await measure(
    [
      '--disable-gpu-vsync',
      '--disable-frame-rate-limit',
      '--disable-features=IntensiveWakeUpThrottling',
    ],
    { width: 3840, height: 2160 },
    50,
  );
  console.log(`3840x2160 q50 with frame-rate flags: ${boosted.toFixed(1)} fps`);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
