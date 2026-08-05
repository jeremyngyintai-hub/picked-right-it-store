// ============================================================
// POST /api/stripe-webhook
// ------------------------------------------------------------
// Stripe 收到錢之後,會自動call呢個網址。
// 呢度會:
//   1. 核實個webhook真係嚟自Stripe(唔係有人假冒)
//   2. 攞返客人買咗乜、送去邊
//   3. 自動去CJ Dropshipping開單(CJ_AUTO_SUBMIT=false 時只開草稿,
//      等你人手覆核先send出去;=true 先會即刻用CJ錢包餘額落單)
//
// ⚠️ 記得喺 Vercel 環境變數要用 "Raw Body"(Stripe簽名核實需要原始request body,
// 下面用咗 Vercel 嘅 config 關閉自動 body parsing)
// ============================================================

const Stripe = require("stripe");
const { getCatalog } = require("./_lib/catalog");
const { kvReady, kv, pipeline } = require("./_lib/kv");
const { sendEmail, orderConfirmHTML } = require("./_lib/mail");
const { sendDiscord } = require("./_lib/discord");
const cj = require("./_lib/cjClient");

const stripe = Stripe(process.env.STRIPE_SECRET_KEY);

module.exports.config = {
  api: { bodyParser: false },
};

function buffer(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", () => resolve(Buffer.concat(chunks)));
    req.on("error", reject);
  });
}

