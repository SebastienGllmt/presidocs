// methodology.md → Comments — card rendering: a card per thread/draft with its
// anchor preview, reply list, and composer. `buildComposer` also owns the
// submit / draft-promote / author-resolve / delete mutation routing (closures),
// so it moves here whole.

import type { CommentSystem } from "../comments.ts";
import {
  contextOf,
  graphicTargetId,
  isDeleted,
  isTextTarget,
  textTargetParts,
  visibleReplies,
  type Reply,
  type Thread,
} from "../commentsStore.ts";
import type { ResolutionEnvelope } from "../resolutionsApi.ts";
import { buildAvatar } from "./identityUi.ts";
import { anchorNameForGraphic, anchorNameForText } from "./highlights.ts";
import { buildDiffPreview } from "./suggestionDiff.ts";
import { uid } from "./util.ts";

function formatRelative(timestamp: number): string {
  const diff = Date.now() - timestamp;
  const min = 60_000;
  if (diff < min) return "just now";
  if (diff < 60 * min) return `${Math.floor(diff / min)}m ago`;
  if (diff < 24 * 60 * min) return `${Math.floor(diff / (60 * min))}h ago`;
  return new Date(timestamp).toLocaleDateString();
}

export class CardRenderer {
  constructor(private readonly sys: CommentSystem) {}

