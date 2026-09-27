/** Scrollable breathing room keeps the final reply above floating, growing composers. */
export function ChatBottomSpacer() {
  return <div aria-hidden="true" data-chat-bottom-spacer className="h-[35dvh] min-h-40 shrink-0" />;
}
