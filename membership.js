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
 * @param {boolean} forceRefresh - If true, bypasses the cache
 * @returns {Promise<boolean>} - True if joined all required channels
 */
async function checkMembership(bot, chatId, forceRefresh = false) {
    if (!chatId) return false;

    // 1. Check Cache (Skip if forceRefresh is true)
    const cached = membershipCache.get(chatId.toString());
    if (!forceRefresh && cached && (Date.now() - cached.timestamp) < CACHE_DURATION) {
        console.log(`[Membership] Using cached status for ${chatId}: ${cached.status}`);
        return cached.status;
    }

    const db = storage.getDB();
    const settings = db.settings || {};
    const CHANNELS = settings.channels || config.CHANNELS;

    console.log(`[Membership] Full refresh triggered for ${chatId}. Checking ${CHANNELS.length} channel(s)...`);

    let allJoined = true;
    let failingChannel = null;

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
                    console.warn(`[Membership] User ${chatId} is NOT in ${channel} (Status: ${member.status})`);
                    allJoined = false;
                } else {
                    console.log(`[Membership] User ${chatId} joined ${channel} (Status: ${member.status})`);
                }
                success = true; 
            } catch (err) {
                attempts++;
                const isRateLimit = err.message.includes('429') || err.message.toLowerCase().includes('too many requests');
                const isChatNotFound = err.message.includes('chat not found') || err.message.includes('Forbidden') || err.message.includes('chat_not_found');
                
                if (isChatNotFound) {
                    console.error(`[Membership] WARNING: Bot cannot access ${channel}. Skipping check for this channel. (User: ${chatId})`);
                    success = true; // Skip this channel and consider it "passed" to avoid blocking Everyone
                } else if (attempts < 2) {
                    await new Promise(resolve => setTimeout(resolve, isRateLimit ? 2000 : 500));
                } else {
                    console.error(`[Membership] Verification FAILED for ${channel} after 2 attempts: ${err.message}`);
                    allJoined = false;
                    failingChannel = channel;
                }
            }
        }

        if (!allJoined) {
            failingChannel = channel;
            break;
        }
    }

    // 2. Update Cache
    membershipCache.set(chatId.toString(), {
        status: allJoined,
        timestamp: Date.now(),
        failingChannel: allJoined ? null : failingChannel
    });

    return allJoined;
}

module.exports = { checkMembership, membershipCache };
