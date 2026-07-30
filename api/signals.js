// Esta função roda no servidor da Vercel, não no navegador do cliente.
// Por isso ela NÃO sofre bloqueio de CORS (a Twelve Data bloqueia chamadas
// vindas diretamente do navegador, mas libera normalmente chamadas
// servidor-para-servidor) e a chave da API nunca fica visível para o cliente.

const PAIRS = [
  'EUR/USD', 'GBP/USD', 'USD/JPY', 'USD/CHF', 'USD/CAD', 'AUD/USD', 'NZD/USD',
  'EUR/GBP', 'EUR/JPY', 'GBP/JPY', 'EUR/AUD', 'EUR/CHF', 'EUR/CAD', 'EUR/NZD',
  'GBP/CHF', 'GBP/AUD', 'GBP/CAD', 'GBP/NZD', 'AUD/JPY', 'CHF/JPY', 'CAD/JPY',
  'AUD/CAD', 'AUD/NZD', 'AUD/CHF', 'NZD/JPY', 'NZD/CAD',
];

function average(arr) {
  return arr.reduce((a, b) => a + b, 0) / arr.length;
}

function findPivots(candles, span) {
  const highs = [], lows = [];
  for (let i = span; i < candles.length - span; i++) {
    const slice = candles.slice(i - span, i + span + 1);
    if (candles[i].high === Math.max(...slice.map(c => c.high))) highs.push(candles[i].high);
    if (candles[i].low === Math.min(...slice.map(c => c.low))) lows.push(candles[i].low);
  }
  return { highs, lows };
}

function analyzePair(symbol, candles) {
  if (candles.length < 55) return null;
  const closes = candles.map(c => c.close);
  const currentPrice = closes[closes.length - 1];

  const sma20 = average(closes.slice(-20));
  const sma50 = average(closes.slice(-50));
  const trendUp = sma20 > sma50;

  const win = candles.slice(-60);
  const swingHigh = Math.max(...win.map(c => c.high));
  const swingLow = Math.min(...win.map(c => c.low));
  const range = swingHigh - swingLow;
  const fibs = {
    '38.2%': swingHigh - range * 0.382,
    '50%': swingHigh - range * 0.5,
    '61.8%': swingHigh - range * 0.618,
  };

  const pivots = findPivots(win, 3);
  const supports = pivots.lows.filter(p => p < currentPrice).sort((a, b) => b - a);
  const resistances = pivots.highs.filter(p => p > currentPrice).sort((a, b) => a - b);
  const nearestSupport = supports[0];
  const nearestResistance = resistances[0];

  const tolerance = currentPrice * 0.0015;
  const nearSupport = nearestSupport !== undefined && Math.abs(currentPrice - nearestSupport) <= tolerance;
  const nearResistance = nearestResistance !== undefined && Math.abs(currentPrice - nearestResistance) <= tolerance;
  const nearFibEntry = Object.entries(fibs).find(([, v]) => Math.abs(currentPrice - v) <= tolerance);

  const buyScore = [trendUp, nearSupport, !!nearFibEntry].filter(Boolean).length;
  const sellScore = [!trendUp, nearResistance, !!nearFibEntry].filter(Boolean).length;

  const decimals = symbol.includes('JPY') ? 3 : 5;
  const fmt = (n) => n.toFixed(decimals);

  if (buyScore >= 1 && buyScore >= sellScore) {
    const stop = nearestSupport !== undefined ? nearestSupport - tolerance : currentPrice - range * 0.1;
    const alvo = nearestResistance !== undefined ? nearestResistance : currentPrice + range * 0.3;
    return { symbol, dir: 'Compra', entry: fmt(currentPrice), stop: fmt(stop), alvo: fmt(alvo) };
  }
  if (sellScore >= 1) {
    const stop = nearestResistance !== undefined ? nearestResistance + tolerance : currentPrice + range * 0.1;
    const alvo = nearestSupport !== undefined ? nearestSupport : currentPrice - range * 0.3;
    return { symbol, dir: 'Venda', entry: fmt(currentPrice), stop: fmt(stop), alvo: fmt(alvo) };
  }
  return null;
}

