import type { Variants } from 'framer-motion';
import { motion } from 'framer-motion';
import { Fragment } from 'react';
import { cn } from '../../lib/cn';
import type { BlockNode, InlineNode } from '../../lib/markdown';
import { parseMarkdown } from '../../lib/markdown';

export interface MarkdownProps {
  text: string;
  /**
   * Reveal for one word. Given the word's place in the whole answer, it returns
   * the delay before it appears; returning 0 for every word shows the answer at
   * once.
   */
  wordDelay?: (index: number) => number;
  /** Variants the word spans animate with, when there is an animation at all. */
  wordVariants?: Variants;
  className?: string;
}

/** Splits a run into words and the spaces between them, both kept. */
function pieces(text: string): string[] {
  return text.split(/(\s+)/).filter((piece) => piece.length > 0);
}

/**
 * Draws one run, word by word, so a long answer still arrives as it is written.
 *
 * The counter is shared across the whole answer rather than restarted per block:
 * otherwise the first word of every paragraph would appear at the same moment
 * and the reveal would read as a stack rather than a sentence.
 */
function Run({
  node,
  counter,
  wordDelay,
  wordVariants,
}: {
  node: InlineNode;
  counter: { at: number };
  wordDelay?: (index: number) => number;
  wordVariants?: Variants;
}) {
  const className =
    node.kind === 'bold'
      ? 'font-semibold'
      : node.kind === 'italic'
        ? 'italic'
        : node.kind === 'code'
          ? 'rounded bg-muted px-1.5 py-0.5 font-mono text-[0.9em]'
          : undefined;

  return (
    <span className={className}>
      {pieces(node.text).map((piece, index) => {
        if (/^\s+$/.test(piece)) {
          // biome-ignore lint/suspicious/noArrayIndexKey: a space's place in its run is its identity; the text never reorders.
          return <Fragment key={index}>{piece}</Fragment>;
        }
        const at = counter.at;
        counter.at += 1;
        return (
          <motion.span
            className="inline-block"
            custom={wordDelay ? wordDelay(at) : 0}
            // biome-ignore lint/suspicious/noArrayIndexKey: as above — position is identity here.
            key={index}
            variants={wordVariants}
          >
            {piece}
          </motion.span>
        );
      })}
    </span>
  );
}

function Block({
  block,
  counter,
  wordDelay,
  wordVariants,
}: {
  block: BlockNode;
  counter: { at: number };
  wordDelay?: (index: number) => number;
  wordVariants?: Variants;
}) {
  const runs = (inline: InlineNode[]) =>
    inline.map((node, index) => (
      <Run
        counter={counter}
        // biome-ignore lint/suspicious/noArrayIndexKey: a run's place in its line is its identity.
        key={index}
        node={node}
        wordDelay={wordDelay}
        wordVariants={wordVariants}
      />
    ));

  if (block.kind === 'heading') {
    const size =
      block.level === 1 ? 'text-[24px]' : block.level === 2 ? 'text-[21px]' : 'text-[19px]';
    return <p className={cn('mt-5 font-semibold first:mt-0', size)}>{runs(block.inline)}</p>;
  }

  if (block.kind === 'list') {
    const Tag = block.ordered ? 'ol' : 'ul';
    return (
      <Tag
        className={cn(
          'mt-3 space-y-1 pl-6 first:mt-0',
          block.ordered ? 'list-decimal' : 'list-disc',
        )}
      >
        {block.items.map((item, index) => (
          // biome-ignore lint/suspicious/noArrayIndexKey: an item's place in its list is its identity.
          <li key={index}>{runs(item)}</li>
        ))}
      </Tag>
    );
  }

  return <p className="mt-3 first:mt-0">{runs(block.inline)}</p>;
}

/**
 * Renders the little Markdown an assistant answer uses.
 *
 * Nothing is turned into HTML on the way: the text is parsed into a tree and
 * drawn as elements, so a model cannot put markup into the page by writing it.
 */
export function Markdown({ text, wordDelay, wordVariants, className }: MarkdownProps) {
  const blocks = parseMarkdown(text);
  const counter = { at: 0 };

  return (
    <div className={className}>
      {blocks.map((block, index) => (
        <Block
          block={block}
          counter={counter}
          // biome-ignore lint/suspicious/noArrayIndexKey: a block's place in the answer is its identity.
          key={index}
          wordDelay={wordDelay}
          wordVariants={wordVariants}
        />
      ))}
    </div>
  );
}
