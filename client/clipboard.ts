// Shared clipboard helper for the byline-slot copy controls
// (copyMarkdown.ts, subscribe.ts). The async Clipboard API is the modern
// path, but it can reject on insecure origins or before a user activation,
// so fall through to a hidden-<textarea> + execCommand path. Returns whether
// the write succeeded so callers can gate their "Copied!" feedback on it.
export async function copyToClipboard(text: string): Promise<boolean> {
  if (navigator.clipboard?.writeText) {
    try {
      await navigator.clipboard.writeText(text);
      return true;
    } catch {
      // fall through to the legacy path
    }
  }
  try {
    const ta = document.createElement("textarea");
    ta.value = text;
    ta.setAttribute("readonly", "");
    ta.style.position = "fixed";
    ta.style.top = "-9999px";
    ta.style.opacity = "0";
    document.body.appendChild(ta);
    ta.select();
    const ok = document.execCommand("copy");
    document.body.removeChild(ta);
    return ok;
  } catch {
    return false;
  }
}
