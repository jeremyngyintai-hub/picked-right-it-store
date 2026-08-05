// ============================================================
// Discord 通知(Webhook)— 未設定 DISCORD_WEBHOOK_URL 時安全跳過
// 設定:Discord server → 頻道⚙️ → Integrations → Webhooks →
//      New Webhook → Copy URL → Vercel env DISCORD_WEBHOOK_URL
// ============================================================

async function sendDiscord({ title, description, color, fields, channel }) {
  // 分頻道:orders / stats / reviews 各有自己webhook,冇設定就用總webhook
  const CHANNEL_ENV = {
    orders: process.env.DISCORD_WEBHOOK_ORDERS,
    stats: process.env.DISCORD_WEBHOOK_STATS,
    reviews: process.env.DISCORD_WEBHOOK_REVIEWS,
  };
  const url = (channel && CHANNEL_ENV[channel]) || process.env.DISCORD_WEBHOOK_URL;
  if (!url) return { skipped: true };
  try {
    const res = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        username: "揀啱 Bot",
        avatar_url: `${process.env.SITE_URL || "https://picked-right.it.com"}/bot-avatar.png`,
        embeds: [{
          title: title || "",
          description: description || "",
          color: color != null ? color : 0xff3d7a,
          fields: fields || [],
          timestamp: new Date().toISOString(),
          footer: { text: "PICKED RIGHT IT" },
        }],
      }),
    });
    return { ok: res.ok };
  } catch (e) {
    return { error: e.message };
  }
}

module.exports = { sendDiscord };
