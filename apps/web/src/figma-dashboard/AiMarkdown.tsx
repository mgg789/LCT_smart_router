import type { Components } from 'react-markdown';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';

const ASSISTANT_QUESTION_PREFIX = '#assistant-question=';
const MAX_FOLLOW_UP_LENGTH = 500;
const DANGEROUS_SCHEME = /^\s*(?:javascript|data|vbscript|file):/i;

/** Decodes only the assistant-question hash produced by the API, rejecting unsafe or malformed values. */
export function parseAssistantFollowUp(href: string | undefined): string | null {
  if (!href?.startsWith(ASSISTANT_QUESTION_PREFIX)) return null;
  const encoded = href.slice(ASSISTANT_QUESTION_PREFIX.length);
  if (encoded.length === 0 || /[&#?]/.test(encoded)) return null;

  try {
    const question = decodeURIComponent(encoded).trim();
    if (
      question.length === 0 ||
      question.length > MAX_FOLLOW_UP_LENGTH ||
      Array.from(question).some((character) => {
        const code = character.charCodeAt(0);
        return code < 32 || (code >= 127 && code <= 159);
      }) ||
      DANGEROUS_SCHEME.test(question) ||
      encodeURIComponent(question) !== encoded
    ) {
      return null;
    }
    return question;
  } catch {
    return null;
  }
}

/** Renders a model reply, turning trusted follow-up hashes into draft-only buttons. */
export function AiMarkdown({
  text,
  onFollowUp,
}: {
  text: string;
  onFollowUp?: (question: string) => void;
}) {
  const components: Components = {
    h1: ({ children }) => (
      <h2 className="mb-[8px] text-[1.2em] font-semibold leading-[1.3]">{children}</h2>
    ),
    h2: ({ children }) => (
      <h3 className="mb-[8px] text-[1.1em] font-semibold leading-[1.3]">{children}</h3>
    ),
    h3: ({ children }) => (
      <h4 className="mb-[6px] text-[1em] font-semibold leading-[1.3]">{children}</h4>
    ),
    p: ({ children }) => <p className="mb-[12px] leading-[1.45] last:mb-0">{children}</p>,
    strong: ({ children }) => <strong className="font-semibold">{children}</strong>,
    em: ({ children }) => <em className="italic">{children}</em>,
    del: ({ children }) => <del className="text-figma-muted">{children}</del>,
    a: ({ href, children }) => {
      const question = parseAssistantFollowUp(href);
      if (question !== null) {
        return (
          <button
            type="button"
            disabled={!onFollowUp}
            onClick={() => onFollowUp?.(question)}
            className="rounded-sm text-left underline decoration-figma-muted underline-offset-2 transition-colors hover:text-figma-muted focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-figma-ink disabled:cursor-not-allowed disabled:opacity-50"
          >
            {children}
          </button>
        );
      }
      if (!href) return <span>{children}</span>;
      return (
        <a
          href={href}
          className="underline decoration-figma-muted underline-offset-2"
          target="_blank"
          rel="noreferrer"
        >
          {children}
        </a>
      );
    },
    ul: ({ children }) => (
      <ul className="mb-[12px] list-disc space-y-[6px] pl-[22px] text-figma-muted last:mb-0">
        {children}
      </ul>
    ),
    ol: ({ children }) => (
      <ol className="mb-[12px] list-decimal space-y-[6px] pl-[22px] last:mb-0">{children}</ol>
    ),
    li: ({ children }) => <li className="leading-[1.45]">{children}</li>,
    blockquote: ({ children }) => (
      <blockquote className="mb-[12px] border-l-2 border-figma-muted pl-[14px] text-figma-muted last:mb-0">
        {children}
      </blockquote>
    ),
    hr: () => <hr className="my-[16px] border-figma-track" />,
    code: ({ className, children }) =>
      className ? (
        <code className="font-mono text-[0.75em]">{children}</code>
      ) : (
        <code className="rounded-[6px] bg-figma-track px-[6px] py-[1px] font-mono text-[0.75em]">
          {children}
        </code>
      ),
    pre: ({ children }) => (
      <pre className="mb-[12px] overflow-x-auto rounded-[16px] bg-figma-ink px-[16px] py-[14px] text-[0.75em] leading-[1.45] text-white last:mb-0">
        {children}
      </pre>
    ),
    table: ({ children }) => (
      <div className="mb-[12px] overflow-x-auto last:mb-0">
        <table className="w-full border-collapse text-left text-[0.8em]">{children}</table>
      </div>
    ),
    th: ({ children }) => (
      <th className="border-b border-figma-track px-[8px] py-[6px] font-semibold">{children}</th>
    ),
    td: ({ children }) => (
      <td className="border-b border-figma-track px-[8px] py-[6px]">{children}</td>
    ),
    input: ({ checked }) => (
      <input
        type="checkbox"
        checked={Boolean(checked)}
        readOnly
        className="mr-[8px] align-middle"
      />
    ),
  };
  return (
    <div className="ai-markdown text-[length:inherit] font-medium tracking-[-0.272px] text-figma-ink">
      <ReactMarkdown remarkPlugins={[remarkGfm]} components={components}>
        {text}
      </ReactMarkdown>
    </div>
  );
}
