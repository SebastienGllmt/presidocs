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

function list(v: string | undefined): string[] {
  return (v ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
}

export function resolveNotifyConfig(
  env: Record<string, string | undefined> = process.env,
): NotifyConfig {
  const pace = Number.parseInt((env.WEBHOOK_PACE_MS ?? "").trim(), 10);
  return {
    discord: list(env.DISCORD_WEBHOOK_URL),
    slack: list(env.SLACK_WEBHOOK_URL),
    generic: list(env.WEBHOOK_URL),
    format:
      (env.WEBHOOK_FORMAT ?? "").trim().toLowerCase() === "cloudevents"
        ? "cloudevents"
        : "plain",
    signingSecret: (env.WEBHOOK_SIGNING_SECRET ?? "").trim() || null,
    // Default just over Slack's 1-message/second incoming-webhook limit.
    paceMs: Number.isFinite(pace) && pace >= 0 ? pace : 1100,
  };
}

/** True when at least one channel is configured; false → the step is a no-op. */
export function hasAnyChannel(cfg: NotifyConfig): boolean {
  return cfg.discord.length > 0 || cfg.slack.length > 0 || cfg.generic.length > 0;
}
