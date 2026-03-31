const { Telegraf } = require('telegraf');
const axios = require('axios');

const config = require('./config');
const storage = require('./storage');

const API_URL = config.API_URL;
const API_KEY = config.API_KEY;
const BOT_TOKEN = config.NOTIFY_BOT_TOKEN;

const bot = new Telegraf(BOT_TOKEN);
const sessionCache = new Map();

// --- MEMBERSHIP CHECK LOGIC ---
const CHANNELS = config.CHANNELS; // ['@bdhitlog', '@hitterlite', '@Nexvora_Official']

async function isSubscribed(ctx) {
    const userId = ctx.from.id;
    
    // Admins or special users can bypass if needed (optional)
    // if (userId == SOME_ADMIN_ID) return true;

    try {
        for (const channelBody of CHANNELS) {
            // Remove @ for API call
            const channel = channelBody.startsWith('@') ? channelBody : `@${channelBody}`;
            const member = await ctx.telegram.getChatMember(channel, userId);
            
            if (['left', 'kicked', 'restricted'].includes(member.status)) {
                return false;
            }
        }
        return true;
    } catch (err) {
        console.error('[Bot] Membership check error:', err.message);
        // If bot is not admin in channel, this fails. Assume not joined for safety.
        return false;
    }
}

// Start Command
bot.start(async (ctx) => {
    const subscribed = await isSubscribed(ctx);
    
    if (!subscribed) {
        const keyboard = {
            inline_keyboard: [
                [{ text: "📢 Join BD Hit Log", url: "https://t.me/bdhitlog" }],
                [{ text: "📢 Join Hitter Lite", url: "https://t.me/hitterlite" }],
                [{ text: "📢 Join Nexvora Official", url: "https://t.me/Nexvora_Official" }],
                [{ text: "🔄 Verify Join", callback_data: "verify_join" }]
            ]
        };

        return ctx.replyWithHTML(
            "👋 <b>Welcome!</b>\n\nTo use this bot, you must join our official channels first. Click the buttons below to join, then click <b>Verify Join</b>.",
            { reply_markup: keyboard }
        );
    }

    const chat_id = ctx.chat.id;
    const msg = `🔥 <b>Auto Hitter Bot</b>
━━━━━━━━━━━━━━━━━━━━
🆔 <b>Your Chat ID:</b> <code>${chat_id}</code> (Click to copy)
━━━━━━━━━━━━━━━━━━━━
Send cards (one per line):
/co [url] [cards]
/inv [url] [cards]
/bill [url] [cards]

Card format:
4242424242424242|12|26|123
5500000000000004|06|27|456`;
    
    ctx.replyWithHTML(msg);
});

// Handle Verify Join Button
bot.action('verify_join', async (ctx) => {
    const subscribed = await isSubscribed(ctx);
    
    if (subscribed) {
        await ctx.answerCbQuery("✅ Access Granted! Welcome.");
        await ctx.deleteMessage().catch(() => {});
        
        const chat_id = ctx.from.id;
        const msg = `🔥 <b>Auto Hitter Bot</b>\n\n🆔 <b>Your Chat ID:</b> <code>${chat_id}</code>\n\nYou can now use all features. Send cards using /co, /inv, or /bill.`;
        ctx.replyWithHTML(msg);
    } else {
        await ctx.answerCbQuery("❌ You haven't joined all channels yet!", { show_alert: true });
    }
});

// Gate Commands
bot.command('co', (ctx) => runHit(ctx, 'checkout'));
bot.command('inv', (ctx) => runHit(ctx, 'invoice'));
bot.command('bill', (ctx) => runHit(ctx, 'billing'));

