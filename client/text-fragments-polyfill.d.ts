// Ambient types for `text-fragments-polyfill`'s generator entry. The package
// ships hand-written JS with JSDoc but no `.d.ts`, and we only ever touch the
// `fragment-generation-utils` half (the scroll-to-text *renderer* is Baseline-
// native — see methodology.md → "Citation deep-links"). These declarations
// mirror the exports verified against node_modules at adoption time
// (text-fragments-polyfill@6.7.0); keep them in sync if the dep is bumped.
declare module "text-fragments-polyfill/dist/fragment-generation-utils.js" {
  /** The four directive terms, as RAW (un-percent-encoded) strings. */
  export interface TextFragment {
    textStart: string;
    textEnd?: string;
    prefix?: string;
    suffix?: string;
  }

  /** Success / failure-reason of {@link generateFragment}. */
  export const GenerateFragmentStatus: {
    readonly SUCCESS: 0;
    readonly INVALID_SELECTION: 1;
    readonly AMBIGUOUS: 2;
    readonly TIMEOUT: 3;
    readonly EXECUTION_FAILED: 4;
  };

  export interface GenerateFragmentResult {
    /** One of the `GenerateFragmentStatus` values. */
    status: number;
    /** Present only when `status === GenerateFragmentStatus.SUCCESS`. */
    fragment?: TextFragment;
  }

  /**
   * Walk up from the selection, expanding to word boundaries and extending
   * prefix/suffix/range only as far as needed to make the fragment a UNIQUE
   * match in the document. Returns AMBIGUOUS when no unique fragment exists,
   * TIMEOUT past the (default 500 ms) budget, INVALID_SELECTION / EXECUTION_FAILED
   * otherwise. `startTime` is a `Date.now()` epoch-ms value (defaults to now).
   */
  export function generateFragment(
    selection: Selection,
    startTime?: number,
  ): GenerateFragmentResult;

  export function generateFragmentFromRange(
    range: Range,
    startTime?: number,
  ): GenerateFragmentResult;

  export function isValidRangeForFragmentGeneration(range: Range): boolean;

  /** Override the generation timeout (ms). `null` disables it. */
  export function setTimeout(newTimeoutDurationMs: number | null): void;
}