  // Build a single card. Cards reflect both saved threads and unsubmitted
  // drafts; we distinguish them via `data-draft="true"` so CSS can frame
  // drafts distinctly and so the composer's Cancel button can do the
  // right thing (discard the draft entirely vs. just clear the reply box).
  buildCard(thread: Thread): HTMLElement {
    const isDraft = this.sys.draftMgr.drafts.includes(thread);
    const isText = isTextTarget(thread.target);
    const isStale = !isDraft && isText && this.sys.threadIsStale(thread);

    const isNarration = contextOf(thread.target) === "narration";

    const card = document.createElement("article");
    card.className = "cmt-card";
    card.dataset.threadId = thread.id;
    card.dataset.kind = isText ? "text" : "graphic";
    // Lets CSS tint narration comments distinctly from article ones.
    card.dataset.context = isNarration ? "narration" : "article";
    if (isDraft) card.dataset.draft = "true";
    if (isStale) card.dataset.stale = "true";
    // Bind the card to its CSS anchor. Text threads anchor to their
    // first highlight span (stamped in `renderAll` after wrapping);
    // narration threads anchor to the article element their segment
    // maps to (stamped here, since `narrationArticleAnchor` is the
    // resolver); graphic threads anchor to the graphic root
    // (stamped in `installGraphicTriggers`). The desktop CSS uses
    // this anchor for `top: anchor(top)`. We stash it on the card and
    // apply it via `applyCardAnchor`, which on MOBILE re-points the card
    // under the comments button instead (the one-menu dropdown).
    if (isTextTarget(thread.target)) {
      const anchorName = anchorNameForText(thread.id);
      card.dataset.anchorName = anchorName;
      if (isNarration) {
        const articleAnchor = this.sys.narrationArticleAnchor(thread);
        articleAnchor?.style.setProperty("anchor-name", anchorName);
      }
    } else {
      card.dataset.anchorName = anchorNameForGraphic(graphicTargetId(thread.target));
    }
    this.sys.applyCardAnchor(card);
    // Mobile: render as a native popover so the platform handles
    // top-layer placement, light-dismiss, ESC, and focus return.
    // Desktop leaves the attribute off so the card sits inline in
    // the column. The MQL handler flips this on viewport-cross.
    if (this.sys.isMobile) card.popover = "auto";
    // The platform fires `toggle` whenever the popover state flips
    // (programmatic show/hide, light-dismiss, ESC). Sync our
    // `activeCardId` to the "closed" half so a platform-driven
    // close doesn't strand us thinking the popover is still open.
    // The `activeCardId === thread.id` guard makes a switch
    // (close A → open B) a no-op for A's toggle, since by the time
    // A's queued event fires we've already moved activeCardId to B.
    card.addEventListener("toggle", (e) => {
      const ev = e as ToggleEvent;
      if (ev.newState === "closed" && this.sys.activeCardId === thread.id) {
        this.sys.activeCardId = null;
      }
    });

    // --- Anchor preview ---
    const preview = document.createElement("div");
    preview.className = "cmt-anchor-preview";
    if (isTextTarget(thread.target)) {
      // A SAVED suggestion shows the diff (struck original, inserted proposed)
      // right in the anchor preview; a draft shows the plain quote here and the
      // live-updating diff lives in the composer's editor below.
      if (thread.suggestion && !isDraft) {
        preview.appendChild(
          buildDiffPreview(textTargetParts(thread.target).quote, thread.suggestion.proposed),
        );
      } else {
        const quote = document.createElement("span");
        quote.className = "cmt-quote-text";
        quote.textContent = textTargetParts(thread.target).quote;
        preview.appendChild(quote);
      }
      if (isStale) {
        const tag = document.createElement("span");
        tag.className = "cmt-stale-tag";
        tag.textContent = "outdated";
        preview.appendChild(tag);
      }
      // Narration comments get an explicit speaker button to jump the
      // player to (and play) the segment they sit on — a deliberate
      // press, so reading the comment never starts audio by accident.
      // The button doubles as the visual marker that this is a comment
      // on the spoken track rather than the article.
      if (isNarration) {
        const speaker = document.createElement("button");
        speaker.type = "button";
        speaker.className = "cmt-play-narration";
        speaker.title = "Play this part of the narration";
        speaker.setAttribute("aria-label", "Play this part of the narration");
        speaker.innerHTML =
          '<svg width="14" height="14" viewBox="0 0 24 24" aria-hidden="true">' +
          '<path d="M4 9v6h4l5 5V4L8 9H4z" fill="currentColor"/>' +
          '<path d="M16 8.5a4 4 0 0 1 0 7" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"/>' +
          "</svg>";
        speaker.addEventListener("click", (e) => {
          e.preventDefault();
          e.stopPropagation();
          this.sys.playThreadAudio(thread);
        });
        preview.appendChild(speaker);
      }
    } else {
      const span = document.createElement("span");
      span.className = "cmt-quote-text";
      span.textContent = "Comment on graphic";
      preview.appendChild(span);
    }
    card.appendChild(preview);

    // --- Existing replies (excluding tombstoned deletes) ---
    const liveReplies = visibleReplies(thread);
    if (liveReplies.length > 0) {
      const list = document.createElement("ol");
      list.className = "cmt-reply-list";
      for (const reply of liveReplies) {
        list.appendChild(this.buildReplyLi(reply, thread));
      }
      card.appendChild(list);
    }

    // --- Composer ---
    card.appendChild(this.buildComposer(thread, isDraft, isStale));

    // Clicking anywhere on a card sets it as "active" so we can highlight
    // its anchor in the article. Doesn't capture clicks on buttons / the
    // textarea (those have their own handlers).
    card.addEventListener("click", (e) => {
      // Ignore clicks on interactive children — they bubble here but we
      // don't want to steal focus from textarea/buttons.
      const t = e.target as HTMLElement | null;
      if (t && t.closest("button, textarea")) return;
      this.sys.scrollAnchorIntoView(thread);
    });

    return card;
  }

