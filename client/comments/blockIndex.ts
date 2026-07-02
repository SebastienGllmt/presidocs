// methodology.md → Comments — block/graphic indexing. Walks a commentable root
// (article or the narrator's spoken-script drawer), assigns each block a stable
// id + sha256 of its normalized text (the slot-stability anchor), and records
// the graphics. Also hosts the narrator↔comments drawer-body handshake as a
// free function. `BlockIndex` is `sys`-free by construction — it holds only its
// own maps.

import { BLOCK_TAGS, normalizeText, walkBlocks } from "../commentsDom.ts";
import {
  DRAWER_BODY_WANTED_ATTR,
  REQUEST_DRAWER_BODY_EVENT,
  DRAWER_BODY_READY_EVENT,
} from "../drawerBodyContract.ts";
import type { Context } from "../commentsStore.ts";

export type BlockInfo = {
  id: string;
  element: HTMLElement;
  context: Context;
  hash: string;
  text: string;
};

// v1: only `<figure>` is a commentable graphic. The authoring convention
// (per methodology.md) wraps each graphic in a figure with an id, and that
// lets us attach an HTML button child without worrying about SVG namespace
// or `<img>` being a void element. Standalone <svg>/<img>/<canvas> would
// need a wrapper before we could place the trigger; we can add that later.
const GRAPHIC_ROOT_TAGS = new Set(["FIGURE"]);

async function sha256(s: string): Promise<string> {
  const buf = new TextEncoder().encode(s);
  const digest = await crypto.subtle.digest("SHA-256", buf);
  return Array.from(new Uint8Array(digest))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

// Drive the narrator↔comments handshake (narratorDom.ts): resolve the
// drawer once its body exists. If it's already built we return immediately;
// otherwise we set the sentinel (for a narrator that boots later) AND fire
// the request event (for one already booted), then await the ready signal.
export function requestDrawerBody(): Promise<HTMLElement | null> {
  const READY = ".narrate-drawer[data-body-ready]";
  const ready = document.querySelector<HTMLElement>(READY);
  if (ready) return Promise.resolve(ready);

  document.documentElement.setAttribute(DRAWER_BODY_WANTED_ATTR, "1");
  document.dispatchEvent(new CustomEvent(REQUEST_DRAWER_BODY_EVENT));

  return new Promise((resolve) => {
    let settled = false;
    const finish = (el: HTMLElement | null) => {
      if (settled) return;
      settled = true;
      document.removeEventListener(DRAWER_BODY_READY_EVENT, onReady);
      clearTimeout(timer);
      resolve(el);
    };
    const onReady = () => finish(document.querySelector<HTMLElement>(READY));
    document.addEventListener(DRAWER_BODY_READY_EVENT, onReady);
    // Bound the wait: a narrated post's narrator boots within its
    // `requestIdleCallback` timeout (~4 s), so this only fully elapses on the
    // no-drawer case (opt-out / non-narrated), where we fall back to
    // article-only commenting.
    const timer = setTimeout(() => finish(document.querySelector<HTMLElement>(READY)), 8000);
  });
}

export class BlockIndex {
  // `drawerRoot` is set when the narrator drawer is detected. Threads in
  // the drawer index against this root; if the drawer never appears
  // (manifest missing) we still work on the article alone.
  drawerRoot: HTMLElement | null = null;

  blocksByContext = new Map<Context, BlockInfo[]>();
  blocksById = new Map<string, BlockInfo>();
  graphicsById = new Map<string, HTMLElement>();

  async indexDrawer(drawer: HTMLElement) {
    this.drawerRoot = drawer;
    await this.indexRoot(drawer, "narration");
  }

  async indexRoot(root: HTMLElement, context: Context) {
    const blocks: BlockInfo[] = [];
    let counter = 0;
    for (const el of walkBlocks(root, BLOCK_TAGS)) {
      // In the narration drawer the walker stops at the <li> wrapping each
      // segment (LI is a block tag), but that <li> also holds the play
      // button whose <time> clock ("0:11") would otherwise leak into the
      // block's text, hash, offsets, and quote. Re-target to the inner
      // spoken-text <p> so anchors cover only the spoken words. No-op
      // outside the drawer — article blocks have no .spoken-text child.
      const block = el.querySelector<HTMLElement>(".spoken-text") ?? el;
      const stableId = block.id && block.id.length > 0
        ? `id:${block.id}`
        : `${context}:__b-${counter}`;
      block.dataset.commentBlockId = stableId;
      block.dataset.commentContext = context;
      const text = block.textContent ?? "";
      const hash = await sha256(normalizeText(text));
      const info: BlockInfo = { id: stableId, element: block, context, hash, text };
      blocks.push(info);
      this.blocksById.set(stableId, info);
      counter++;
    }
    let gCounter = 0;
    for (const el of walkBlocks(root, GRAPHIC_ROOT_TAGS)) {
      const stableId = el.id && el.id.length > 0
        ? `id:${el.id}`
        : `${context}:__g-${gCounter}`;
      el.dataset.commentGraphicId = stableId;
      el.dataset.commentContext = context;
      this.graphicsById.set(stableId, el);
      gCounter++;
    }
    this.blocksByContext.set(context, blocks);
  }
}
