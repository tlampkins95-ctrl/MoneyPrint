import { Router, type IRouter, type Request, type Response } from "express";
import {
  GetSignalsResponse,
  GetPriceHistoryResponse,
  GetSignalSummaryResponse,
  GetPriceHistoryQueryParams,
} from "@workspace/api-zod";

const router: IRouter = Router();

// In-memory cache
let cachedCandles: CandleRaw[] | null = null;
let cacheTimestamp = 0;
const CACHE_TTL_MS = 5 * 60 * 1000; // 5 minutes

interface CandleRaw {
  date: string;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
}

async function fetchPriceData(): Promise<CandleRaw[]> {
  const now = Date.now();
  if (cachedCandles && now - cacheTimestamp < CACHE_TTL_MS) {
    return cachedCandles;
  }

  // Yahoo Finance — free, no API key required. SI=F = Silver Futures (COMEX)
  const url = "https://query1.finance.yahoo.com/v8/finance/chart/SI%3DF?interval=1d&range=2y";
  const response = await fetch(url, {
    headers: { "User-Agent": "Mozilla/5.0 (compatible; XAGUSD-Screener/1.0)" },
  });

  if (!response.ok) {
    throw new Error(`Yahoo Finance fetch failed: ${response.status}`);
  }

  const json = await response.json() as {
    chart: {
      result: Array<{
        timestamp: number[];
        indicators: { quote: Array<{ open: number[]; high: number[]; low: number[]; close: number[]; volume: number[] }> };
      }> | null;
      error: { code: string; description: string } | null;
    };
  };

  if (!json.chart.result || json.chart.result.length === 0) {
    throw new Error(`Yahoo Finance: ${json.chart.error?.description ?? "No data"}`);
  }

  const result = json.chart.result[0];
  const timestamps = result.timestamp;
  const quote = result.indicators.quote[0];

  const candles: CandleRaw[] = [];
  for (let i = 0; i < timestamps.length; i++) {
    const o = quote.open[i];
    const h = quote.high[i];
    const l = quote.low[i];
    const c = quote.close[i];
    const v = quote.volume[i] ?? 0;
    if (o == null || h == null || l == null || c == null) continue;
    if (isNaN(o) || isNaN(h) || isNaN(l) || isNaN(c)) continue;
    const date = new Date(timestamps[i] * 1000).toISOString().split("T")[0];
    candles.push({ date, open: o, high: h, low: l, close: c, volume: v });
  }

  cachedCandles = candles;
  cacheTimestamp = now;
  return candles;
}

// ─── Technical Indicators ───────────────────────────────────────────────────

function calcSMA(values: number[], period: number): number[] {
  const result: number[] = [];
  for (let i = 0; i < values.length; i++) {
    if (i < period - 1) {
      result.push(NaN);
    } else {
      const slice = values.slice(i - period + 1, i + 1);
      result.push(slice.reduce((a, b) => a + b, 0) / period);
    }
  }
  return result;
}

function calcEMA(values: number[], period: number): number[] {
  const k = 2 / (period + 1);
  const result: number[] = new Array(values.length).fill(NaN);
  // Find first valid SMA seed
  let start = period - 1;
  const seed = values.slice(0, period).reduce((a, b) => a + b, 0) / period;
  result[start] = seed;
  for (let i = start + 1; i < values.length; i++) {
    result[i] = values[i] * k + result[i - 1] * (1 - k);
  }
  return result;
}

function calcRSI(closes: number[], period = 14): number[] {
  const result: number[] = new Array(closes.length).fill(NaN);
  if (closes.length < period + 1) return result;

  let gains = 0;
  let losses = 0;
  for (let i = 1; i <= period; i++) {
    const diff = closes[i] - closes[i - 1];
    if (diff >= 0) gains += diff;
    else losses -= diff;
  }
  let avgGain = gains / period;
  let avgLoss = losses / period;
  result[period] = avgLoss === 0 ? 100 : 100 - 100 / (1 + avgGain / avgLoss);

  for (let i = period + 1; i < closes.length; i++) {
    const diff = closes[i] - closes[i - 1];
    const gain = diff > 0 ? diff : 0;
    const loss = diff < 0 ? -diff : 0;
    avgGain = (avgGain * (period - 1) + gain) / period;
    avgLoss = (avgLoss * (period - 1) + loss) / period;
    result[i] = avgLoss === 0 ? 100 : 100 - 100 / (1 + avgGain / avgLoss);
  }
  return result;
}

