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
 * Overflow stays visible so stroked SVG icons are not clipped.
 */
export function FigmaIcon({ src, alt, width, height, className, style }: FigmaIconProps) {
  return (
    <img
      alt={alt}
      src={src}
      width={width}
      height={height}
      className={`block max-w-none ${className ?? ''}`}
      style={{ width, height, ...style }}
    />
  );
}

type FigmaTextProps = {
  children: ReactNode;
  className?: string;
  style?: CSSProperties;
  title?: string;
};

/**
 * Applies Figma's cap-height text box so absolute `top` values land on the mockup.
 */
export function FigmaText({ children, className, style, title }: FigmaTextProps) {
  return (
    <span className={`figma-text block ${className ?? ''}`} style={style} title={title}>
      {children}
    </span>
  );
}
