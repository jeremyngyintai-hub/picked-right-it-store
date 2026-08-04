// ============================================================
// GET /sitemap.xml(經vercel.json rewrite → /api/sitemap)
// 動態sitemap:自動包含所有上架產品嘅?p=id深層連結,
// 新產品上架後Google自然搵到,唔使人手更新。
// ============================================================

module.exports = async (req, res) => {
  const base = process.env.SITE_URL || "https://picked-right.it.com";
  const urls = [
    { loc: `${base}/`, priority: "1.0", changefreq: "daily" },
    { loc: `${base}/track.html`, priority: "0.5", changefreq: "monthly" },
  ];

  // 內置產品 id 1-12
  for (let i = 1; i <= 12; i++) {
    urls.push({ loc: `${base}/?p=${i}`, priority: "0.8", changefreq: "weekly" });
  }
  // 動態上架產品
  try {
    const list = await fetch(`${base}/data/products.json`).then((r) => r.json());
    (list || []).forEach((p) => {
      if (!p.delisted) urls.push({ loc: `${base}/?p=${p.id}`, priority: "0.8", changefreq: "weekly" });
    });
  } catch {}

  const xml = `<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
${urls.map((u) => `  <url><loc>${u.loc}</loc><changefreq>${u.changefreq}</changefreq><priority>${u.priority}</priority></url>`).join("\n")}
</urlset>`;

  res.setHeader("Content-Type", "application/xml; charset=utf-8");
  res.setHeader("Cache-Control", "s-maxage=3600, stale-while-revalidate");
  res.status(200).send(xml);
};