async function fetchCandles(symbol, apiKey) {
  const url = `https://api.twelvedata.com/time_series?symbol=${encodeURIComponent(symbol)}&interval=15min&outputsize=100&apikey=${apiKey}`;
  const r = await fetch(url);
  const data = await r.json();
  if (!data.values) throw new Error(data.message || 'sem dados retornados para ' + symbol);
  return data.values.reverse().map(v => ({
    time: v.datetime, open: +v.open, high: +v.high, low: +v.low, close: +v.close
  }));
}

const UPSTASH_URL = process.env.UPSTASH_REDIS_REST_URL;
const UPSTASH_TOKEN = process.env.UPSTASH_REDIS_REST_TOKEN;
async function redis(command) {
  const r = await fetch(UPSTASH_URL, {
    method: 'POST',
    headers: { Authorization: `Bearer ${UPSTASH_TOKEN}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(command),
  });
  const data = await r.json();
  if (!r.ok || data.error) {
    throw new Error('Upstash: ' + (data.error || `status ${r.status}`));
  }
  return data.result;
}

async function getOpenSignals() {
  try {
    const raw = await redis(['GET', 'confluence:open_signals']);
    return raw ? JSON.parse(raw) : {};
  } catch (e) { return {}; }
}
async function saveOpenSignals(obj) {
  try { await redis(['SET', 'confluence:open_signals', JSON.stringify(obj)]); } catch (e) { /* ignora */ }
}

module.exports = async (req, res) => {
  const apiKey = process.env.TWELVE_DATA_API_KEY;
  if (!apiKey) {
    res.status(500).json({ error: 'TWELVE_DATA_API_KEY não configurada nas variáveis de ambiente da Vercel.' });
    return;
  }

  const force = req.query && req.query.force === '1';
  const hasCache = UPSTASH_URL && UPSTASH_TOKEN;

  if (hasCache && !force) {
    try {
      const cachedRaw = await redis(['GET', 'confluence:signals_cache']);
      if (cachedRaw) {
        const cached = JSON.parse(cachedRaw);
        if (Date.now() - cached.fetchedAt < 3 * 60 * 1000) {
          res.status(200).json({ results: cached.results, time: cached.time });
          return;
        }
      }
    } catch (e) { /* segue sem cache se o Upstash falhar */ }
  }

  const now = Date.now();
  const VALID_MS = 5 * 60 * 1000;
  const openSignals = hasCache ? await getOpenSignals() : {};
  let openChanged = false;

  const found = [];
  const errors = [];
  for (const pair of PAIRS) {
    try {
      const candles = await fetchCandles(pair, apiKey);
      const currentPrice = candles[candles.length - 1].close;
      const open = openSignals[pair];

      if (open) {
        const stopNum = parseFloat(open.stop);
        const alvoNum = parseFloat(open.alvo);
        const hitTarget = open.dir === 'Compra' ? currentPrice >= alvoNum : currentPrice <= alvoNum;
        const hitStop = open.dir === 'Compra' ? currentPrice <= stopNum : currentPrice >= stopNum;
        const expired = (now - open.generatedAt) >= VALID_MS;

        if (!hitTarget && !hitStop && !expired) {
          // a análise anterior desse ativo ainda está em andamento — não gera uma nova
          continue;
        }
        delete openSignals[pair];
        openChanged = true;
      }

      const result = analyzePair(pair, candles);
      if (result) {
        const withMeta = { ...result, generatedAt: now, validForMs: VALID_MS };
        found.push(withMeta);
        openSignals[pair] = { dir: result.dir, stop: result.stop, alvo: result.alvo, generatedAt: now, validForMs: VALID_MS };
        openChanged = true;
      }
    } catch (e) {
      errors.push(`${pair}: ${e.message}`);
    }
  }

  if (hasCache && openChanged) await saveOpenSignals(openSignals);

  const timeStr = new Date().toLocaleTimeString('pt-BR', { timeZone: 'America/Sao_Paulo' });
  if (hasCache) {
    try {
      await redis(['SET', 'confluence:signals_cache', JSON.stringify({ results: found, time: timeStr, fetchedAt: now })]);
    } catch (e) { /* ignora falha de cache */ }
  }

  res.status(200).json({
    results: found,
    time: timeStr,
    errors: errors.length ? errors : undefined,
  });
};
