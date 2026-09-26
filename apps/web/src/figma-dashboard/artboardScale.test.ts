import { describe, expect, it } from 'vitest';
import { readArtboardCanvas, readArtboardScale } from './artboardScale';

describe('readArtboardScale', () => {
  it('keeps a 1440×1000 window width-bound so the 1800px avatar can scale on-screen', () => {
    expect(readArtboardScale({ width: 1440, height: 1000 })).toBe(0.75);
  });

  it('is 1 on the Figma artboard', () => {
    expect(readArtboardScale({ width: 1920, height: 1080 })).toBe(1);
  });

  it('stops shrinking on a small window, so the page scrolls instead', () => {
    expect(readArtboardScale({ width: 640, height: 480 })).toBe(0.5);
  });
});

describe('readArtboardCanvas', () => {
  it('is the drawing itself on the artboard', () => {
    expect(readArtboardCanvas({ width: 1920, height: 1080 })).toEqual({
      scale: 1,
      width: 1920,
      height: 1080,
    });
  });

  it('gives an ultrawide window its spare width instead of letterboxing it', () => {
    expect(readArtboardCanvas({ width: 2560, height: 1080 })).toEqual({
      scale: 1,
      width: 2560,
      height: 1080,
    });
  });

  it('gives a 16:10 laptop its spare height', () => {
    const canvas = readArtboardCanvas({ width: 1440, height: 900 });
    expect(canvas.scale).toBe(0.75);
    expect(canvas.width).toBe(1920);
    expect(canvas.height).toBe(1200);
  });

  it('paints to the window edge, so no strip of canvas is left over', () => {
    const viewport = { width: 2560, height: 1440 };
    const canvas = readArtboardCanvas(viewport);
    expect(Math.round(canvas.width * canvas.scale)).toBe(viewport.width);
    expect(Math.round(canvas.height * canvas.scale)).toBe(viewport.height);
  });

  it('never reports less than the drawing, so a small screen scrolls', () => {
    const canvas = readArtboardCanvas({ width: 800, height: 600 });
    expect(canvas.scale).toBe(0.5);
    expect(canvas.width).toBe(1920);
    expect(canvas.height).toBe(1200);
  });
});
