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
const { getCatalog } = require("./lib/catalog");
const { kvReady, kv, pipeline } = require("./lib/kv");
const cj = require("./lib/cjClient");

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
      const cart = JSON.parse(session.metadata.cart);
      const productMap = await getCatalog();

      // ===== 銷售記錄(KV有設定先做,失敗唔影響落單流程)=====
      try {
        if (kvReady()) {
          const now = Date.now();
          const items = Object.entries(cart).map(([id, qty]) => {
            const prod = productMap[id] || {};
            return {
              id: Number(id), name: prod.name || `#${id}`, qty,
              priceHKD: prod.sellPriceHKD || 0,
              costHKD: prod.costUSD ? Math.round(prod.costUSD * 7.8) : null,
            };
          });
          const totalHKD = items.reduce((s, it) => s + it.priceHKD * it.qty, 0);
          await kv(["LPUSH", "orders", JSON.stringify({ sid: session.id, ts: now, totalHKD, items })]);
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

      const accessToken = await cj.getAccessToken();

      // 將本地產品對應返CJ嘅pid/vid
      const products = Object.entries(cart).map(([id, qty]) => {
        const p = productMap[id];
        return { cjPid: p.cjPid, cjVid: p.cjVid, quantity: qty };
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
