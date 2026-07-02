// The copy-and-flash-"Copied!" affordance shared by the byline copy-markdown
// button, the subscribe menu, the heading-link buttons, and the figure/paragraph
// id buttons. `copyToClipboard` already lives in clipboard.ts; this adds the
// other half each of those controls hand-rolled identically: on a successful
// copy, add a CSS class that drives the "Copied!" cross-fade, then remove it
// after a window — single-flight, so re-triggering restarts the window instead
// of stacking timers.
//
// It's a FACTORY: bind the class + window once per control and reuse the
// returned copier, so the revert timer is captured per control exactly like the
// module-local `feedbackTimer` each one used to keep. (citationLink.ts keeps its
// own version — its revert hides the button rather than just clearing a class.)

import { copyToClipboard } from "./clipboard.ts";

export function copyWithFeedback(
  className: string,
  ms: number,
): (text: string, el: Element) => Promise<boolean> {
  let timer: number | null = null;
  return async (text, el) => {
    const ok = await copyToClipboard(text);
    if (ok) {
      el.classList.add(className);
      if (timer !== null) window.clearTimeout(timer);
      timer = window.setTimeout(() => {
        el.classList.remove(className);
        timer = null;
      }, ms);
    }
    return ok;
  };
}