interface MACDResult {
  macd: number[];
  signal: number[];
  histogram: number[];
}

function calcMACD(closes: number[], fast = 12, slow = 26, signalPeriod = 9): MACDResult {
  const emaFast = calcEMA(closes, fast);
  const emaSlow = calcEMA(closes, slow);
  const macd = closes.map((_, i) =>
    isNaN(emaFast[i]) || isNaN(emaSlow[i]) ? NaN : emaFast[i] - emaSlow[i]
  );
  const validMacd = macd.map((v) => (isNaN(v) ? 0 : v));
  const signalLine = calcEMA(validMacd, signalPeriod);
  const histogram = macd.map((v, i) =>
    isNaN(v) || isNaN(signalLine[i]) ? NaN : v - signalLine[i]
  );
  return { macd, signal: signalLine, histogram };
}

interface BollingerResult {
  upper: number[];
  middle: number[];
  lower: number[];
  bandwidth: number[];
}

function calcBollinger(closes: number[], period = 20, multiplier = 2): BollingerResult {
  const sma = calcSMA(closes, period);
  const upper: number[] = [];
  const lower: number[] = [];
  const bandwidth: number[] = [];
  for (let i = 0; i < closes.length; i++) {
    if (isNaN(sma[i])) {
      upper.push(NaN);
      lower.push(NaN);
      bandwidth.push(NaN);
    } else {
      const slice = closes.slice(i - period + 1, i + 1);
      const mean = sma[i];
      const variance = slice.reduce((sum, v) => sum + (v - mean) ** 2, 0) / period;
      const std = Math.sqrt(variance);
      upper.push(mean + multiplier * std);
      lower.push(mean - multiplier * std);
      bandwidth.push(((mean + multiplier * std - (mean - multiplier * std)) / mean) * 100);
    }
  }
  return { upper, middle: sma, lower, bandwidth };
}

interface StochasticResult {
  k: number[];
  d: number[];
}

function calcStochastic(highs: number[], lows: number[], closes: number[], period = 14, smoothK = 3, smoothD = 3): StochasticResult {
  const rawK: number[] = new Array(closes.length).fill(NaN);
  for (let i = period - 1; i < closes.length; i++) {
    const slice_h = highs.slice(i - period + 1, i + 1);
    const slice_l = lows.slice(i - period + 1, i + 1);
    const highMax = Math.max(...slice_h);
    const lowMin = Math.min(...slice_l);
    rawK[i] = highMax === lowMin ? 50 : ((closes[i] - lowMin) / (highMax - lowMin)) * 100;
  }
  const validRawK = rawK.map((v) => (isNaN(v) ? 0 : v));
  const k = calcSMA(validRawK, smoothK);
  const validK = k.map((v) => (isNaN(v) ? 0 : v));
  const d = calcSMA(validK, smoothD);
  return { k, d };
}

