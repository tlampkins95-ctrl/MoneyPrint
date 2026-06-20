import { Router, type IRouter } from "express";
import { getTrendingSymbols, fetchSpotForDynamic } from "../lib/trending-discovery";

const router: IRouter = Router();

function extractTag(block: string, tag: string): string {
  const re = new RegExp(
    `<${tag}[^>]*>(?:\\s*<!\\[CDATA\\[)?([\\s\\S]*?)(?:\\]\\]>)?\\s*</${tag}>`,
    "i",
  );
  const m = block.match(re);
  return m ? m[1].trim() : "";
}

function stripHtml(s: string): string {
  return s.replace(/<[^>]+>/g, "").replace(/\s+/g, " ").trim();
}

function decodeEntities(s: string): string {
  return s
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'");
}

async function fetchNews() {
  try {
    const res = await fetch("https://cointelegraph.com/rss", {
      headers: { "User-Agent": "Mozilla/5.0 (compatible; Forex-Screener/1.0)" },
      signal: AbortSignal.timeout(10_000),
    });
    if (!res.ok) return [];
    const xml = await res.text();
    const articles: Array<{
      title: string;
      url: string;
      publishedAt: string;
      description: string;
    }> = [];
    const itemRe = /<item>([\s\S]*?)<\/item>/g;
    let match: RegExpExecArray | null;
    while ((match = itemRe.exec(xml)) !== null && articles.length < 20) {
      const block = match[1];
      const title = stripHtml(extractTag(block, "title"));
      const url = decodeEntities(extractTag(block, "link") || extractTag(block, "guid"));
      const publishedAt = extractTag(block, "pubDate");
      const description = stripHtml(extractTag(block, "description")).slice(0, 200);
      if (title && url) {
        articles.push({ title, url, publishedAt, description });
      }
    }
    return articles;
  } catch {
    return [];
  }
}

router.get("/news", async (_req, res) => {
  // Use trending_symbols as the gainers source. These coins are already
  // validated against OKX perp by the discovery system, so every entry
  // has real candle data and will work when clicked. Sort by 24h change
  // descending, cap at 10, and fetch current spot prices in parallel.
  const trending = getTrendingSymbols()
    .slice()
    .sort((a, b) => b.priceChange24h - a.priceChange24h)
    .slice(0, 10);

  const [articles, gainers] = await Promise.all([
    fetchNews(),
    Promise.all(
      trending.map(async (t) => {
        let price = 0;
        try {
          const p = t.okxPerp ? await fetchSpotForDynamic(t.okxPerp) : null;
          price = p ?? 0;
        } catch {
          price = 0;
        }
        return {
          symbol: t.baseAsset,
          name: t.baseAsset,
          priceChange24h: t.priceChange24h,
          price,
          volume24h: 0,
          imageUrl: "",
          hasSignalData: true as const,
        };
      }),
    ),
  ]);

  res.json({ articles, gainers });
});

export default router;