  private buildReplyLi(reply: Reply, thread: Thread): HTMLLIElement {
    const li = document.createElement("li");
    li.className = "cmt-reply";

    const meta = document.createElement("div");
    meta.className = "cmt-reply-meta";
    const authorWrap = document.createElement("span");
    authorWrap.className = "cmt-reply-author-wrap";
    // Email is stored in the CRDT but deliberately not rendered to other
    // readers — only the blog author (future feature) needs it. Avatar +
    // name is the public face of each reply.
    const displayName = reply.authorName || reply.authorEmail || "Unknown";
    authorWrap.appendChild(buildAvatar(reply.authorPicture ?? null, displayName));
    const author = document.createElement("span");
    author.className = "cmt-reply-author";
    author.textContent = displayName;
    authorWrap.appendChild(author);
    const time = document.createElement("time");
    time.className = "cmt-reply-time";
    time.dateTime = new Date(reply.createdAt).toISOString();
    time.textContent = formatRelative(reply.createdAt);
    // The delete × lives inside the meta row (last item), so the row's
    // flex alignment keeps it on the same baseline as the author/time —
    // no magic top offset to track the font's line metrics.
    const del = document.createElement("button");
    del.type = "button";
    del.className = "cmt-reply-delete";
    del.setAttribute("aria-label", "Delete this comment");
    del.innerHTML =
      '<svg width="12" height="12" viewBox="0 0 24 24" aria-hidden="true">' +
      '<path d="M6 6l12 12M18 6L6 18" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"/></svg>';
    del.addEventListener("click", (e) => {
      e.stopPropagation();
      this.deleteReply(thread, reply.id);
    });
    meta.appendChild(authorWrap);
    meta.appendChild(time);
    // Origin provenance tag (debugging aid, author-only like the thread-id
    // chip). Per REPLY, not per thread — origin is a per-blob fact and one
    // thread can mix origins (a prod-born thread carrying the author's
    // localhost scaffolding replies). Gated on `hasSeededOrigins`: tags
    // render only where origins MIX, and then EVERY derived reply gets one
    // ("prod" or "local") so a missing label is never ambiguous shorthand
    // for local — it means derivation didn't cover the reply. One rule, no
    // environment branch: a single-origin store (prod) never opens the
    // gate, because its blobs carry no metadata.
    if (this.sys.isAuthorMode() && this.sys.store?.hasSeededOrigins()) {
      const origin = this.sys.store.replyOrigin(reply.id);
      if (origin) {
        const originTag = document.createElement("span");
        originTag.className = `cmt-origin-tag cmt-origin-tag--${origin === "production" ? "prod" : "local"}`;
        // Short display label; the title carries the full story.
        originTag.textContent = origin === "production" ? "prod" : "local";
        originTag.title =
          origin === "production"
            ? "This reply was born in the production comment store (seeded here for local authoring)"
            : "This reply was born in this dev server's local store";
        meta.appendChild(originTag);
      }
    }
    meta.appendChild(del);
    li.appendChild(meta);

    const text = document.createElement("p");
    text.className = "cmt-reply-text";
    text.textContent = reply.body;
    li.appendChild(text);

    return li;
  }