function calcADX(highs: number[], lows: number[], closes: number[], period = 14): number[] {
  const result: number[] = new Array(closes.length).fill(NaN);
  if (closes.length < period * 2) return result;

  const trueRange: number[] = [0];
  const plusDM: number[] = [0];
  const minusDM: number[] = [0];

  for (let i = 1; i < closes.length; i++) {
    const tr = Math.max(
      highs[i] - lows[i],
      Math.abs(highs[i] - closes[i - 1]),
      Math.abs(lows[i] - closes[i - 1])
    );
    trueRange.push(tr);
    const upMove = highs[i] - highs[i - 1];
    const downMove = lows[i - 1] - lows[i];
    plusDM.push(upMove > downMove && upMove > 0 ? upMove : 0);
    minusDM.push(downMove > upMove && downMove > 0 ? downMove : 0);
  }

  let smoothTR = trueRange.slice(1, period + 1).reduce((a, b) => a + b, 0);
  let smoothPDM = plusDM.slice(1, period + 1).reduce((a, b) => a + b, 0);
  let smoothMDM = minusDM.slice(1, period + 1).reduce((a, b) => a + b, 0);

  const dx: number[] = new Array(period).fill(NaN);

  for (let i = period; i < closes.length; i++) {
    smoothTR = smoothTR - smoothTR / period + trueRange[i];
    smoothPDM = smoothPDM - smoothPDM / period + plusDM[i];
    smoothMDM = smoothMDM - smoothMDM / period + minusDM[i];

    const pdi = smoothTR !== 0 ? (smoothPDM / smoothTR) * 100 : 0;
    const mdi = smoothTR !== 0 ? (smoothMDM / smoothTR) * 100 : 0;
    const dxVal = pdi + mdi !== 0 ? (Math.abs(pdi - mdi) / (pdi + mdi)) * 100 : 0;
    dx.push(dxVal);
  }

  // ADX is EMA of DX
  let adxVal = dx.slice(period, period * 2).reduce((a, b) => a + b, 0) / period;
  result[period * 2 - 1] = adxVal;
  for (let i = period * 2; i < closes.length; i++) {
    adxVal = (adxVal * (period - 1) + dx[i]) / period;
    result[i] = adxVal;
  }
  return result;
}

function calcCCI(highs: number[], lows: number[], closes: number[], period = 20): number[] {
  const result: number[] = new Array(closes.length).fill(NaN);
  for (let i = period - 1; i < closes.length; i++) {
    const typicalPrices = Array.from({ length: period }, (_, j) => {
      const idx = i - period + 1 + j;
      return (highs[idx] + lows[idx] + closes[idx]) / 3;
    });
    const mean = typicalPrices.reduce((a, b) => a + b, 0) / period;
    const meanDev = typicalPrices.reduce((sum, v) => sum + Math.abs(v - mean), 0) / period;
    const tp = (highs[i] + lows[i] + closes[i]) / 3;
    result[i] = meanDev === 0 ? 0 : (tp - mean) / (0.015 * meanDev);
  }
  return result;
}

// ─── Signal Logic ────────────────────────────────────────────────────────────

type SignalEnum = "BUY" | "SELL" | "NEUTRAL";

