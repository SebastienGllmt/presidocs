// ---------------------------------------------------------------------------
// Drawer lazy-build contract (narrator ↔ comments)
// ---------------------------------------------------------------------------
// The spoken-script drawer's BODY (per-chapter sections + per-segment
// `<article id="spoken-…">` + per-word `<span class="spoken-word">`) is the
// bulk of the narrator's DOM — thousands of nodes on an aligned post. The
// narrator builds only the drawer SHELL (the `<aside>` + tab handle) eagerly
// and defers the body, populating it on demand: when the reader opens the
// drawer, on a `#spoken-…` deep link, or when the comment system asks for it.
//
// The comment system needs the body only when LOGGED IN (a logged-out reader
// sees no comments and can't create any — the common case, and the case
// Lighthouse measures — so the body never builds for them until they open the
// script). These three strings are the cross-module handshake. The narrator
// can't cheaply tell logged-in from out (the session cookie is HttpOnly), so it
// never tries: it defers by default and the comment system — which already
// resolves identity — is the only thing that requests the body. Both modules
// boot lazily in an unknown order, so the handshake is order-independent: the
// requester sets the ATTR (read by the narrator if it boots later) AND fires the
// REQUEST event (caught if the narrator booted already); the narrator fires the
// READY event when the body exists (awaited by a requester that ran first).
//
// This is a NEUTRAL module owned by neither side, so the comment system no
// longer imports it from the narrator's DOM module (narratorDom.ts) just to
// speak the handshake — the dependency arrow between the two features is cut.

// Sentinel on <html> a requester sets so a not-yet-booted narrator builds the
// body as soon as it boots, instead of deferring it.
export const DRAWER_BODY_WANTED_ATTR = "data-narrate-drawer-wanted";
// Fired at `document` to ask an already-booted narrator to build the body now.
export const REQUEST_DRAWER_BODY_EVENT = "narrate:request-drawer-body";
// Fired at `document` once the body exists; the drawer also gets
// `[data-body-ready]` so a late listener can detect the built state directly.
export const DRAWER_BODY_READY_EVENT = "narrate:drawer-body-ready";
