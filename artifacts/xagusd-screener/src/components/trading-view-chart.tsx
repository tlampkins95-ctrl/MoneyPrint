import { useEffect, useRef } from "react";

export function TradingViewChart() {
  const containerRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!containerRef.current) return;
    containerRef.current.innerHTML = "";
    const script = document.createElement("script");
    script.src = "https://s3.tradingview.com/external-embedding/embed-widget-advanced-chart.js";
    script.type = "text/javascript";
    script.async = true;
    script.innerHTML = JSON.stringify({
      autosize: true,
      symbol: "OANDA:XAGUSD",
      interval: "D",
      timezone: "Etc/UTC",
      theme: "dark",
      style: "1",
      locale: "en",
      allow_symbol_change: false,
      calendar: false,
      support_host: "https://www.tradingview.com"
    });
    containerRef.current.appendChild(script);
  }, []);

  return (
    <div className="tradingview-widget-container h-full w-full bg-card rounded-sm overflow-hidden border" ref={containerRef}>
      <div className="tradingview-widget-container__widget h-[calc(100%-32px)] w-full"></div>
    </div>
  );
}