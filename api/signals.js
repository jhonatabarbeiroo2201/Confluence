// Esta função roda no servidor da Vercel, não no navegador do cliente.
// Por isso ela NÃO sofre bloqueio de CORS (a Twelve Data bloqueia chamadas
// vindas diretamente do navegador, mas libera normalmente chamadas
// servidor-para-servidor) e a chave da API nunca fica visível para o cliente.

const FOREX_PAIRS = [
  'EUR/USD', 'GBP/USD', 'USD/JPY', 'USD/CHF', 'USD/CAD', 'AUD/USD', 'NZD/USD',
  'EUR/GBP', 'EUR/JPY', 'GBP/JPY', 'EUR/AUD', 'EUR/CHF', 'EUR/CAD', 'EUR/NZD',
  'GBP/CHF', 'GBP/AUD', 'GBP/CAD', 'GBP/NZD', 'AUD/JPY', 'CHF/JPY', 'CAD/JPY',
  'AUD/CAD', 'AUD/NZD', 'AUD/CHF', 'NZD/JPY', 'NZD/CAD', 'NZD/CHF', 'USD/SGD',
  'USD/HKD', 'USD/MXN', 'USD/ZAR', 'USD/TRY', 'EUR/SGD', 'GBP/SGD', 'EUR/TRY',
];
const METAL_PAIRS = ['XAU/USD', 'XAG/USD']; // ouro e prata — seguem horário parecido com forex
const CRYPTO_PAIRS = [
  'BTC/USD', 'ETH/USD', 'BTC/JPY', 'ETH/BTC', 'XRP/USD', 'LTC/USD', 'BCH/USD', 'BTC/EUR',
]; // cripto — mercado 24 horas, 7 dias por semana

const PAIRS = [...FOREX_PAIRS, ...METAL_PAIRS, ...CRYPTO_PAIRS];

function isCrypto(symbol) { return CRYPTO_PAIRS.includes(symbol); }

// Forex e metais fecham do fim da tarde de sexta (horário de Nova York) até o início da noite
// de domingo — aproximando pelo horário UTC, já que não dá pra cravar o horário de virada do
// relógio de verão com precisão total sem uma biblioteca de fuso horário.
function isMarketOpen(symbol) {
  if (isCrypto(symbol)) return true;
  const now = new Date();
  const day = now.getUTCDay(); // 0=domingo ... 6=sábado
  const hour = now.getUTCHours();
  if (day === 6) return false; // sábado inteiro fechado
  if (day === 0 && hour < 21) return false; // domingo antes de ~21h UTC ainda fechado
  if (day === 5 && hour >= 21) return false; // sexta depois de ~21h UTC já fechado
  return true;
}

function decimalsFor(symbol) {
  if (symbol.startsWith('BTC') || symbol.includes('/BTC')) return 2;
  if (symbol.startsWith('ETH') || symbol.startsWith('XRP') || symbol.startsWith('LTC') || symbol.startsWith('BCH')) return 2;
  if (symbol.startsWith('XAU') || symbol.startsWith('XAG')) return 2;
  if (symbol.includes('JPY')) return 3;
  return 5;
}

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

function ema(values, period) {
  const k = 2 / (period + 1);
  let prev = values[0];
  const out = [prev];
  for (let i = 1; i < values.length; i++) {
    const v = values[i] * k + prev * (1 - k);
    out.push(v);
    prev = v;
  }
  return out;
}

function rsi(closes, period = 14) {
  let gains = 0, losses = 0;
  for (let i = closes.length - period; i < closes.length; i++) {
    const diff = closes[i] - closes[i - 1];
    if (diff >= 0) gains += diff; else losses -= diff;
  }
  const avgGain = gains / period, avgLoss = losses / period;
  if (avgLoss === 0) return 100;
  const rs = avgGain / avgLoss;
  return 100 - 100 / (1 + rs);
}

function macd(closes) {
  const ema12 = ema(closes, 12);
  const ema26 = ema(closes, 26);
  const macdLine = closes.map((_, i) => ema12[i] - ema26[i]);
  const signalLine = ema(macdLine, 9);
  return { macdVal: macdLine[macdLine.length - 1], signalVal: signalLine[signalLine.length - 1] };
}

