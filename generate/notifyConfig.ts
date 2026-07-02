// Resolved configuration for the publish-notification step (generate/
// publish-notify.ts) — the post-deploy webhook fan-out that announces a new
// post to Discord / Slack / a generic HTTP endpoint. See methodology.md →
// "Subscription feeds".
//
// Everything here is env-driven and OPT-IN: each channel var is empty by
// default, so a blog that sets none turns the whole step into a no-op (the same
// fail-silent posture as feedConfig's SITE_URL / WEBSUB_HUB knobs). The webhook
// URLs are SECRETS (anyone holding one can post to the channel), so they live in
// .dev.vars / the deploy environment and are never committed — handled like
// SESSION_SECRET, not like the public SITE_URL.
//
// Routing is PER-BLOG: each blog resolves its own vars from its own environment
// (the notify step runs inside that blog's deploy), so blog A announces to
// channel A and blog B to channel B, exactly as each blog carries its own
// SITE_URL. There is no system-wide shared channel.

import { z } from "zod";
import { csvList, trimmedOrNull } from "../shared/envSchemas.ts";

export type WebhookFormat = "plain" | "cloudevents";

export type NotifyConfig = {
  /** Discord incoming-webhook URLs (comma-separated env → list). */
  discord: string[];
  /** Slack incoming-webhook URLs. */
  slack: string[];
  /** Generic HTTP endpoints (Zapier / n8n / homegrown). */
  generic: string[];
  /**
   * Body shape for the GENERIC path only (Discord/Slack always use their own
   * native shapes). "cloudevents" wraps the payload in a CloudEvents structured
   * envelope; "plain" sends a bare {title,url,summary}. Opt-in via
   * WEBHOOK_FORMAT=cloudevents.
   */
  format: WebhookFormat;
  /**
   * Standard Webhooks signing secret for the GENERIC path only. When set, each
   * generic POST is signed (webhook-id / webhook-timestamp / webhook-signature).
   * Base64, optionally `whsec_`-prefixed. Null → unsigned. Meaningful only when
   * the author controls the receiver.
   */
  signingSecret: string | null;
  /**
   * Delay in ms between successive POSTs, so a deploy that publishes several
   * posts at once doesn't trip Slack's ~1/sec or Discord's burst limits.
   * Override with WEBHOOK_PACE_MS.
   */
  paceMs: number;
};

// One schema for the whole notify env surface. The CSV lists share the
// `csvList` helper (also used by the Worker's `isBlockedUser`); `WEBHOOK_FORMAT`
// is the "enum-as-boolean" the type already wants, expressed declaratively; and
// `WEBHOOK_PACE_MS` is parsed-and-clamped in one place (a single failure path,
// vs. the old `parseInt`→`NaN`→fall-through). The pace transform keeps
// `parseInt` semantics (lenient on trailing chars) rather than `z.coerce`
// (strict `Number()`), so the migration is behavior-preserving.
const NotifyEnv = z.object({
  DISCORD_WEBHOOK_URL: csvList,
  SLACK_WEBHOOK_URL: csvList,
  WEBHOOK_URL: csvList,
  WEBHOOK_FORMAT: z
    .string()
    .default("")
    .transform((v): WebhookFormat =>
      v.trim().toLowerCase() === "cloudevents" ? "cloudevents" : "plain",
    ),
  WEBHOOK_SIGNING_SECRET: trimmedOrNull,
  // Default just over Slack's 1-message/second incoming-webhook limit.
  WEBHOOK_PACE_MS: z
    .string()
    .default("")
    .transform((v) => {
      const n = Number.parseInt(v.trim(), 10);
      return Number.isFinite(n) && n >= 0 ? n : 1100;
    }),
});

export function resolveNotifyConfig(
  env: Record<string, string | undefined> = process.env,
): NotifyConfig {
  const e = NotifyEnv.parse(env);
  return {
    discord: e.DISCORD_WEBHOOK_URL,
    slack: e.SLACK_WEBHOOK_URL,
    generic: e.WEBHOOK_URL,
    format: e.WEBHOOK_FORMAT,
    signingSecret: e.WEBHOOK_SIGNING_SECRET,
    paceMs: e.WEBHOOK_PACE_MS,
  };
}

/** True when at least one channel is configured; false → the step is a no-op. */
export function hasAnyChannel(cfg: NotifyConfig): boolean {
  return cfg.discord.length > 0 || cfg.slack.length > 0 || cfg.generic.length > 0;
}
