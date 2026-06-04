const express = require('express');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const bcrypt = require('bcryptjs');
const cloudinary = require('cloudinary').v2;

const ROOT = __dirname;
const DB_PATH = path.join(ROOT, 'database.json');
const UPLOADS_DIR = path.join(ROOT, 'uploads');
const IMAGES_DIR = path.join(ROOT, 'images');
const PORT = process.env.PORT || 3000;
const ADMIN_MIN_LEN = 6;

// Configure Cloudinary
cloudinary.config({
  cloud_name: process.env.CLOUDINARY_CLOUD_NAME,
  api_key: process.env.CLOUDINARY_API_KEY,
  api_secret: process.env.CLOUDINARY_API_SECRET
});

const app = express();

app.use((req, res, next) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, X-Admin-Token');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS');
  if (req.method === 'OPTIONS') return res.sendStatus(204);
  next();
});

app.use(express.json({
  limit: '12mb',
  strict: false
}));

app.use((err, req, res, next) => {
  if (err instanceof SyntaxError && 'body' in err) {
    req.body = {};
    return next();
  }
  next(err);
});

// Ensure directories exist
if (!fs.existsSync(UPLOADS_DIR)) fs.mkdirSync(UPLOADS_DIR, { recursive: true });
if (!fs.existsSync(IMAGES_DIR)) fs.mkdirSync(IMAGES_DIR, { recursive: true });

const adminSessions = new Map();
let dbWriteQueue = Promise.resolve();

function readDb() {
  const raw = fs.readFileSync(DB_PATH, 'utf8');
  const db = JSON.parse(raw);
  if (!db.liveFeeds?.length) {
    db.liveFeeds = [{ id: 'f_welcome', content: 'Welcome to eFootball Arena!', createdAt: new Date().toISOString() }];
  }
  if (db.liveFeeds[0] && !db.liveFeeds[0].createdAt) {
    db.liveFeeds[0].createdAt = new Date().toISOString();
  }
  if (!db.chatMessages?.length) {
    db.chatMessages = [{ sender: 'System', text: 'Welcome to eFootball Arena!', time: Date.now() }];
  }
  return db;
}

function writeDb(mutator) {
  dbWriteQueue = dbWriteQueue.then(() => {
    const db = readDb();
    mutator(db);
    fs.writeFileSync(DB_PATH, JSON.stringify(db, null, 2), 'utf8');
  });
  return dbWriteQueue;
}

function stripPlayer(p) {
  const copy = { ...p };
  delete copy.passwordHash;
  delete copy.submissionPassword;
  delete copy.password;
  return copy;
}

async function saveAvatarFromDataUrl(id, dataUrl) {
  if (!dataUrl || typeof dataUrl !== 'string' || !dataUrl.startsWith('data:image/')) return null;
  
  try {
    const result = await cloudinary.uploader.upload(dataUrl, {
      public_id: `efootball-arena/${id}`,
      overwrite: true,
      resource_type: 'auto'
    });
    return result.secure_url;
  } catch (error) {
    console.error('Cloudinary upload error:', error);
    return null;
  }
}

function createAdminToken() {
  const token = crypto.randomBytes(32).toString('hex');
  adminSessions.set(token, Date.now() + 12 * 60 * 60 * 1000);
  return token;
}

function requireAdmin(req, res, next) {
  const token = req.headers['x-admin-token'];
  if (!token || !adminSessions.has(token)) {
    return res.status(401).json({ error: 'Admin login required' });
  }
  if (adminSessions.get(token) < Date.now()) {
    adminSessions.delete(token);
    return res.status(401).json({ error: 'Session expired — log in again' });
  }
  adminSessions.set(token, Date.now() + 12 * 60 * 60 * 1000);
  next();
}

app.use('/images', express.static(IMAGES_DIR));
app.use('/uploads', express.static(UPLOADS_DIR));

app.get('/api/health', (req, res) => {
  res.json({ ok: true, service: 'efootball-arena' });
});

function stripPendingRegistration(r) {
  const copy = { ...r };
  delete copy.passwordHash;
  delete copy.password;
  return copy;
}

