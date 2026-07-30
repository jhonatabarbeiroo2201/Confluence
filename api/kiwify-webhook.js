// Esta é a "ponte" entre o Kiwify e o site. Configure no painel do Kiwify:
// Webhooks > Criar webhook > URL: https://SEU-SITE.vercel.app/api/kiwify-webhook?token=SEU_TOKEN_SECRETO
// Eventos a marcar: Compra aprovada, Assinatura Renovada, Assinatura Cancelada, Assinatura Atrasada,
// Compra Recusada, Compra Reembolsada, Chargeback.
// O "SEU_TOKEN_SECRETO" deve ser o mesmo valor que você colocar na variável de ambiente
// KIWIFY_WEBHOOK_TOKEN na Vercel — isso impede que qualquer pessoa chame essa URL e libere acesso de graça.

const UPSTASH_URL = process.env.UPSTASH_REDIS_REST_URL;
const UPSTASH_TOKEN = process.env.UPSTASH_REDIS_REST_TOKEN;

async function redis(command) {
  const r = await fetch(UPSTASH_URL, {
    method: 'POST',
    headers: { Authorization: `Bearer ${UPSTASH_TOKEN}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(command),
  });
  const data = await r.json();
  if (!r.ok || data.error) throw new Error('Upstash: ' + (data.error || `status ${r.status}`));
  return data.result;
}

async function getUsers() {
  const raw = await redis(['GET', 'confluence:users']);
  return raw ? JSON.parse(raw) : {};
}
async function saveUsers(users) {
  await redis(['SET', 'confluence:users', JSON.stringify(users)]);
}
function addDays(n) { const d = new Date(); d.setDate(d.getDate() + n); return d.toISOString().slice(0, 10); }

// Nomes de evento possíveis — cobrimos várias variações porque o formato exato
// pode precisar de ajuste fino depois do primeiro teste real.
const ACTIVATE_EVENTS = ['compra_aprovada', 'subscription_renewed', 'assinatura_renovada', 'order_approved', 'paid', 'approved'];
const BLOCK_EVENTS = ['subscription_canceled', 'subscription_late', 'assinatura_cancelada', 'assinatura_atrasada', 'chargeback', 'compra_reembolsada', 'compra_recusada', 'refused', 'refunded', 'canceled'];

module.exports = async (req, res) => {
  if (req.method !== 'POST') { res.status(405).json({ error: 'method not allowed' }); return; }

  const expectedToken = process.env.KIWIFY_WEBHOOK_TOKEN;
  if (expectedToken && req.query.token !== expectedToken) {
    res.status(401).json({ error: 'token inválido' });
    return;
  }

  let body = req.body;
  if (typeof body === 'string') { try { body = JSON.parse(body); } catch (e) { body = {}; } }

  const eventType = (body.webhook_event_type || body.event || body.order_status || '').toString().toLowerCase();
  const email = body?.Customer?.email || body?.customer?.email || body?.data?.customer?.email || body?.customer_email || body?.email || null;

  // guarda o último payload recebido, para diagnosticar caso algo não bata certinho
  try {
    await redis(['SET', 'confluence:last_kiwify_payload', JSON.stringify({ eventType, email, body, receivedAt: Date.now() })]);
  } catch (e) { /* não trava o processamento se isso falhar */ }

  if (!email) { res.status(200).json({ ok: true, note: 'payload sem e-mail identificável' }); return; }

  try {
    const users = await getUsers();
    const username = Object.keys(users).find(u => users[u].email && users[u].email.toLowerCase() === email.toLowerCase());
    if (!username) { res.status(200).json({ ok: true, note: 'nenhum cadastro com esse e-mail' }); return; }

    const isActivate = ACTIVATE_EVENTS.some(e => eventType.includes(e));
    const isBlock = BLOCK_EVENTS.some(e => eventType.includes(e));

    if (isActivate) {
      users[username].status = 'active';
      users[username].validUntil = addDays(31);
      await saveUsers(users);
    } else if (isBlock) {
      users[username].status = 'blocked';
      await saveUsers(users);
    }

    res.status(200).json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: e.message || String(e) });
  }
};