module.exports = async (req, res) => {
  if (req.method !== "POST") return res.status(405).end();

  let event;
  try {
    const rawBody = await buffer(req);
    const signature = req.headers["stripe-signature"];
    event = stripe.webhooks.constructEvent(
      rawBody,
      signature,
      process.env.STRIPE_WEBHOOK_SECRET
    );
  } catch (err) {
    console.error("Webhook 簽名核實失敗:", err.message);
    return res.status(400).send(`Webhook Error: ${err.message}`);
  }

  if (event.type === "checkout.session.completed") {
    const session = event.data.object;

    try {
      // 攞返完整嘅送貨地址同聯絡電話
      const fullSession = await stripe.checkout.sessions.retrieve(session.id, {
        expand: ["customer_details"],
      });
      const shipping = fullSession.shipping_details || fullSession.customer_details;
      // 重組斬件儲存嘅cart(cart, cart1, cart2...)
      let cartStr = session.metadata.cart || "";
      for (let i = 1; i < 20; i++) {
        const part = session.metadata[`cart${i}`];
        if (!part) break;
        cartStr += part;
      }
      const cart = JSON.parse(cartStr);
      const productMap = await getCatalog();

      // ===== 銷售記錄(KV有設定先做,失敗唔影響落單流程)=====
      try {
        if (kvReady()) {
          const now = Date.now();
          const items = Object.entries(cart).map(([key, qty]) => {
            const [pid, vid] = String(key).split("::");
            const prod = productMap[pid] || {};
            let nm = prod.name || `#${pid}`;
            if (vid && prod.variants) {
              const v = prod.variants.find((x) => x.vid === vid);
              if (v && v.name) nm += ` (${v.name})`;
            }
            return {
              id: Number(pid), name: nm, qty,
              priceHKD: prod.sellPriceHKD || 0,
              costHKD: prod.costUSD ? Math.round((prod.costUSD + (prod.shipUSD || 0)) * 7.8) : null,
            };
          });
          const totalHKD = items.reduce((s, it) => s + it.priceHKD * it.qty, 0);
          const custEmail = (fullSession.customer_details && fullSession.customer_details.email) || "";
          await kv(["LPUSH", "orders", JSON.stringify({ sid: session.id, ts: now, totalHKD, items, email: custEmail })]);
          await kv(["LTRIM", "orders", "0", "999"]); // 最多keep最近1000張單
          const cmds = [];
          items.forEach((it) => {
            cmds.push(["INCRBY", `sold:qty:${it.id}`, String(it.qty)]);
            cmds.push(["INCRBYFLOAT", `sold:rev:${it.id}`, String(it.priceHKD * it.qty)]);
            cmds.push(["SET", `lastsale:${it.id}`, String(now)]);
          });
          if (cmds.length) await pipeline(cmds);
        }
      } catch (kvErr) {
        console.error("KV訂單記錄失敗(唔影響落單):", kvErr.message);
      }

      // ===== Discord新訂單通知 =====
      try {
        const dItems = Object.entries(cart).map(([key, qty]) => {
          const [pid] = String(key).split("::");
          const prod = productMap[pid] || {};
          return `${prod.name || "#" + pid} × ${qty}`;
        }).join("\n");
        const dTotal = Object.entries(cart).reduce((s, [key, qty]) => {
          const [pid] = String(key).split("::");
          return s + ((productMap[pid] || {}).sellPriceHKD || 0) * qty;
        }, 0);
        await sendDiscord({
          title: "💰 新訂單!",
          color: 0x3ddc84,
          description: dItems,
          fields: [
            { name: "金額", value: `HK$${dTotal}`, inline: true },
            { name: "訂單", value: session.id.slice(-10), inline: true },
          ],
        });
      } catch {}

      // ===== 落單確認email(未設定RESEND_API_KEY會自動跳過)=====
      try {
        const custEmail = fullSession.customer_details && fullSession.customer_details.email;
        if (custEmail) {
          const productMapC = await getCatalog();
          const items2 = Object.entries(cart).map(([key, qty]) => {
            const [pid] = String(key).split("::");
            const prod = productMapC[pid] || {};
            return { name: prod.name || `#${pid}`, qty, priceHKD: prod.sellPriceHKD || 0 };
          });
          const totalHKD2 = items2.reduce((s, it) => s + it.priceHKD * it.qty, 0);
          await sendEmail({
            to: custEmail,
            subject: "✅ 訂單已確認 — 揀啱 PICKED RIGHT IT",
            html: orderConfirmHTML({ items: items2, totalHKD: totalHKD2, siteUrl: process.env.SITE_URL || "https://picked-right.it.com" }),
          });
        }
      } catch (mailErr) {
        console.error("確認email發送失敗(唔影響落單):", mailErr.message);
      }

      const accessToken = await cj.getAccessToken();

      // 將本地產品對應返CJ嘅pid/vid
      const products = Object.entries(cart).map(([key, qty]) => {
        const [pid, vid] = String(key).split("::");
        const p = productMap[pid];
        if (!p || !p.cjPid || p.cjPid === "REPLACE_ME") {
          throw new Error(`產品#${pid}對唔返CJ資料(可能已落架/未填pid),要人手上CJ補單`);
        }
        return { cjPid: p.cjPid, cjVid: vid || p.cjVid, quantity: qty };
      });

      const addressResult = await cj.ensureShippingAddress(accessToken, {
        name: shipping.name,
        phone: fullSession.customer_details.phone,
        country: "HK",
        address: shipping.address.line1,
        city: shipping.address.city || "Hong Kong",
        zip: shipping.address.postal_code || "999077",
      });

      const draftOrder = await cj.createDraftOrder(accessToken, {
        products,
        addressId: addressResult.addressId,
        yourOrderRef: session.id, // 方便你對返係邊張Stripe單
      });

      console.log("CJ草稿訂單已建立:", draftOrder);
      try { if (kvReady() && draftOrder && draftOrder.orderId) await kv(["SET", `cjorder:${session.id}`, String(draftOrder.orderId)]); } catch {}

      // 只有你確認過流程穩陣,先將 CJ_AUTO_SUBMIT 環境變數設做 "true"
      if (process.env.CJ_AUTO_SUBMIT === "true") {
        const submitResult = await cj.submitOrder(accessToken, draftOrder.orderId);
        console.log("CJ訂單已自動送出:", submitResult);
      } else {
        console.log("⚠️ CJ_AUTO_SUBMIT 未開啟,呢張單淨係開咗草稿,要你人手上CJ後台確認送出。");
      }

      // 建議喺呢度加多一步:將訂單記錄存落資料庫,同時
      // 用返你哋WhatsApp/email通知自己「有新單」,方便追蹤
    } catch (err) {
      // 呢度好緊要:CJ落單失敗都好,絕對唔可以令Stripe覺得webhook失敗咁重複re-try扣多次錢
      // 應該將錯誤log低,再由人手(你自己)去CJ後台補做呢張單
      console.error("CJ自動落單失敗,需要人手處理:", err.message, session.id);
    }
  }

  res.status(200).json({ received: true });
};