function computeSignals(candles: CandleRaw[]) {
  const closes = candles.map((c) => c.close);
  const highs = candles.map((c) => c.high);
  const lows = candles.map((c) => c.low);
  const last = closes.length - 1;

  const rsi = calcRSI(closes, 14);
  const { macd, signal: macdSignal, histogram } = calcMACD(closes);
  const ema9 = calcEMA(closes, 9);
  const ema21 = calcEMA(closes, 21);
  const ema50 = calcEMA(closes, 50);
  const ema200 = calcEMA(closes, 200);
  const bb = calcBollinger(closes, 20, 2);
  const stoch = calcStochastic(highs, lows, closes, 14, 3, 3);
  const adx = calcADX(highs, lows, closes, 14);
  const cci = calcCCI(highs, lows, closes, 20);

  const indicators: { name: string; signal: SignalEnum; value: number; description: string }[] = [];

  // RSI
  const rsiVal = rsi[last];
  let rsiSignal: SignalEnum = "NEUTRAL";
  let rsiDesc = `RSI at ${rsiVal.toFixed(1)} — in neutral territory`;
  if (rsiVal < 30) { rsiSignal = "BUY"; rsiDesc = `RSI at ${rsiVal.toFixed(1)} — oversold, potential reversal up`; }
  else if (rsiVal < 40) { rsiSignal = "BUY"; rsiDesc = `RSI at ${rsiVal.toFixed(1)} — approaching oversold, bullish lean`; }
  else if (rsiVal > 70) { rsiSignal = "SELL"; rsiDesc = `RSI at ${rsiVal.toFixed(1)} — overbought, potential reversal down`; }
  else if (rsiVal > 60) { rsiSignal = "SELL"; rsiDesc = `RSI at ${rsiVal.toFixed(1)} — approaching overbought, bearish lean`; }
  indicators.push({ name: "RSI (14)", signal: rsiSignal, value: parseFloat(rsiVal.toFixed(2)), description: rsiDesc });

  // MACD
  const macdVal = macd[last];
  const macdSigVal = macdSignal[last];
  const macdHist = histogram[last];
  let macdSignalEnum: SignalEnum = "NEUTRAL";
  let macdDesc = `MACD histogram at ${macdHist.toFixed(4)} — flat momentum`;
  if (!isNaN(macdHist)) {
    if (macdVal > macdSigVal && macdHist > 0) { macdSignalEnum = "BUY"; macdDesc = `MACD above signal line (hist: ${macdHist.toFixed(4)}) — bullish momentum`; }
    else if (macdVal < macdSigVal && macdHist < 0) { macdSignalEnum = "SELL"; macdDesc = `MACD below signal line (hist: ${macdHist.toFixed(4)}) — bearish momentum`; }
  }
  indicators.push({ name: "MACD (12,26,9)", signal: macdSignalEnum, value: parseFloat(macdHist.toFixed(4)), description: macdDesc });

  // EMA 9/21 cross
  const e9 = ema9[last];
  const e21 = ema21[last];
  let emaCross1Signal: SignalEnum = "NEUTRAL";
  let emaCross1Desc = `EMA9 (${e9.toFixed(2)}) and EMA21 (${e21.toFixed(2)}) — no clear crossover`;
  if (!isNaN(e9) && !isNaN(e21)) {
    if (e9 > e21) { emaCross1Signal = "BUY"; emaCross1Desc = `EMA9 (${e9.toFixed(2)}) above EMA21 (${e21.toFixed(2)}) — short-term bullish`; }
    else if (e9 < e21) { emaCross1Signal = "SELL"; emaCross1Desc = `EMA9 (${e9.toFixed(2)}) below EMA21 (${e21.toFixed(2)}) — short-term bearish`; }
  }
  indicators.push({ name: "EMA Cross (9/21)", signal: emaCross1Signal, value: parseFloat((e9 - e21).toFixed(4)), description: emaCross1Desc });

  // EMA 50/200 cross (golden/death cross)
  const e50 = ema50[last];
  const e200 = ema200[last];
  let emaCross2Signal: SignalEnum = "NEUTRAL";
  let emaCross2Desc = "EMA 50/200 — insufficient data for signal";
  if (!isNaN(e50) && !isNaN(e200)) {
    if (e50 > e200) { emaCross2Signal = "BUY"; emaCross2Desc = `Golden cross: EMA50 (${e50.toFixed(2)}) above EMA200 (${e200.toFixed(2)}) — long-term bullish`; }
    else { emaCross2Signal = "SELL"; emaCross2Desc = `Death cross: EMA50 (${e50.toFixed(2)}) below EMA200 (${e200.toFixed(2)}) — long-term bearish`; }
  }
  indicators.push({ name: "EMA Cross (50/200)", signal: emaCross2Signal, value: parseFloat((e50 - e200).toFixed(4)), description: emaCross2Desc });

  // Bollinger Bands
  const bbUpper = bb.upper[last];
  const bbLower = bb.lower[last];
  const bbMiddle = bb.middle[last];
  const price = closes[last];
  let bbSignal: SignalEnum = "NEUTRAL";
  let bbDesc = `Price (${price.toFixed(2)}) inside Bollinger Bands (${bbLower.toFixed(2)} – ${bbUpper.toFixed(2)})`;
  if (!isNaN(bbUpper)) {
    const bbPos = (price - bbLower) / (bbUpper - bbLower);
    if (price <= bbLower || bbPos < 0.1) { bbSignal = "BUY"; bbDesc = `Price near lower band (${bbLower.toFixed(2)}) — potential bounce upward`; }
    else if (price >= bbUpper || bbPos > 0.9) { bbSignal = "SELL"; bbDesc = `Price near upper band (${bbUpper.toFixed(2)}) — potential pullback`; }
    else if (bbPos < 0.35) { bbSignal = "BUY"; bbDesc = `Price in lower half of bands (${bbMiddle.toFixed(2)} mid) — mild bullish`; }
    else if (bbPos > 0.65) { bbSignal = "SELL"; bbDesc = `Price in upper half of bands (${bbMiddle.toFixed(2)} mid) — mild bearish`; }
  }
  indicators.push({ name: "Bollinger Bands (20,2)", signal: bbSignal, value: parseFloat(price.toFixed(2)), description: bbDesc });

  // Stochastic
  const kVal = stoch.k[last];
  const dVal = stoch.d[last];
  let stochSignal: SignalEnum = "NEUTRAL";
  let stochDesc = `Stochastic K: ${kVal.toFixed(1)}, D: ${dVal.toFixed(1)} — neutral zone`;
  if (!isNaN(kVal) && !isNaN(dVal)) {
    if (kVal < 20 && dVal < 20) { stochSignal = "BUY"; stochDesc = `Stochastic oversold (K: ${kVal.toFixed(1)}, D: ${dVal.toFixed(1)}) — bullish reversal signal`; }
    else if (kVal > 80 && dVal > 80) { stochSignal = "SELL"; stochDesc = `Stochastic overbought (K: ${kVal.toFixed(1)}, D: ${dVal.toFixed(1)}) — bearish reversal signal`; }
    else if (kVal > dVal && kVal < 50) { stochSignal = "BUY"; stochDesc = `Stochastic K (${kVal.toFixed(1)}) crossing above D (${dVal.toFixed(1)}) in lower range — bullish`; }
    else if (kVal < dVal && kVal > 50) { stochSignal = "SELL"; stochDesc = `Stochastic K (${kVal.toFixed(1)}) crossing below D (${dVal.toFixed(1)}) in upper range — bearish`; }
  }
  indicators.push({ name: "Stochastic (14,3,3)", signal: stochSignal, value: parseFloat(kVal.toFixed(2)), description: stochDesc });

  // ADX
  const adxVal = adx[last];
  let adxSignalEnum: SignalEnum = "NEUTRAL";
  let adxDesc = `ADX at ${adxVal.toFixed(1)} — weak trend`;
  if (!isNaN(adxVal)) {
    if (adxVal > 25) {
      // Strong trend — use EMA direction to determine buy/sell
      if (!isNaN(e9) && !isNaN(e21) && e9 > e21) { adxSignalEnum = "BUY"; adxDesc = `ADX at ${adxVal.toFixed(1)} — strong uptrend confirmed`; }
      else if (!isNaN(e9) && !isNaN(e21) && e9 < e21) { adxSignalEnum = "SELL"; adxDesc = `ADX at ${adxVal.toFixed(1)} — strong downtrend confirmed`; }
      else { adxSignalEnum = "NEUTRAL"; adxDesc = `ADX at ${adxVal.toFixed(1)} — strong trend but direction unclear`; }
    } else {
      adxDesc = `ADX at ${adxVal.toFixed(1)} — weak or ranging market`;
    }
  }
  indicators.push({ name: "ADX (14)", signal: adxSignalEnum, value: parseFloat((adxVal || 0).toFixed(2)), description: adxDesc });

  // CCI
  const cciVal = cci[last];
  let cciSignal: SignalEnum = "NEUTRAL";
  let cciDesc = `CCI at ${cciVal.toFixed(1)} — neutral range`;
  if (!isNaN(cciVal)) {
    if (cciVal < -100) { cciSignal = "BUY"; cciDesc = `CCI at ${cciVal.toFixed(1)} — oversold, potential long entry`; }
    else if (cciVal > 100) { cciSignal = "SELL"; cciDesc = `CCI at ${cciVal.toFixed(1)} — overbought, potential short entry`; }
    else if (cciVal < -50) { cciSignal = "BUY"; cciDesc = `CCI at ${cciVal.toFixed(1)} — approaching oversold territory`; }
    else if (cciVal > 50) { cciSignal = "SELL"; cciDesc = `CCI at ${cciVal.toFixed(1)} — approaching overbought territory`; }
  }
  indicators.push({ name: "CCI (20)", signal: cciSignal, value: parseFloat((cciVal || 0).toFixed(2)), description: cciDesc });

  return { indicators, currentPrice: closes[last], prevPrice: closes[last - 1] };
}

