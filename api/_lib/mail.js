// ============================================================
// Email 發送(Resend API)— 未設定 RESEND_API_KEY 時安全跳過
// 設定:resend.com 免費註冊 → API Key → Vercel env RESEND_API_KEY
// 正式發客戶email要喺Resend驗證你個domain(加幾條DNS記錄)
// 再設 RESEND_FROM,例:揀啱 PICKED RIGHT IT <hello@picked-right.it.com>
// ============================================================

async function sendEmail({ to, subject, html }) {
  if (!process.env.RESEND_API_KEY || !to) return { skipped: true };
  try {
    const res = await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${process.env.RESEND_API_KEY}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        from: process.env.RESEND_FROM || "PICKED RIGHT IT <onboarding@resend.dev>",
        to: [to],
        subject,
        html,
      }),
    });
    const data = await res.json();
    if (data.id) return { ok: true, id: data.id };
    return { error: data.message || JSON.stringify(data).slice(0, 200) };
  } catch (e) {
    return { error: e.message };
  }
}

function orderConfirmHTML({ items, totalHKD, siteUrl }) {
  const rows = items.map((it) => `<tr><td style="padding:6px 0">${it.name} × ${it.qty}</td><td align="right">HK$${it.priceHKD * it.qty}</td></tr>`).join("");
  return `
  <div style="font-family:'Helvetica Neue',Arial,'Noto Sans TC',sans-serif;max-width:520px;margin:0 auto;color:#1f1726">
    <h2 style="color:#ff3d7a">多謝你嘅訂單!🎉</h2>
    <p>我哋已經收到你嘅訂單,團隊會喺<b>一般48小時內(工作日計)安排出貨</b>,一般7-12日送到。</p>
    <table width="100%" style="border-top:1px solid #eee;border-bottom:1px solid #eee;margin:16px 0">${rows}
      <tr><td style="padding:10px 0"><b>總計</b></td><td align="right"><b>HK$${totalHKD}</b></td></tr></table>
    <p><b>接住會發生嘅事:</b><br>1️⃣ 我哋安排出貨<br>2️⃣ 有追蹤號碼會再email通知你<br>3️⃣ 隨時可以喺 <a href="${siteUrl}/track.html" style="color:#5b3df5">訂單追蹤頁</a> 查件貨去到邊</p>
    <p>有任何問題,WhatsApp我哋:<a href="https://wa.me/85251044417" style="color:#ff3d7a">+852 5104 4417</a>(真人回覆)</p>
    <p style="color:#999;font-size:12px">揀啱 PICKED RIGHT IT · ${siteUrl}</p>
  </div>`;
}

function shippedHTML({ trackNumber, siteUrl }) {
  return `
  <div style="font-family:'Helvetica Neue',Arial,'Noto Sans TC',sans-serif;max-width:520px;margin:0 auto;color:#1f1726">
    <h2 style="color:#ff3d7a">你件貨出發喇!📦</h2>
    <p>追蹤號碼:<b style="font-size:18px">${trackNumber}</b></p>
    <p><a href="${siteUrl}/track.html" style="display:inline-block;background:#ff3d7a;color:#fff;padding:12px 24px;border-radius:999px;text-decoration:none">即刻追蹤件貨 →</a></p>
    <p>一般7-12日送到,支援順豐站/智能櫃自取。</p>
    <p>收到貨之後如果滿意,歡迎<a href="https://wa.me/85251044417?text=${encodeURIComponent("你好!我收到貨喇,想留低評價:")}" style="color:#5b3df5">WhatsApp留個評價畀我哋</a>——你一句話,幫到下一位客人揀啱。🙏</p>
    <p style="color:#999;font-size:12px">揀啱 PICKED RIGHT IT · ${siteUrl}</p>
  </div>`;
}

module.exports = { sendEmail, orderConfirmHTML, shippedHTML };
