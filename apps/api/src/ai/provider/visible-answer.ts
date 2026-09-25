const OPEN_TAG = '<think>';
const CLOSE_TAG = '</think>';

/**
 * Drops a `<think>...</think>` span from text the model put in the answer channel.
 *
 * DeepSeek's scratchpad normally arrives in the separate `reasoning_content` field, which
 * this filter never sees. A few compatible models still wrap the same monologue in
 * `content`. The dispatcher only receives what is outside the span. An unclosed span is
 * discarded: that text never became an answer. Tag matching is case-insensitive, and a
 * tag split across chunks is held until the next chunk decides it.
 */
export function createVisibleAnswerFilter(): {
  push(chunk: string): string;
  finish(): string;
} {
  let skipping = false;
  let hold = '';

  const take = (chunk: string, flushing: boolean): string => {
    let input = hold + chunk;
    hold = '';
    let visible = '';
    while (input.length > 0) {
      if (skipping) {
        const end = input.toLowerCase().indexOf(CLOSE_TAG);
        if (end === -1) {
          if (!flushing) {
            hold = tagTail(input, CLOSE_TAG);
          }
          return visible;
        }
        input = input.slice(end + CLOSE_TAG.length);
        skipping = false;
        continue;
      }
      const start = input.toLowerCase().indexOf(OPEN_TAG);
      if (start === -1) {
        if (flushing) {
          visible += input;
          return visible;
        }
        const tail = tagTail(input, OPEN_TAG);
        visible += input.slice(0, input.length - tail.length);
        hold = tail;
        return visible;
      }
      visible += input.slice(0, start);
      input = input.slice(start + OPEN_TAG.length);
      skipping = true;
    }
    return visible;
  };

  return {
    push: (chunk) => take(chunk, false),
    finish: () => take('', true),
  };
}

/** Longest suffix of `text` that is a proper prefix of `tag`. */
function tagTail(text: string, tag: string): string {
  const max = Math.min(text.length, tag.length - 1);
  const lower = text.toLowerCase();
  for (let size = max; size > 0; size -= 1) {
    if (tag.startsWith(lower.slice(-size))) {
      return text.slice(-size);
    }
  }
  return '';
}
