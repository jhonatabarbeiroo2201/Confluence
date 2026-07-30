const crypto = require('crypto');

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

async function getUsers() {
  const raw = await redis(['GET', 'confluence:users']);
  return raw ? JSON.parse(raw) : {};
}
async function saveUsers(users) {
  await redis(['SET', 'confluence:users', JSON.stringify(users)]);
}
function randomToken() {
  return crypto.randomBytes(24).toString('hex');
}
function todayStr() { return new Date().toISOString().slice(0, 10); }
function addDays(n) { const d = new Date(); d.setDate(d.getDate() + n); return d.toISOString().slice(0, 10); }

module.exports = async (req, res) => {
  if (req.method !== 'POST') { res.status(405).json({ error: 'method not allowed' }); return; }
  let body = req.body;
  if (typeof body === 'string') { try { body = JSON.parse(body); } catch (e) { body = {}; } }
  const { action } = body || {};

  if (!UPSTASH_URL || !UPSTASH_TOKEN) {
    res.status(500).json({ error: 'UPSTASH_REDIS_REST_URL / UPSTASH_REDIS_REST_TOKEN não configuradas nas variáveis de ambiente da Vercel.' });
    return;
  }

  try {
    if (action === 'status') {
      const users = await getUsers();
      res.status(200).json({ hasAdmin: Object.values(users).some(u => u.role === 'admin') });
      return;
    }

    if (action === 'setup-admin') {
      const { username, passwordHash } = body;
      const users = await getUsers();
      if (Object.values(users).some(u => u.role === 'admin')) {
        res.status(400).json({ error: 'Já existe uma conta admin.' }); return;
      }
      if (!username || !passwordHash) { res.status(400).json({ error: 'Dados incompletos.' }); return; }
      users[username] = { passwordHash, role: 'admin', status: 'active', validUntil: '2099-12-31', createdAt: todayStr() };
      await saveUsers(users);
      const token = randomToken();
      await redis(['SET', `confluence:session:${token}`, username]);
      res.status(200).json({ ok: true, token, username, role: 'admin', status: 'active', validUntil: '2099-12-31' });
      return;
    }

    if (action === 'login') {
      const { username, passwordHash } = body;
      const users = await getUsers();
      const rec = users[username];
      if (!rec || rec.passwordHash !== passwordHash) {
        res.status(200).json({ ok: false, error: !rec ? 'Usuário não encontrado.' : 'Senha incorreta.' });
        return;
      }
      const token = randomToken();
      await redis(['SET', `confluence:session:${token}`, username]);
      res.status(200).json({ ok: true, token, username, role: rec.role, status: rec.status, validUntil: rec.validUntil });
      return;
    }

    if (action === 'session') {
      const { token } = body;
      const username = token && await redis(['GET', `confluence:session:${token}`]);
      if (!username) { res.status(200).json({ ok: false }); return; }
      const users = await getUsers();
      const rec = users[username];
      if (!rec) { res.status(200).json({ ok: false }); return; }
      res.status(200).json({ ok: true, username, role: rec.role, status: rec.status, validUntil: rec.validUntil });
      return;
    }

    if (action === 'logout') {
      const { token } = body;
      if (token) await redis(['DEL', `confluence:session:${token}`]);
      res.status(200).json({ ok: true });
      return;
    }

    if (action === 'signup') {
      const { email, username, passwordHash } = body;
      if (!email || !username || !passwordHash) { res.status(400).json({ error: 'Dados incompletos.' }); return; }
      const users = await getUsers();
      if (users[username]) { res.status(400).json({ error: 'Esse usuário já existe. Escolha outro.' }); return; }
      users[username] = { email, passwordHash, role: 'subscriber', status: 'blocked', validUntil: todayStr(), createdAt: todayStr() };
      await saveUsers(users);
      const token = randomToken();
      await redis(['SET', `confluence:session:${token}`, username]);
      res.status(200).json({ ok: true, token, username, role: 'subscriber', status: 'blocked', validUntil: users[username].validUntil });
      return;
    }

    if (['admin-list', 'admin-delete-user'].includes(action)) {
      const { token } = body;
      const requesterName = token && await redis(['GET', `confluence:session:${token}`]);
      const users = await getUsers();
      const requester = requesterName && users[requesterName];
      if (!requester || requester.role !== 'admin') { res.status(403).json({ error: 'Acesso negado.' }); return; }

      if (action === 'admin-list') {
        const list = Object.entries(users).filter(([, u]) => u.role === 'subscriber')
          .map(([username, u]) => ({ username, status: u.status, validUntil: u.validUntil }));
        res.status(200).json({ ok: true, users: list });
        return;
      }
      if (action === 'admin-delete-user') {
        const { targetUser } = body;
        if (users[targetUser] && users[targetUser].role === 'subscriber') {
          delete users[targetUser];
          await saveUsers(users);
        }
        res.status(200).json({ ok: true }); return;
      }
    }

    res.status(400).json({ error: 'ação desconhecida' });
  } catch (e) {
    res.status(500).json({ error: e.message || String(e) });
  }
};
