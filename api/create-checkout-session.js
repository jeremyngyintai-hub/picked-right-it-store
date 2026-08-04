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
    const line_items = ids.map((id) => {
      const p = productMap[id];
      if (!p) throw new Error(`搵唔到產品 id=${id}`);
      return {
        price_data: {
          currency: "hkd",
          product_data: { name: p.name },
          unit_amount: Math.round(p.sellPriceHKD * 100), // Stripe 用「分」做單位
        },
        quantity: cart[id],
      };
    });

    const session = await stripe.checkout.sessions.create({
      mode: "payment",
      line_items,
      // 收集客人送貨地址 —— 之後要傳畀CJ Dropshipping寄貨用
      shipping_address_collection: {
        allowed_countries: ["HK"],
      },
      phone_number_collection: { enabled: true },
      success_url: `${process.env.SITE_URL}/?order=success`,
      cancel_url: `${process.env.SITE_URL}/?order=cancelled`,
      // metadata 會喺 webhook 度攞返,用嚟知道呢張單買咗啲乜
      metadata: { cart: JSON.stringify(cart) },
    });

    res.status(200).json({ url: session.url });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message });
  }
};