  private buildComposer(thread: Thread, isDraft: boolean, isStale: boolean): HTMLElement {
    const composer = document.createElement("div");
    composer.className = "cmt-composer";

    // A suggestion draft (proposal 65) gets an editable "proposed text" box
    // above the note, prefilled with the anchored quote, plus a live word-diff.
    // Editing it mutates the draft's payload in place (persisted on every
    // keystroke, so a reload restores it) and re-renders the diff.
    const isSuggestionDraft = isDraft && !!thread.suggestion;
    if (isSuggestionDraft && isTextTarget(thread.target)) {
      const sug = thread.suggestion!;
      const original = textTargetParts(thread.target).quote;
      const label = document.createElement("span");
      label.className = "cmt-suggest-label";
      label.textContent = "Your suggested edit";
      const sta = document.createElement("textarea");
      sta.className = "cmt-suggest-input";
      sta.rows = 2;
      sta.value = sug.proposed;
      sta.setAttribute("aria-label", "Suggested replacement text");
      sta.addEventListener("click", (e) => e.stopPropagation());
      let diffBox = buildDiffPreview(original, sug.proposed);
      // The model value + persistence update on every keystroke (state stays
      // correct, crash-safe), but the WORD-DIFF is debounced: recomputing it
      // synchronously per keystroke made fast typing on a large suggestion
      // janky (jsdiff is ~O(n·d)). It refreshes ~150ms after you pause.
      let diffTimer = 0;
      sta.addEventListener("input", () => {
        sug.proposed = sta.value;
        this.sys.draftMgr.persistDrafts();
        window.clearTimeout(diffTimer);
        diffTimer = window.setTimeout(() => {
          const next = buildDiffPreview(original, sug.proposed);
          diffBox.replaceWith(next); // stale node after a re-render → harmless no-op
          diffBox = next;
        }, 150);
      });
      composer.appendChild(label);
      composer.appendChild(sta);
      composer.appendChild(diffBox);
    }

    const ta = document.createElement("textarea");
    ta.className = "cmt-reply-input";
    ta.rows = isDraft ? 3 : 2;
    ta.placeholder = isSuggestionDraft ? "Add a note (optional)…" : isDraft ? "Comment…" : "Reply…";
    // Restore any persisted in-progress body for this draft so a reload
    // (or a re-render from a poll tick) doesn't blank what the user was
    // typing. Saved threads always start with an empty reply field —
    // bodies are only persisted for unsubmitted drafts.
    if (isDraft) {
      const saved = this.sys.draftMgr.draftBodies.get(thread.id);
      if (saved) ta.value = saved;
      // Persist every keystroke. The localStorage write is cheap and
      // synchronous; debouncing would only matter at thousand-keystroke
      // scales which we won't hit on a comment composer.
      ta.addEventListener("input", () => {
        this.sys.draftMgr.draftBodies.set(thread.id, ta.value);
        this.sys.draftMgr.persistDrafts();
      });
    } else {
      // Replies to saved threads get the same render-surviving buffer, but
      // in-memory only (see `replyBodies`). Without it, opening a new
      // comment mid-reply rebuilds this card with an empty box and the
      // typed reply is lost — the focus-based capture/restore can't help
      // because making the selection already blurred this textarea.
      const saved = this.sys.draftMgr.replyBodies.get(thread.id);
      if (saved) ta.value = saved;
      ta.addEventListener("input", () => {
        if (ta.value) this.sys.draftMgr.replyBodies.set(thread.id, ta.value);
        else this.sys.draftMgr.replyBodies.delete(thread.id);
      });
    }
    // Stop card-click bubbling from inside the textarea (would re-trigger
    // anchor scrolling on every click while typing).
    ta.addEventListener("click", (e) => e.stopPropagation());
    // Track IME composition so a background render doesn't tear this textarea
    // down mid-conversion (the uncommitted pre-edit text isn't in `.value`
    // and would be lost). A render requested while composing is deferred and
    // flushed here on `compositionend`. Matters most for CJK input.
    ta.addEventListener("compositionstart", () => {
      this.sys.composing = true;
    });
    ta.addEventListener("compositionend", () => {
      this.sys.composing = false;
      if (this.sys.pendingBackgroundRender) {
        this.sys.pendingBackgroundRender = false;
        this.sys.backgroundRender();
      }
    });
    composer.appendChild(ta);

    const row = document.createElement("div");
    row.className = "cmt-reply-row";

    // Left edge of the action row. For a DRAFT it holds a "Draft" status tag
    // — the unposted state has to be unmistakable (a draft never enters the
    // CRDT, so a comment typed but never submitted silently doesn't count),
    // and a draft has no thread id yet, so this slot is otherwise empty. For a
    // SAVED thread (author only) it instead surfaces the thread id so the
    // author can correlate the card with the `id=<threadId>` lines
    // /process-comments prints (and `resolve-threads` accepts); readers never
    // see it. Both pin left via `margin-right:auto` so the action buttons stay
    // grouped on the right.
    if (isDraft) {
      const tag = document.createElement("span");
      tag.className = "cmt-draft-tag";
      tag.textContent = "Draft";
      tag.title = "Not posted yet — press “Comment” to publish it";
      row.appendChild(tag);
    } else if (this.sys.isAuthorMode()) {
      const id = document.createElement("button");
      id.type = "button";
      id.className = "cmt-thread-id";
      id.textContent = thread.id;
      id.title = "Thread ID (click to copy) — matches the id= lines in /process-comments";
      id.addEventListener("click", (e) => {
        e.stopPropagation();
        void navigator.clipboard
          ?.writeText(thread.id)
          .then(() => {
            const prev = id.textContent;
            id.textContent = "copied";
            window.setTimeout(() => {
              id.textContent = prev;
            }, 1000);
          })
          .catch(() => {});
      });
      row.appendChild(id);
    }

    // Drafts can't be recovered (no anchor highlight to click), so Cancel
    // discards. Non-stale saved threads keep their highlight, so Cancel
    // just hides the card. STALE saved threads have no recovery
    // affordance (the highlight is no longer drawn) — we omit the button
    // entirely rather than offer a Hide that traps the comment.
    if (isDraft || !isStale) {
      const cancel = document.createElement("button");
      cancel.type = "button";
      cancel.className = "cmt-reply-cancel";
      cancel.textContent = isDraft ? "Cancel" : "Hide";
      cancel.title = isDraft
        ? "Discard this draft"
        : "Hide this card (click the highlight to bring it back)";
      cancel.addEventListener("click", (e) => {
        e.stopPropagation();
        if (isDraft) {
          this.sys.draftMgr.discardDraft(thread.id);
        } else {
          this.sys.hiddenCardIds.add(thread.id);
          this.sys.renderAll();
        }
      });
      row.appendChild(cancel);
    }

    // Resolve — decisive, permanent dismiss. Available on every saved
    // thread (including stale, where it's often *the* right action).
    // Routing splits into two paths:
    //   - Own thread (we're the original commenter): write the
    //     resolution into our CommentDoc (`store.resolveThread`).
    //   - Foreign thread (we're the post author resolving a reader's
    //     comment): write a per-post resolution entry — only the
    //     author can do this, and only the post author's session is
    //     authorized server-side. Visible to both the author and the
    //     original commenter on next poll.
    // Hidden entirely for non-author readers on foreign threads
    // because they can't see foreign threads in the first place; the
    // condition still guards against unauthorized clicks just in
    // case.
    const ownThread = !isDraft && this.sys.store?.ownsThread(thread.id);
    const canAuthorResolve =
      !isDraft && !ownThread && !!this.sys.identity && this.sys.isAuthorMode();
    if (!isDraft && (ownThread || canAuthorResolve)) {
      const resolve = document.createElement("button");
      resolve.type = "button";
      resolve.className = "cmt-reply-resolve";
      resolve.textContent = "Resolve";
      resolve.title = ownThread
        ? "Resolve this thread — hides it permanently and queues a delete to sync to the server"
        : "Resolve this commenter's thread — marks it resolved for them too";
      resolve.addEventListener("click", (e) => {
        e.stopPropagation();
        if (!this.sys.store) return;
        // Also drop any session-only "hide" mark so the thread isn't
        // stuck in the hidden set forever after being resolved.
        this.sys.hiddenCardIds.delete(thread.id);
        if (ownThread) {
          this.sys.store.resolveThread(thread.id, Date.now());
          this.sys.refreshSnapshotAndRender();
        } else if (this.sys.resolutions && this.sys.identity) {
          const envelope: ResolutionEnvelope = {
            threadId: thread.id,
            resolvedAt: Date.now(),
            resolverId: this.sys.identity.userId,
            resolverName: this.sys.identity.name ?? this.sys.identity.email,
          };
          // Fire-and-forget; the store's onChange hook re-renders
          // when the local cache updates (after the PUT lands).
          // Errors are logged inside the store.
          this.sys.resolutions
            .resolve(envelope)
            .catch((err) => console.warn("author resolve failed:", err));
        }
      });
      row.appendChild(resolve);
    }

    const submit = document.createElement("button");
    submit.type = "button";
    submit.className = "cmt-reply-submit";
    submit.textContent = isSuggestionDraft ? "Suggest edit" : isDraft ? "Comment" : "Reply";
    const doSubmit = () => {
      if (!this.sys.store || !this.sys.identity) return;
      const body = ta.value.trim();
      // A suggestion's note is optional (the diff IS its content); a plain
      // comment/reply still needs text.
      if (!body && !isSuggestionDraft) return;
      const reply: Reply | null = body
        ? {
            id: uid(),
            body,
            createdAt: Date.now(),
            authorId: this.sys.identity.userId,
            authorName: this.sys.identity.name ?? this.sys.identity.email,
            authorEmail: this.sys.identity.email,
            ...(this.sys.identity.picture && { authorPicture: this.sys.identity.picture }),
          }
        : null;
      if (isDraft) {
        // Promote draft → persisted thread. Single Automerge change
        // would be tidier here, but the public store API has separate
        // ops; we accept two ops for the v1 case since it's a fresh
        // thread no one else has touched yet. The suggestion payload (if
        // any) rides the addThread change and is immutable after.
        this.sys.store.addThread(thread.id, thread.target, thread.createdAt, thread.suggestion);
        if (reply) this.sys.store.addReply(thread.id, reply);
        this.sys.draftMgr.drafts = this.sys.draftMgr.drafts.filter((t) => t.id !== thread.id);
        this.sys.draftMgr.draftBodies.delete(thread.id);
        this.sys.draftMgr.persistDrafts();
      } else if (reply) {
        this.sys.store.addReply(thread.id, reply);
        // Drop the in-progress buffer so the post-submit re-render doesn't
        // refill the reply box with the text we just sent.
        this.sys.draftMgr.replyBodies.delete(thread.id);
      }
      ta.value = "";
      this.sys.refreshSnapshotAndRender();
    };
    submit.addEventListener("click", (e) => {
      e.stopPropagation();
      doSubmit();
    });
    ta.addEventListener("keydown", (e) => {
      // While an IME composition is active, Enter/Esc belong to the
      // converter (commit a candidate / cancel the conversion), not to us —
      // acting on them would submit or discard mid-conversion. `isComposing`
      // is the platform's own signal for this. Critical for CJK input.
      if (e.isComposing) return;
      if ((e.metaKey || e.ctrlKey) && e.key === "Enter") {
        e.preventDefault();
        doSubmit();
        return;
      }
      // Esc on an untouched new comment discards it — the light-dismiss
      // users expect from the mobile popover, extended to the desktop
      // column card (which isn't a popover, so Esc would otherwise do
      // nothing). Gated on an empty box so we never throw away typed
      // work — once there's text, Esc is inert and the draft stays.
      // Draft-only: a reply's dismiss is "Hide" (recoverable), not a
      // discard, so Esc there shouldn't destroy the card. `preventDefault`
      // keeps the native popover from also light-dismissing underneath us.
      if (e.key === "Escape" && isDraft && !ta.value.trim()) {
        e.preventDefault();
        this.sys.draftMgr.discardDraft(thread.id);
      }
    });

    row.appendChild(submit);
    composer.appendChild(row);
    return composer;
  }

  private deleteReply(thread: Thread, replyId: string) {
    if (!this.sys.store) return;
    const reply = thread.replies.find((r) => r.id === replyId);
    if (!reply || isDeleted(reply)) return;
    // Tombstoning + the auto-resolve-on-last-delete bundling is all
    // handled atomically inside CommentStore.deleteReply so future
    // server sync sees one coherent CRDT change per user action.
    this.sys.store.deleteReply(thread.id, replyId, Date.now());
    // The store auto-resolves the thread if this was the last visible
    // reply; clear the session-only "hide" mark in the same step so a
    // previously-hidden, now-resolved thread doesn't leave a dangling
    // entry in the set.
    this.sys.hiddenCardIds.delete(thread.id);
    this.sys.refreshSnapshotAndRender();
  }
}
