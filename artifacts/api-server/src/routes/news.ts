import { Router, type IRouter } from "express";
import { getTrendingSymbols } from "../lib/trending-discovery";

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

interface CoinGeckoMarket {
  symbol: string;
  name: string;
  current_price: number;
  price_change_percentage_24h: number;
  total_volume: number;
  image: string;
}

async function fetchTopGainers() {
  try {
    const res = await fetch(
      "https://api.coingecko.com/api/v3/coins/markets?vs_currency=usd&order=price_change_percentage_24h_desc&per_page=50&page=1&sparkline=false",
      {
        headers: { "User-Agent": "Mozilla/5.0 (compatible; Forex-Screener/1.0)" },
        signal: AbortSignal.timeout(10_000),
      },
    );
    if (!res.ok) return [];
    const data = (await res.json()) as CoinGeckoMarket[];
    return data
      .filter(
        (c) =>
          (c.price_change_percentage_24h ?? 0) > 3 &&
          (c.total_volume ?? 0) > 500_000,
      )
      .slice(0, 10)
      .map((c) => ({
        symbol: c.symbol.toUpperCase(),
        name: c.name,
        priceChange24h: c.price_change_percentage_24h,
        price: c.current_price,
        volume24h: c.total_volume,
        imageUrl: c.image,
      }));
  } catch {
    return [];
  }
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
      const url = extractTag(block, "link") || extractTag(block, "guid");
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
  const [articles, gainers] = await Promise.all([fetchNews(), fetchTopGainers()]);

  // Only surface gainers that are already validated in the trending cache
  // (confirmed present on both OKX and Phemex). Coins not in the cache will
  // return HTTP 400 "Unknown symbol" from the levels route.
  // symbolKey is e.g. "HYPEUSDT"; gainers use bare ticker e.g. "HYPE"
  const validKeys = new Set(getTrendingSymbols().map((t) => t.symbolKey));
  const filteredGainers = gainers.filter((g) => validKeys.has(`${g.symbol}USDT`));

  res.json({ articles, gainers: filteredGainers });
});

export default router;