function isValidAdminToken(token) {
  return token && adminSessions.has(token) && adminSessions.get(token) > Date.now();
}

app.get('/api/images', (req, res) => {
  if (!fs.existsSync(IMAGES_DIR)) return res.json({ images: [] });
  const files = fs.readdirSync(IMAGES_DIR)
    .filter(f => /\.(jpe?g|png|webp|gif|svg)$/i.test(f))
    .sort()
    .map(f => `/images/${f}`);
  res.json({ images: files });
});

app.get('/api/admin/status', (req, res) => {
  const db = readDb();
  const token = req.headers['x-admin-token'];
  let tokenValid = false;
  if (token && adminSessions.has(token) && adminSessions.get(token) > Date.now()) {
    tokenValid = true;
  }
  res.json({
    hasAdminPassword: !!db.admin?.passwordHash,
    tokenValid
  });
});

app.get('/api/bootstrap', (req, res) => {
  const db = readDb();
  const token = req.headers['x-admin-token'];
  const pendingAll = (db.pendingRegistrations || []).filter(r => r.status === 'pending');
  let pendingForAdmin = [];
  if (isValidAdminToken(token)) {
    pendingForAdmin = pendingAll.map(stripPendingRegistration);
  }
  res.json({
    hasAdminPassword: !!db.admin?.passwordHash,
    paymentSettings: db.paymentSettings,
    players: (db.players || []).map(stripPlayer),
    tournaments: db.tournaments || [],
    matches: db.matches || [],
    liveFeeds: db.liveFeeds || [],
    mediaItems: db.mediaItems || [],
    activeTournamentId: db.activeTournamentId,
    matchRequests: db.matchRequests || [],
    pendingResults: db.pendingResults || [],
    chatMessages: db.chatMessages || [],
    pendingRegistrationsCount: pendingAll.length,
    pendingForAdmin
  });
});

