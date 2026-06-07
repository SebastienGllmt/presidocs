// Minimal types for jshttp `content-disposition` (v2.0.x ships no `.d.ts`, and
// `@types/content-disposition` only covers the old 0.5 line). We use just
// `create`; declared here following the same untyped-dep convention as
// `client/shikwasa.d.ts`.
declare module "content-disposition" {
  interface ContentDispositionOptions {
    /** `"attachment"` (default) or `"inline"`. */
    type?: "inline" | "attachment" | (string & {});
    /** ISO-8859-1 fallback name, or `false` to omit the `filename` token. */
    fallback?: string | boolean;
  }
  /** Build a `Content-Disposition` header value (RFC 6266 / RFC 5987). */
  export function create(filename?: string, options?: ContentDispositionOptions): string;
  export function parse(header: string): {
    type: string;
    parameters: Record<string, string>;
  };
}