// ─── Routes ──────────────────────────────────────────────────────────────────

router.get("/signals", async (req: Request, res: Response) => {
  try {
    const candles = await fetchPriceData();
    const { indicators, currentPrice, prevPrice } = computeSignals(candles);
    const priceChange = currentPrice - prevPrice;
    const priceChangePct = (priceChange / prevPrice) * 100;

    const data = GetSignalsResponse.parse({
      symbol: "XAGUSD",
      currentPrice,
      priceChange,
      priceChangePct,
      indicators,
      lastUpdated: new Date().toISOString(),
    });
    res.json(data);
  } catch (err) {
    req.log.error({ err }, "Failed to compute signals");
    res.status(500).json({ error: "Failed to fetch signal data" });
  }
});

router.get("/price-history", async (req: Request, res: Response) => {
  try {
    const query = GetPriceHistoryQueryParams.parse(req.query);
    const bars = query.bars ?? 100;
    const candles = await fetchPriceData();
    const sliced = candles.slice(-bars);

    const data = GetPriceHistoryResponse.parse({
      symbol: "XAGUSD",
      candles: sliced,
      lastUpdated: new Date().toISOString(),
    });
    res.json(data);
  } catch (err) {
    req.log.error({ err }, "Failed to fetch price history");
    res.status(500).json({ error: "Failed to fetch price history" });
  }
});

