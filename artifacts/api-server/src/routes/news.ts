import { Router, type IRouter } from "express";
import { SYMBOLS } from "../lib/symbols";
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

function decodeEntities(s: string): string {
  return s
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'");
}

interface CmcQuote {
  price: number;
  percent_change_24h: number;
  volume_24h: number;
}

interface CmcCoin {
  id: number;
  symbol: string;
  name: string;
  quote: { USD: CmcQuote };
}

interface CmcResponse {
  data: CmcCoin[];
}

async function fetchTopGainers() {
  const apiKey = process.env["COINMARKETCAP_API_KEY"];
  if (!apiKey) return [];
  try {
    const res = await fetch(
      "https://pro-api.coinmarketcap.com/v1/cryptocurrency/listings/latest" +
        "?sort=percent_change_24h&sort_dir=desc&limit=50&convert=USD",
      {
        headers: {
          "X-CMC_PRO_API_KEY": apiKey,
          "Accept": "application/json",
        },
        signal: AbortSignal.timeout(10_000),
      },
    );
    if (!res.ok) return [];
    const body = (await res.json()) as CmcResponse;
    return (body.data ?? [])
      .filter((c) => (c.quote?.USD?.volume_24h ?? 0) > 500_000)
      .slice(0, 10)
      .map((c) => ({
        symbol: c.symbol.toUpperCase(),
        name: c.name,
        priceChange24h: c.quote.USD.percent_change_24h,
        price: c.quote.USD.price,
        volume24h: c.quote.USD.volume_24h,
        // CMC provides logos at a stable CDN URL keyed by their internal coin ID
        imageUrl: `https://s2.coinmarketcap.com/static/img/coins/64x64/${c.id}.png`,
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
  const [articles, gainers] = await Promise.all([fetchNews(), fetchTopGainers()]);

  // Tag each gainer with whether it has signal data (static symbol or live
  // trending coin). Coins that aren't in either set would return 400 if clicked,
  // so the frontend uses this flag to disable the click handler.
  const knownStaticKeys = new Set(Object.keys(SYMBOLS));
  const knownTrendingKeys = new Set(getTrendingSymbols().map((t) => t.symbolKey));
  const taggedGainers = gainers.map((g) => {
    const symKey = `${g.symbol}USDT`;
    return {
      ...g,
      hasSignalData: knownStaticKeys.has(symKey) || knownTrendingKeys.has(symKey),
    };
  });

  res.json({ articles, gainers: taggedGainers });
});

export default router;
