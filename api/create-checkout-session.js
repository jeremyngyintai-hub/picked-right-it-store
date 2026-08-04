// ============================================================
// POST /api/create-checkout-session
// ------------------------------------------------------------
// 前端購物車撳「信用卡付款」時,將 cart (例如 {"1":2,"4":1}) 傳嚟呢度,
// 呢個function會用 Stripe 開一張結帳頁,並且順便收集客人嘅送貨地址。
// ============================================================

const Stripe = require("stripe");
const { getCatalog } = require("./_lib/catalog");

const stripe = Stripe(process.env.STRIPE_SECRET_KEY);

module.exports = async (req, res) => {
  if (req.method !== "POST") {
    return res.status(405).json({ error: "Method not allowed" });
  }

  try {
    const cart = req.body.cart; // 例如 { "1": 2, "4": 1 }
    const ids = Object.keys(cart || {});
    if (ids.length === 0) {
      return res.status(400).json({ error: "購物車係空嘅" });
    }

    const productMap = await getCatalog();

    // 價錢一律以伺服器呢邊 productMap 為準,唔信前端傳嚟嘅價錢
    const line_items = ids.map((key) => {
      const [pid, vid] = String(key).split("::");
      const p = productMap[pid];
      if (!p) throw new Error(`搵唔到產品 id=${pid}`);
      let name = p.name;
      if (vid && p.variants) {
        const v = p.variants.find((x) => x.vid === vid);
        if (v && v.name) name += ` (${v.name})`;
      }
      return {
        price_data: {
          currency: "hkd",
          product_data: { name },
          unit_amount: Math.round(p.sellPriceHKD * 100), // Stripe 用「分」做單位
        },
        quantity: cart[key],
      };
    });

    const session = await stripe.checkout.sessions.create({
      mode: "payment",
      allow_promotion_codes: true, // 客人結帳頁可以入PICKED10等優惠碼
      line_items,
      // 收集客人送貨地址 —— 之後要傳畀CJ Dropshipping寄貨用
      shipping_address_collection: {
        allowed_countries: ["HK"],
      },
      phone_number_collection: { enabled: true },
      success_url: `${process.env.SITE_URL}/thanks.html`,
      cancel_url: `${process.env.SITE_URL}/?order=cancelled`,
      // metadata 會喺 webhook 度攞返;每個value上限500字,
      // 所以將cart JSON斬做450字一段,分開儲(cart, cart1, cart2...)
      metadata: (() => {
        const s = JSON.stringify(cart);
        const meta = {};
        for (let i = 0; i * 450 < s.length && i < 20; i++) {
          meta[i === 0 ? "cart" : `cart${i}`] = s.slice(i * 450, (i + 1) * 450);
        }
        return meta;
      })(),
    });

    res.status(200).json({ url: session.url });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message });
  }
};