async function runHit(ctx, gate) {
    // Check Membership first
    const subscribed = await isSubscribed(ctx);
    if (!subscribed) {
        return ctx.reply("❌ Access Denied: You must join our channels first. Use /start to see the links.");
    }

    const text = ctx.message.text;
    const parts = text.split(/\s+/);
    
    if (parts.length < 3) {
        return ctx.reply(`Usage: /co <stripe_url> <card|mm|yy|cvv>\n\nExample:\n/co <url> 4242424242424242|12|26|123`);
    }

    const url = parts[1];
    const cardsRaw = text.substring(text.indexOf(parts[2]));
    const cards = cardsRaw.split('\n').map(c => c.trim()).filter(c => c.length > 0);

    if (cards.length === 0) {
        return ctx.reply("❌ No valid cards provided.");
    }

    const uid = ctx.from.id;
    const db = storage.getDB();
    let user = db.users[uid];

    // Auto-register if not exists
    if (!user) {
        user = {
            plan: 'free',
            hits_today: 0,
            last_hit_date: new Date().toDateString(),
            expiry: null,
            referralCount: 0,
            referredBy: null
        };
        db.users[uid] = user;
        await storage.save(db);
    }

    // Reset hits if it's a new day
    const today = new Date().toDateString();
    if (user.last_hit_date !== today) {
        user.hits_today = 0;
        user.last_hit_date = today;
        await storage.save(db);
    }

    // Enforce Limit
    if (user.plan === 'free' && user.hits_today >= 2) {
        return ctx.reply("❌ Limit Reached: You have used your 2 free hits for today. Please upgrade to Silver or Gold for unlimited access!");
    }

    const totalCards = cards.length;
    let waitMsg;
    
    try {
        waitMsg = await ctx.reply(`⏳ Checking ${totalCards} card(s)... (0/${totalCards})\n👤 Plan: ${user.plan.toUpperCase()} | Hits Left: ${user.plan === 'free' ? (2 - user.hits_today) : 'Unlimited'}`);
    } catch (err) {
        return console.error('Failed to send initial message', err);
    }

    let chargedCount = 0;
    let liveCount = 0;
    const results = [];

    for (let i = 0; i < cards.length; i++) {
        const card = cards[i];
        
        try {
            await ctx.telegram.editMessageText(
                ctx.chat.id, waitMsg.message_id, undefined,
                `⏳ Checking ${totalCards} card(s)... (${i}/${totalCards})\n` +
                `✅ Charged: ${chargedCount} | ⚡ Live: ${liveCount}`
            );
        } catch (e) {}

        try {
            const response = await axios.post(`${API_URL}/hit/${gate}`, {
                url: url,
                card: card,
                session_cache: sessionCache.get(uid)
            }, {
                headers: { 'X-API-Key': API_KEY, 'Content-Type': 'application/json' },
                timeout: 120000
            });

            const resp = response.data;
            if (resp.session_cache) sessionCache.set(uid, resp.session_cache);

            const status = resp.status || 'error';
            if (['charged', 'approved'].includes(status)) {
                chargedCount++;
                // Increment hits in DB if success
                if (user.plan === 'free') {
                    user.hits_today++;
                    await storage.save(db);
                }
            } else if (status === 'live') {
                liveCount++;
            }

            results.push({ card, status, message: resp.message || 'Unknown' });

            // Stop if limit reached after this hit
            if (user.plan === 'free' && user.hits_today >= 2) {
                results.push({ card: '---', status: 'limit', message: 'Daily limit reached' });
                break;
            }
        } catch (e) {
            results.push({ card, status: 'error', message: e.message });
        }
    }

    // Final Summary
    const icons = { charged: "✅", approved: "✅", live: "⚡", live_declined: "❌", error: "⚠️", dead: "💀" };
    let reply = `📊 <b>Results: ${chargedCount} Charged, ${liveCount} Live, ${totalCards - (chargedCount + liveCount)} Dead</b>\n\n`;
    
    results.forEach(r => {
        const icon = icons[r.status] || "❓";
        const cParts = r.card.split('|');
        let display = r.card;
        if (cParts[0] && cParts[0].length > 10) {
            display = `${cParts[0].substring(0,6)}******${cParts[0].substring(cParts[0].length-4)}|${cParts[1]}|${cParts[2]}|${cParts[3]}`;
        }
        reply += `${icon} <code>${display}</code> - ${r.status.toUpperCase()}\n`;
    });

    if (reply.length > 4000) reply = reply.substring(0, 3990) + "\n... (truncated)";
    
    try {
        await ctx.telegram.editMessageText(ctx.chat.id, waitMsg.message_id, undefined, reply, { parse_mode: 'HTML' });
    } catch (err) {
        ctx.replyWithHTML(reply);
    }
}

module.exports = bot;
