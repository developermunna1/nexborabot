const storage = require('./storage');
const config = require('./config');

// In-memory cache for membership status
// Format: { chatId: { status: boolean, timestamp: number } }
const membershipCache = new Map();
const CACHE_DURATION = 3 * 60 * 1000; // 3 minutes

/**
 * Robust membership check with retry logic and caching
 * @param {object} bot - Telegraf bot instance
 * @param {string|number} chatId - User's Telegram ID
 * @returns {Promise<boolean>} - True if joined all required channels
 */
async function checkMembership(bot, chatId) {
    if (!chatId) return false;

    // 1. Check Cache First
    const cached = membershipCache.get(chatId.toString());
    if (cached && (Date.now() - cached.timestamp) < CACHE_DURATION) {
        console.log(`[Membership] Using cached status for ${chatId}: ${cached.status}`);
        return cached.status;
    }

    const db = storage.getDB();
    const settings = db.settings || {};
    const CHANNELS = settings.channels || config.CHANNELS;

    let allJoined = true;

    for (const channelBody of CHANNELS) {
        let channel = channelBody;
        if (typeof channel === 'string' && !channel.startsWith('-') && !channel.startsWith('@')) {
            channel = `@${channel}`;
        }

        // Retry Logic (Max 2 attempts)
        let success = false;
        let attempts = 0;
        let lastStatus = 'unknown';

        while (attempts < 2 && !success) {
            try {
                const member = await bot.telegram.getChatMember(channel, chatId);
                lastStatus = member.status;
                
                // Allow: creator, administrator, member, restricted (restricted are still members)
                if (['left', 'kicked'].includes(member.status)) {
                    allJoined = false;
                }
                success = true; // Call succeeded (even if status is 'left')
            } catch (err) {
                attempts++;
                const isRateLimit = err.message.includes('429') || err.message.toLowerCase().includes('too many requests');
                const isChatNotFound = err.message.includes('chat not found') || err.message.includes('Forbidden');
                
                console.warn(`[Membership] Attempt ${attempts} failed for ${channel} (User: ${chatId}): ${err.message}`);
                
                if (isChatNotFound) {
                    // Bot isn't admin or channel doesn't exist - can't verify, so assume failed for safety
                    allJoined = false;
                    success = true; // No point in retrying chat-not-found
                } else if (attempts < 2) {
                    // Wait a bit before retry if it's a network error or rate limit
                    await new Promise(resolve => setTimeout(resolve, isRateLimit ? 2000 : 500));
                } else {
                    // After 2 failed attempts (network/timeout), we assume NOT joined to be safe
                    allJoined = false;
                }
            }
        }

        if (!allJoined) break;
    }

    // 2. Update Cache
    membershipCache.set(chatId.toString(), {
        status: allJoined,
        timestamp: Date.now()
    });

    return allJoined;
}

module.exports = { checkMembership };
