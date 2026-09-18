import type { CSSProperties, ReactNode } from 'react';

type FigmaIconProps = {
  src: string;
  alt: string;
  width: number;
  height: number;
  className?: string;
  style?: CSSProperties;
};

/**
 * Renders a Figma-exported asset at an exact pixel box.
 * The leaf image always fills the box so intrinsic SVG size cannot blow up.
 */
export function FigmaIcon({ src, alt, width, height, className, style }: FigmaIconProps) {
  return (
    <span
      className={`relative block overflow-clip ${className ?? ''}`}
      style={{ width, height, ...style }}
    >
      <img alt={alt} src={src} className="absolute inset-0 block size-full max-w-none" />
    </span>
  );
}

type FigmaTextProps = {
  children: ReactNode;
  className?: string;
  style?: CSSProperties;
};

/**
 * Applies Figma's cap-height text box so absolute `top` values land on the mockup.
 */
export function FigmaText({ children, className, style }: FigmaTextProps) {
  return (
    <span className={`figma-text block ${className ?? ''}`} style={style}>
      {children}
    </span>
  );
}
