// ============================================================
// GET /sitemap.xml(經vercel.json rewrite → /api/sitemap)
// 動態sitemap:自動包含所有上架產品嘅?p=id深層連結,
// 新產品上架後Google自然搵到,唔使人手更新。
// ============================================================

module.exports = async (req, res) => {
  const base = process.env.SITE_URL || "https://picked-right.it.com";

  // ===== Google Merchant Center product feed(/merchant-feed.xml)=====
  if (req.query.type === "merchant") {
    let items = [];
    try {
      const list = await fetch(`${base}/data/products.json`).then((r) => r.json());
      items = (list || []).filter((p) => !p.delisted).map((p) => {
        const name = (p.i18n?.["zh-Hant"]?.name || `Product ${p.id}`).replace(/[<>&]/g, "");
        const desc = (p.i18n?.["zh-Hant"]?.desc || name).replace(/[<>&]/g, "");
        return `  <item>
    <g:id>PRIT-${p.id}</g:id>
    <g:title>${name}</g:title>
    <g:description>${desc}</g:description>
    <g:link>${base}/?p=${p.id}</g:link>
    <g:image_link>${p.image || ""}</g:image_link>
    <g:availability>in stock</g:availability>
    <g:price>${p.price}.00 HKD</g:price>
    <g:condition>new</g:condition>
    <g:brand>PICKED RIGHT IT</g:brand>
    <g:identifier_exists>false</g:identifier_exists>
    <g:shipping><g:country>HK</g:country><g:price>0.00 HKD</g:price></g:shipping>
  </item>`;
      });
    } catch {}
    const feed = `<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0" xmlns:g="http://base.google.com/ns/1.0">
<channel>
  <title>揀啱 PICKED RIGHT IT</title>
  <link>${base}</link>
  <description>香港生活選物店</description>
${items.join("\n")}
</channel>
</rss>`;
    res.setHeader("Content-Type", "application/xml; charset=utf-8");
    res.setHeader("Cache-Control", "s-maxage=3600");
    return res.status(200).send(feed);
  }
  const urls = [
    { loc: `${base}/`, priority: "1.0", changefreq: "daily" },
    { loc: `${base}/track.html`, priority: "0.5", changefreq: "monthly" },
  ];

  // 動態上架產品(全部產品由dashboard管理)
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
