// ============================================================
// /api/admin/manage-products
// ------------------------------------------------------------
// GET  ?secret=xxx          → 讀取GitHub上最新嘅產品清單
// POST {secret, products}   → 一次過覆蓋成個清單(改價/刪除/改名後儲存)
//
// 全部經GitHub commit,Vercel會自動重新部署套用改動。
// ============================================================

async function ghGetFile(path) {
  const res = await fetch(
    `https://api.github.com/repos/${process.env.GITHUB_REPO}/contents/${path}`,
    { headers: { Authorization: `Bearer ${process.env.GITHUB_TOKEN}`, "User-Agent": "picked-right-it" } }
  );
  if (res.status === 404) return { content: null, sha: null };
  const data = await res.json();
  if (!data.content) throw new Error(`GitHub read failed: ${data.message || "unknown"}`);
  return { content: Buffer.from(data.content, "base64").toString("utf8"), sha: data.sha };
}

async function ghPutFile(path, contentStr, sha, message) {
  const body = {
    message,
    content: Buffer.from(contentStr, "utf8").toString("base64"),
  };
  if (sha) body.sha = sha;
  const res = await fetch(
    `https://api.github.com/repos/${process.env.GITHUB_REPO}/contents/${path}`,
    {
      method: "PUT",
      headers: {
        Authorization: `Bearer ${process.env.GITHUB_TOKEN}`,
        "User-Agent": "picked-right-it",
        "Content-Type": "application/json",
      },
      body: JSON.stringify(body),
    }
  );
  const data = await res.json();
  if (!data.commit) throw new Error(`GitHub write failed: ${data.message || "unknown"}`);
  return data.commit.sha;
}

module.exports = async (req, res) => {
  const secret = req.method === "GET" ? req.query.secret : (req.body || {}).secret;
  if (secret !== process.env.ADMIN_SYNC_SECRET) {
    return res.status(401).json({ error: "密碼錯誤" });
  }
  if (!process.env.GITHUB_TOKEN || !process.env.GITHUB_REPO) {
    return res.status(500).json({ error: "未設定 GITHUB_TOKEN / GITHUB_REPO 環境變數" });
  }

  try {
    if (req.method === "GET") {
      const { content } = await ghGetFile("data/products.json");
      const list = content ? JSON.parse(content) : [];
      return res.status(200).json({ products: list });
    }

    if (req.method === "POST") {
      const { products } = req.body || {};
      if (!Array.isArray(products)) {
        return res.status(400).json({ error: "products 要係array" });
      }
      // 基本驗證:每件產品要有id、price、cjPid,防止意外寫入爛數據
      for (const p of products) {
        if (!p.id || !p.price || !p.cjPid || !p.cjVid) {
          return res.status(400).json({ error: `產品 id=${p.id || "?"} 缺少必要欄位(id/price/cjPid/cjVid)` });
        }
        if (typeof p.price !== "number" || p.price < 1) {
          return res.status(400).json({ error: `產品 id=${p.id} 價錢無效` });
        }
      }

      const { sha } = await ghGetFile("data/products.json");
      await ghPutFile(
        "data/products.json",
        JSON.stringify(products, null, 2),
        sha,
        `admin: update products (${products.length} items)`
      );
      return res.status(200).json({ success: true, count: products.length });
    }

    res.status(405).json({ error: "Method not allowed" });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message });
  }
};