router.get("/signal-summary", async (req: Request, res: Response) => {
  try {
    const candles = await fetchPriceData();
    const { indicators, currentPrice, prevPrice } = computeSignals(candles);
    const priceChange = currentPrice - prevPrice;
    const priceChangePct = (priceChange / prevPrice) * 100;

    const buyCount = indicators.filter((i) => i.signal === "BUY").length;
    const sellCount = indicators.filter((i) => i.signal === "SELL").length;
    const neutralCount = indicators.filter((i) => i.signal === "NEUTRAL").length;
    const total = indicators.length;

    // Compute overall signal
    const buyRatio = buyCount / total;
    const sellRatio = sellCount / total;
    type OverallSignal = "STRONG_BUY" | "BUY" | "NEUTRAL" | "SELL" | "STRONG_SELL";
    let overallSignal: OverallSignal = "NEUTRAL";
    let confidence = 50;

    if (buyRatio >= 0.65) { overallSignal = "STRONG_BUY"; confidence = Math.round(buyRatio * 100); }
    else if (buyRatio >= 0.45) { overallSignal = "BUY"; confidence = Math.round(buyRatio * 100); }
    else if (sellRatio >= 0.65) { overallSignal = "STRONG_SELL"; confidence = Math.round(sellRatio * 100); }
    else if (sellRatio >= 0.45) { overallSignal = "SELL"; confidence = Math.round(sellRatio * 100); }
    else {
      confidence = Math.round((1 - Math.abs(buyRatio - sellRatio)) * 50 + 20);
    }

    const data = GetSignalSummaryResponse.parse({
      symbol: "XAGUSD",
      overallSignal,
      buyCount,
      sellCount,
      neutralCount,
      confidence,
      currentPrice,
      priceChange,
      priceChangePct,
      lastUpdated: new Date().toISOString(),
    });
    res.json(data);
  } catch (err) {
    req.log.error({ err }, "Failed to compute signal summary");
    res.status(500).json({ error: "Failed to fetch signal summary" });
  }
});

export default router;
