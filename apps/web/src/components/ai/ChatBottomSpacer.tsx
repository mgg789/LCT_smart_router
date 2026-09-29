/**
 * Breathing room under the last message.
 *
 * Clearance for a composer that floats over the thread is the scroller's own
 * `padding-bottom`, which is sized to that composer. This is only the gap that keeps
 * the final line off the very edge: at `35dvh` it left roughly a third of the screen
 * blank under the newest reply on every surface, including the two whose composer does
 * not float at all and needs no clearance whatsoever.
 */
export function ChatBottomSpacer() {
  return <div aria-hidden="true" data-chat-bottom-spacer className="h-6 shrink-0" />;
}
