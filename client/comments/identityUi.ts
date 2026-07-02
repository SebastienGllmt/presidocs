// methodology.md → Comments — identity/login UI builders (provider sign-in
// links, GDPR privacy notice, avatar). Free functions: they read no
// CommentSystem instance state.

import { loginUrl } from "../identity.ts";

export function buildProviderLink(provider: "google" | "microsoft", label: string): HTMLAnchorElement {
  const a = document.createElement("a");
  a.className = `cmt-identity-provider cmt-identity-provider-${provider}`;
  a.href = loginUrl(provider);
  a.textContent = label;
  return a;
}

// Just-in-time privacy notice rendered directly under the login
// buttons. GDPR Art. 13 wants the legal basis (consent) and a
// pointer to the full notice at the point of collection — exactly
// here, where the user is about to OAuth in and have their name +
// email + provider id recorded. The full Privacy Policy lives at
// /privacy; we link to it rather than reproduce it inline. We
// intentionally use textContent for the body so the link is the
// only HTML node (no innerHTML splicing of attacker-influenced
// strings — same posture as every other interpolation point in
// this file).
export function buildPrivacyNotice(): HTMLElement {
  const wrap = document.createElement("p");
  wrap.className = "cmt-identity-privacy";
  wrap.appendChild(document.createTextNode(
    "Signing in records your name, email, and a provider account ID alongside your comments. See the ",
  ));
  const a = document.createElement("a");
  a.href = "/privacy";
  a.textContent = "Privacy Policy";
  wrap.appendChild(a);
  wrap.appendChild(document.createTextNode("."));
  return wrap;
}

// Small round avatar. Falls back to a colored initial if no picture
// URL (Microsoft accounts often don't return one); also falls back if
// the image errors at load.
export function buildAvatar(picture: string | null, name: string): HTMLElement {
  const wrap = document.createElement("span");
  wrap.className = "cmt-avatar";
  wrap.setAttribute("aria-hidden", "true");
  const initial = (name.trim()[0] ?? "?").toUpperCase();
  wrap.dataset.initial = initial;
  if (picture) {
    const img = document.createElement("img");
    img.src = picture;
    img.alt = "";
    img.referrerPolicy = "no-referrer";
    img.addEventListener("error", () => img.remove());
    wrap.appendChild(img);
  }
  return wrap;
}
