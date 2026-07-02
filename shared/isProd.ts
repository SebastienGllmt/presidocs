// Single source of truth for the prod/dev posture check. `NODE_ENV` is set to
// "production" by the Worker deploy (and left unset/other in Bun dev), so this
// is the one gate for prod-only behavior: `Secure`/`__Host-` cookies in the
// auth flow and the HSTS header in securityHeaders. Kept as one definition so
// the cookie code and the header code can't drift on what "prod" means.
export function isProd(): boolean {
  return process.env.NODE_ENV === "production";
}