app.post('/api/admin/setup', async (req, res) => {
  try {
    const { password } = req.body || {};
    const db = readDb();
    if (db.admin?.passwordHash) {
      return res.status(400).json({ error: 'Admin password already set' });
    }
    if (!password || password.length < ADMIN_MIN_LEN) {
      return res.status(400).json({ error: `Password must be at least ${ADMIN_MIN_LEN} characters` });
    }
    const hash = await bcrypt.hash(password, 10);
    await writeDb(d => {
      d.admin = d.admin || { username: 'admin' };
      d.admin.passwordHash = hash;
    });
    const token = createAdminToken();
    res.json({ ok: true, token, message: 'Admin password created' });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.post('/api/admin/login', async (req, res) => {
  try {
    const { password } = req.body || {};
    const db = readDb();
    if (!db.admin?.passwordHash) {
      return res.status(400).json({ error: 'Admin not set up yet', needsSetup: true });
    }
    const ok = await bcrypt.compare(password || '', db.admin.passwordHash);
    if (!ok) return res.status(401).json({ error: 'Wrong admin password' });
    const token = createAdminToken();
    res.json({ ok: true, token });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.post('/api/admin/logout', requireAdmin, (req, res) => {
  const token = req.headers['x-admin-token'];
  adminSessions.delete(token);
  res.json({ ok: true });
});

app.post('/api/admin/change-password', requireAdmin, async (req, res) => {
  try {
    const { currentPassword, newPassword } = req.body || {};
    const db = readDb();
    if (!(await bcrypt.compare(currentPassword || '', db.admin.passwordHash))) {
      return res.status(401).json({ error: 'Current password is wrong' });
    }
    if (!newPassword || newPassword.length < ADMIN_MIN_LEN) {
      return res.status(400).json({ error: `New password must be at least ${ADMIN_MIN_LEN} characters` });
    }
    const hash = await bcrypt.hash(newPassword, 10);
    await writeDb(d => { d.admin.passwordHash = hash; });
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.put('/api/admin/payment-settings', requireAdmin, async (req, res) => {
  try {
    await writeDb(d => {
      d.paymentSettings = { ...d.paymentSettings, ...req.body };
    });
    res.json({ ok: true, paymentSettings: readDb().paymentSettings });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.get('/api/admin/pending-registrations', requireAdmin, (req, res) => {
  const db = readDb();
  const pending = (db.pendingRegistrations || [])
    .filter(r => r.status === 'pending')
    .map(stripPendingRegistration);
  res.json({ pending });
});

app.get('/api/admin/payments', requireAdmin, (req, res) => {
  const db = readDb();
  res.json({ payments: db.payments || [] });
});

app.post('/api/admin/verify-registration/:id', requireAdmin, async (req, res) => {
  try {
    let approved = null;
    await writeDb(d => {
      const reg = (d.pendingRegistrations || []).find(r => r.id === req.params.id && r.status === 'pending');
      if (!reg) return;
      if ((d.players || []).some(p => p.squad.toLowerCase() === reg.squad.toLowerCase())) {
        reg.status = 'rejected';
        return;
      }
      const playerId = 'p_' + Date.now();
      const player = {
        id: playerId,
        name: reg.name,
        username: reg.squad,
        squad: reg.squad,
        phone: reg.phone,
        country: reg.country,
        avatar: reg.avatar,
        isOnline: false,
        wins: 0,
        draws: 0,
        losses: 0,
        points: 0,
        matchesPlayed: 0,
        passwordHash: reg.passwordHash,
        paymentVerified: true,
        registeredAt: Date.now()
      };
      d.players = d.players || [];
      d.players.push(player);
      d.payments = d.payments || [];
      d.payments.push({
        squad: reg.squad,
        provider: reg.provider,
        phone: reg.phone,
        amount: reg.amount,
        currency: reg.currency || 'TZS',
        paymentRef: reg.paymentRef,
        payToNumber: reg.payToNumber,
        verifiedBy: 'admin',
        date: new Date().toISOString()
      });
      reg.status = 'verified';
      reg.verifiedAt = Date.now();
      approved = stripPlayer(player);
    });
    if (!approved) return res.status(404).json({ error: 'Registration not found or squad exists' });
    await writeDb(d => {
      d.liveFeeds = d.liveFeeds || [];
      d.liveFeeds.unshift({
        id: 'f_' + Date.now(),
        content: `✅ ${approved.squad} registered — payment verified by admin`,
        createdAt: new Date().toISOString()
      });
    });
    res.json({ ok: true, player: approved });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.post('/api/admin/reject-registration/:id', requireAdmin, async (req, res) => {
  try {
    await writeDb(d => {
      const reg = (d.pendingRegistrations || []).find(r => r.id === req.params.id);
      if (reg) reg.status = 'rejected';
    });
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.delete('/api/admin/players/:id', requireAdmin, async (req, res) => {
  try {
    await writeDb(d => {
      d.players = (d.players || []).filter(p => p.id !== req.params.id);
    });
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.post('/api/register', async (req, res) => {
  try {
    const { name, phone, country, squad, provider, password, paymentRef, avatar } = req.body || {};
    if (!name || !phone || !country || !squad || !provider || !password || !paymentRef) {
      return res.status(400).json({ error: 'Missing required fields' });
    }
    const db = readDb();
    const s = squad.toLowerCase();
    if ((db.players || []).some(p => p.squad.toLowerCase() === s)) {
      return res.status(400).json({ error: 'Squad name already exists' });
    }
    if ((db.pendingRegistrations || []).some(r => r.squad.toLowerCase() === s && r.status === 'pending')) {
      return res.status(400).json({ error: 'Registration already pending for this squad' });
    }
    const payTo = provider === 'M-Pesa' ? db.paymentSettings.mpesaNumber
      : provider === 'Tigo Pesa' ? db.paymentSettings.tigoNumber
      : provider === 'Airtel Money' ? db.paymentSettings.airtelNumber : '';
    if (!payTo) {
      return res.status(400).json({ error: `No payment number configured for ${provider}` });
    }
    const id = 'reg_' + Date.now();
    const passwordHash = await bcrypt.hash(password, 10);
    const avatarPath = await saveAvatarFromDataUrl(id, avatar) || avatar || '';
    await writeDb(d => {
      d.liveFeeds = d.liveFeeds || [];
      d.liveFeeds.unshift({
        id: 'f_' + Date.now(),
        content: `📝 ${squad} submitted registration — awaiting payment verification`,
        createdAt: new Date().toISOString()
      });
      d.pendingRegistrations = d.pendingRegistrations || [];
      d.pendingRegistrations.push({
        id,
        name,
        phone,
        country,
        squad,
        username: squad,
        provider,
        passwordHash,
        paymentRef,
        payToNumber: payTo,
        amount: d.paymentSettings.registrationFee,
        currency: d.paymentSettings.currency || 'TZS',
        avatar: avatarPath,
        status: 'pending',
        submittedAt: Date.now()
      });
    });
    res.json({ ok: true, message: 'Registration submitted. Wait for admin to verify your payment.' });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.post('/api/auth/login', async (req, res) => {
  try {
    const { squad, password } = req.body || {};
    const db = readDb();
    const pending = (db.pendingRegistrations || []).find(
      r => r.squad.toLowerCase() === (squad || '').toLowerCase() && r.status === 'pending'
    );
    if (pending) {
      return res.status(403).json({ error: 'Registration pending admin payment verification' });
    }
    const player = (db.players || []).find(p => p.squad.toLowerCase() === (squad || '').toLowerCase());
    if (!player) return res.status(401).json({ error: 'Invalid squad or password' });
    if (player.paymentVerified === false) {
      return res.status(403).json({ error: 'Payment not verified yet' });
    }
    const hash = player.passwordHash;
    if (!hash) return res.status(401).json({ error: 'Invalid squad or password' });
    const ok = await bcrypt.compare(password || '', hash);
    if (!ok) return res.status(401).json({ error: 'Invalid squad or password' });
    await writeDb(d => {
      const p = d.players.find(x => x.id === player.id);
      if (p) p.isOnline = true;
    });
    res.json({ ok: true, player: stripPlayer({ ...player, isOnline: true }) });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.post('/api/auth/logout', async (req, res) => {
  try {
    const { playerId } = req.body || {};
    if (playerId) {
      await writeDb(d => {
        const p = (d.players || []).find(x => x.id === playerId);
        if (p) p.isOnline = false;
      });
    }
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.put('/api/game-state', async (req, res) => {
  try {
    const token = req.headers['x-admin-token'];
    const isAdmin = token && adminSessions.has(token);
    await writeDb(d => {
      const body = req.body || {};
      if (body.tournaments !== undefined) d.tournaments = body.tournaments;
      if (body.matches !== undefined) d.matches = body.matches;
      if (body.liveFeeds !== undefined) d.liveFeeds = body.liveFeeds;
      if (body.mediaItems !== undefined) d.mediaItems = body.mediaItems;
      if (body.activeTournamentId !== undefined) d.activeTournamentId = body.activeTournamentId;
      if (body.matchRequests !== undefined) d.matchRequests = body.matchRequests;
      if (body.pendingResults !== undefined) d.pendingResults = body.pendingResults;
      if (body.chatMessages !== undefined) d.chatMessages = body.chatMessages;
      if (isAdmin && body.players !== undefined) {
        d.players = body.players.map(p => {
          const existing = (d.players || []).find(e => e.id === p.id);
          return existing ? { ...existing, ...p, passwordHash: existing.passwordHash } : p;
        });
      }
    });
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Serve static files
app.use(express.static(ROOT, {
  setHeaders: (res, path) => {
    if (path.endsWith('.html')) {
      res.setHeader('Cache-Control', 'no-cache');
    }
  }
}));

// SPA fallback
app.get('/', (req, res) => {
  res.sendFile(path.join(ROOT, 'index.html'));
});

app.use((req, res, next) => {
  const blocked = ['/database.json', '/package.json', '/package-lock.json', '/server.js'];
  if (blocked.includes(req.path) || req.path.startsWith('/node_modules')) {
    return res.status(404).end();
  }
  next();
});

// Fallback for SPA routes
app.get('*', (req, res) => {
  res.sendFile(path.join(ROOT, 'index.html'));
});

app.listen(PORT, '0.0.0.0', () => {
  console.log(`eFootball Arena running at http://localhost:${PORT}`);
  console.log(`Open this URL in your browser (do not open index.html as a file).`);
});