function analyzePair(symbol, candles) {
  if (candles.length < 60) return null;
  const closes = candles.map(c => c.close);
  const currentPrice = closes[closes.length - 1];

  const sma20 = average(closes.slice(-20));
  const sma50 = average(closes.slice(-50));
  const trendUp = sma20 > sma50;

  const rsiVal = rsi(closes, 14);
  const { macdVal, signalVal } = macd(closes);

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

  const rsiBuy = rsiVal < 40;
  const rsiSell = rsiVal > 60;
  const macdBuy = macdVal > signalVal;
  const macdSell = macdVal < signalVal;

  const buyScore = [trendUp, nearSupport, !!nearFibEntry, rsiBuy, macdBuy].filter(Boolean).length;
  const sellScore = [!trendUp, nearResistance, !!nearFibEntry, rsiSell, macdSell].filter(Boolean).length;

  const decimals = decimalsFor(symbol);
  const fmt = (n) => n.toFixed(decimals);
  const MIN_SCORE = 1; // qualquer confluência entre as 5 estratégias já pode gerar sinal — a força fica marcada no score

  if (buyScore >= MIN_SCORE && buyScore >= sellScore) {
    const stop = nearestSupport !== undefined ? nearestSupport - tolerance : currentPrice - range * 0.1;
    const alvo = buyScore >= 4
      ? (resistances[1] !== undefined ? resistances[1] : currentPrice + range * 0.55)
      : (nearestResistance !== undefined ? nearestResistance : currentPrice + range * 0.3);
    return { symbol, dir: 'Compra', entry: fmt(currentPrice), stop: fmt(stop), alvo: fmt(alvo), score: buyScore };
  }
  if (sellScore >= MIN_SCORE) {
    const stop = nearestResistance !== undefined ? nearestResistance + tolerance : currentPrice + range * 0.1;
    const alvo = sellScore >= 4
      ? (supports[1] !== undefined ? supports[1] : currentPrice - range * 0.55)
      : (nearestSupport !== undefined ? nearestSupport : currentPrice - range * 0.3);
    return { symbol, dir: 'Venda', entry: fmt(currentPrice), stop: fmt(stop), alvo: fmt(alvo), score: sellScore };
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
          res.status(200).json({ results: cached.results, time: cached.time, stats: cached.stats, cached: true });
          return;
        }
      }
    } catch (e) { /* segue sem cache se o Upstash falhar */ }
  }

  const now = Date.now();
  const VALID_MS = 5 * 60 * 1000;
  const MAX_NEW_PER_SCAN = 4;
  const openSignals = hasCache ? await getOpenSignals() : {};
  let openChanged = false;

  const candidates = [];
  const errors = [];
  let fechados = 0;
  for (const pair of PAIRS) {
    if (!isMarketOpen(pair)) { fechados++; continue; } // mercado fechado agora — nem tenta analisar
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
      if (result) candidates.push(result);
    } catch (e) {
      errors.push(`${pair}: ${e.message}`);
    }
  }

  // ordena pelos mais fortes (mais critérios técnicos concordando) e só libera os melhores agora —
  // o restante fica disponível para aparecer nas próximas varreduras, entrando aos poucos na lista
  candidates.sort((a, b) => b.score - a.score);
  const chosen = candidates.slice(0, MAX_NEW_PER_SCAN);

  const found = chosen.map(c => {
    const withMeta = { ...c, generatedAt: now, validForMs: VALID_MS };
    openSignals[c.symbol] = { dir: c.dir, stop: c.stop, alvo: c.alvo, generatedAt: now, validForMs: VALID_MS };
    openChanged = true;
    return withMeta;
  });

  if (hasCache && openChanged) await saveOpenSignals(openSignals);

  const timeStr = new Date().toLocaleTimeString('pt-BR', { timeZone: 'America/Sao_Paulo' });
  const stats = {
    totalPares: PAIRS.length,
    fechados,
    paresAnalisados: PAIRS.length - fechados - errors.length,
    qualificaram: candidates.length,
    exibidosAgora: chosen.length,
    jaEmAndamento: PAIRS.length - fechados - errors.length - candidates.length,
    erros: errors.length,
  };
  if (hasCache) {
    try {
      await redis(['SET', 'confluence:signals_cache', JSON.stringify({ results: found, time: timeStr, fetchedAt: now, stats })]);
    } catch (e) { /* ignora falha de cache */ }
  }

  res.status(200).json({
    results: found,
    time: timeStr,
    stats,
    errors: errors.length ? errors : undefined,
  });
};
