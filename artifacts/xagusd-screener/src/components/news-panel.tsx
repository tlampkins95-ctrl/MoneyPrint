import { useRef } from "react";
import { useGetNews, getGetNewsQueryKey } from "@workspace/api-client-react";
import { ExternalLink, Newspaper, RefreshCw } from "lucide-react";
import { cn } from "@/lib/utils";

function formatPubDate(raw: string): string {
  try {
    const d = new Date(raw);
    if (isNaN(d.getTime())) return raw;
    return d.toLocaleDateString("en-US", {
      month: "short",
      day: "numeric",
      hour: "2-digit",
      minute: "2-digit",
    });
  } catch {
    return raw;
  }
}

function ArticleRow({
  title,
  url,
  publishedAt,
  description,
}: {
  title: string;
  url: string;
  publishedAt: string;
  description: string;
}) {
  const touchStartY = useRef(0);
  const scrolled = useRef(false);

  return (
    <div
      className="px-4 py-3 hover:bg-white/[0.02] transition-colors group cursor-pointer"
      onTouchStart={(e) => {
        touchStartY.current = e.touches[0].clientY;
        scrolled.current = false;
      }}
      onTouchMove={(e) => {
        if (Math.abs(e.touches[0].clientY - touchStartY.current) > 8) {
          scrolled.current = true;
        }
      }}
      onClick={() => {
        if (!scrolled.current) {
          window.open(url, "_blank", "noopener,noreferrer");
        }
      }}
    >
      <div className="flex items-start justify-between gap-2">
        <p className="text-xs font-medium text-foreground leading-snug group-hover:text-primary transition-colors line-clamp-2">
          {title}
        </p>
        <ExternalLink className="w-3 h-3 text-muted-foreground shrink-0 mt-0.5 opacity-0 group-hover:opacity-100 transition-opacity" />
      </div>
      {description && (
        <p className="text-[11px] text-muted-foreground mt-1 line-clamp-2 leading-relaxed">
          {description}
        </p>
      )}
      <p className="text-[10px] text-muted-foreground/60 mt-1.5 font-mono">
        {formatPubDate(publishedAt)}
      </p>
    </div>
  );
}

export function NewsPanel() {
  const { data, isLoading, isError, refetch, isFetching } = useGetNews({
    query: {
      queryKey: getGetNewsQueryKey(),
      staleTime: 5 * 60_000,
      refetchInterval: 10 * 60_000,
    },
  });

  return (
    <div className="flex flex-col gap-3 md:gap-4">
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2">
          <Newspaper className="w-4 h-4 text-primary" />
          <span
            className="text-xs font-bold tracking-[0.18em] text-foreground"
            style={{ fontFamily: "var(--app-font-display)" }}
          >
            LATEST NEWS
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

      <div className="rounded-xl border border-border/60 bg-card/60 backdrop-blur-md overflow-hidden">
        <div className="divide-y divide-border/30 max-h-[600px] overflow-y-auto">
          {isLoading ? (
            Array.from({ length: 8 }).map((_, i) => (
              <div key={i} className="px-4 py-3 animate-pulse">
                <div className="h-3 w-4/5 bg-muted/30 rounded mb-2" />
                <div className="h-2.5 w-full bg-muted/20 rounded mb-1" />
                <div className="h-2 w-1/3 bg-muted/20 rounded" />
              </div>
            ))
          ) : isError || !data?.articles?.length ? (
            <div className="px-4 py-8 text-center text-muted-foreground text-xs">
              No news available
            </div>
          ) : (
            data.articles.map((article, i) => (
              <ArticleRow
                key={i}
                title={article.title}
                url={article.url}
                publishedAt={article.publishedAt}
                description={article.description}
              />
            ))
          )}
        </div>
      </div>
    </div>
  );
}
