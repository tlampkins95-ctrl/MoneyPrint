import { useGetNews, getGetNewsQueryKey } from "@workspace/api-client-react";
import { ExternalLink, TrendingUp, Newspaper, RefreshCw } from "lucide-react";
import { cn } from "@/lib/utils";

function formatPubDate(raw: string): string {
  try {
    const d = new Date(raw);
    if (isNaN(d.getTime())) return raw;
    return d.toLocaleDateString("en-US", { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" });
  } catch {
    return raw;
  }
}

function formatPrice(p: number): string {
  if (p >= 1000) return `$${p.toLocaleString("en-US", { maximumFractionDigits: 0 })}`;
  if (p >= 1) return `$${p.toFixed(2)}`;
  return `$${p.toPrecision(4)}`;
}

export function NewsPanel() {
  const { data, isLoading, isError, refetch, isFetching } = useGetNews({
    query: { queryKey: getGetNewsQueryKey(), staleTime: 5 * 60_000, refetchInterval: 10 * 60_000 },
  });

  return (
    <div className="flex flex-col gap-3 md:gap-4">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2">
          <Newspaper className="w-4 h-4 text-primary" />
          <span
            className="text-xs font-bold tracking-[0.18em] text-foreground"
            style={{ fontFamily: "var(--app-font-display)" }}
          >
            MARKET PULSE
          </span>
        </div>
        <button
          type="button"
          onClick={() => refetch()}
          className="text-muted-foreground hover:text-foreground transition-colors"
          title="Refresh"
        >
          <RefreshCw className={cn("w-3.5 h-3.5", isFetching && "animate-spin")} />
        </button>
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-3 md:gap-4">
        {/* Top Gainers */}
        <div className="rounded-xl border border-border/60 bg-card/60 backdrop-blur-md overflow-hidden">
          <div className="flex items-center gap-2 px-4 py-3 border-b border-border/40">
            <TrendingUp className="w-3.5 h-3.5 text-emerald-400" />
            <span
              className="text-[11px] font-bold tracking-[0.15em] text-foreground"
              style={{ fontFamily: "var(--app-font-display)" }}
            >
              TOP GAINERS · 24H
            </span>
          </div>
          <div className="divide-y divide-border/30">
            {isLoading ? (
              Array.from({ length: 6 }).map((_, i) => (
                <div key={i} className="flex items-center justify-between px-4 py-2.5 animate-pulse">
                  <div className="flex items-center gap-3">
                    <div className="w-7 h-7 rounded-full bg-muted/30" />
                    <div>
                      <div className="h-3 w-14 bg-muted/30 rounded mb-1" />
                      <div className="h-2 w-20 bg-muted/20 rounded" />
                    </div>
                  </div>
                  <div className="text-right">
                    <div className="h-3 w-16 bg-muted/30 rounded mb-1" />
                    <div className="h-3 w-12 bg-muted/20 rounded" />
                  </div>
                </div>
              ))
            ) : isError || !data?.gainers?.length ? (
              <div className="px-4 py-8 text-center text-muted-foreground text-xs">No data</div>
            ) : (
              data.gainers.map((g, i) => (
                <div key={g.symbol} className="flex items-center justify-between px-4 py-2.5 hover:bg-white/[0.02] transition-colors">
                  <div className="flex items-center gap-3">
                    <div className="relative">
                      {g.imageUrl ? (
                        <img src={g.imageUrl} alt={g.symbol} className="w-7 h-7 rounded-full" onError={(e) => { (e.target as HTMLImageElement).style.display = "none"; }} />
                      ) : (
                        <div className="w-7 h-7 rounded-full bg-muted/30 flex items-center justify-center text-[9px] font-bold text-muted-foreground">
                          {g.symbol.slice(0, 2)}
                        </div>
                      )}
                      <span className="absolute -bottom-0.5 -right-0.5 text-[8px] font-mono text-muted-foreground bg-background rounded-full px-0.5">
                        {i + 1}
                      </span>
                    </div>
                    <div>
                      <span className="text-xs font-bold text-foreground">{g.symbol}</span>
                      <p className="text-[10px] text-muted-foreground truncate max-w-[100px]">{g.name}</p>
                    </div>
                  </div>
                  <div className="text-right">
                    <p className="text-xs font-mono text-foreground">{formatPrice(g.price)}</p>
                    <span className="text-xs font-bold text-emerald-400">
                      +{g.priceChange24h.toFixed(2)}%
                    </span>
                  </div>
                </div>
              ))
            )}
          </div>
        </div>

        {/* News Feed */}
        <div className="rounded-xl border border-border/60 bg-card/60 backdrop-blur-md overflow-hidden">
          <div className="flex items-center gap-2 px-4 py-3 border-b border-border/40">
            <Newspaper className="w-3.5 h-3.5 text-blue-400" />
            <span
              className="text-[11px] font-bold tracking-[0.15em] text-foreground"
              style={{ fontFamily: "var(--app-font-display)" }}
            >
              LATEST NEWS
            </span>
          </div>
          <div className="divide-y divide-border/30 max-h-[480px] overflow-y-auto">
            {isLoading ? (
              Array.from({ length: 5 }).map((_, i) => (
                <div key={i} className="px-4 py-3 animate-pulse">
                  <div className="h-3 w-4/5 bg-muted/30 rounded mb-2" />
                  <div className="h-2.5 w-full bg-muted/20 rounded mb-1" />
                  <div className="h-2 w-1/3 bg-muted/20 rounded" />
                </div>
              ))
            ) : isError || !data?.articles?.length ? (
              <div className="px-4 py-8 text-center text-muted-foreground text-xs">No news available</div>
            ) : (
              data.articles.map((article, i) => (
                <a
                  key={i}
                  href={article.url}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="block px-4 py-3 hover:bg-white/[0.02] transition-colors group"
                >
                  <div className="flex items-start justify-between gap-2">
                    <p className="text-xs font-medium text-foreground leading-snug group-hover:text-primary transition-colors line-clamp-2">
                      {article.title}
                    </p>
                    <ExternalLink className="w-3 h-3 text-muted-foreground shrink-0 mt-0.5 opacity-0 group-hover:opacity-100 transition-opacity" />
                  </div>
                  {article.description && (
                    <p className="text-[11px] text-muted-foreground mt-1 line-clamp-2 leading-relaxed">
                      {article.description}
                    </p>
                  )}
                  <p className="text-[10px] text-muted-foreground/60 mt-1.5 font-mono">
                    {formatPubDate(article.publishedAt)}
                  </p>
                </a>
              ))
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
