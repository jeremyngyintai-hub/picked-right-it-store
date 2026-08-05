// ============================================================
// Discord 通知(Webhook)— 未設定 DISCORD_WEBHOOK_URL 時安全跳過
// 設定:Discord server → 頻道⚙️ → Integrations → Webhooks →
//      New Webhook → Copy URL → Vercel env DISCORD_WEBHOOK_URL
// ============================================================

async function sendDiscord({ title, description, color, fields }) {
  const url = process.env.DISCORD_WEBHOOK_URL;
  if (!url) return { skipped: true };
  try {
    const res = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        username: "揀啱 Bot",
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
