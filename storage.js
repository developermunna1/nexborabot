const axios = require('axios');
const fs = require('fs');
const path = require('path');
const config = require('./config');

const FIREBASE_URL = config.FIREBASE_URL ? (config.FIREBASE_URL.endsWith('/') ? config.FIREBASE_URL.slice(0, -1) : config.FIREBASE_URL) : null;
const DB_PATH = 'database.json';

let dbCache = { users: {}, redeem_codes: {} }; // Initialized to prevent null errors

const storage = {
    async init() {
        if (!FIREBASE_URL) {
            console.warn('⚠️ FIREBASE_URL is not set. Using local storage.');
            return this.loadLocal();
        }
        return this.loadFirebase();
    },

    async loadLocal() {
        try {
            const filePath = path.join(__dirname, DB_PATH);
            if (fs.existsSync(filePath)) {
                const data = fs.readFileSync(filePath, 'utf8');
                dbCache = data ? JSON.parse(data) : { users: {}, redeem_codes: {} };
            }
        } catch (err) {
            console.error('[Storage] Local load failed:', err.message);
        }
        if (!dbCache.users) dbCache.users = {};
        if (!dbCache.redeem_codes) dbCache.redeem_codes = {};
        return dbCache;
    },

    async loadFirebase() {
        try {
            if (!FIREBASE_URL) return this.loadLocal();
            
            console.log('[Storage] Fetching DB from Firebase...');
            
            // Add a timeout to avoid hanging on DNS issues
            const response = await axios.get(`${FIREBASE_URL}/db.json`, { 
                timeout: 5000,
                headers: { 'Accept': 'application/json' }
            });
            
            if (response.data && typeof response.data === 'object') {
                dbCache = response.data;
                if (!dbCache.users) dbCache.users = {};
                if (!dbCache.redeem_codes) dbCache.redeem_codes = {};
                console.log('[Storage] DB loaded from Firebase.');
            } else {
                console.log('[Storage] Firebase DB is empty or uninitialized. Using local defaults.');
                await this.loadLocal();
            }
            return dbCache;
        } catch (err) {
            console.error('[Storage] Firebase load failed (falling back to local):', err.message);
            return this.loadLocal();
        }
    },

    async save(data) {
        if (data) {
            // Safety: Never allow overwriting with an empty object if we had data before
            if (data.users && Object.keys(data.users).length === 0 && dbCache.users && Object.keys(dbCache.users).length > 0) {
                console.error('[Storage] CRITICAL: Attempted to save empty user list. Aborting save.');
                return;
            }
            dbCache = data;
        }
        
        if (!dbCache.users) dbCache.users = {};
        if (!dbCache.redeem_codes) dbCache.redeem_codes = {};

        if (!FIREBASE_URL) {
            this.saveLocal();
            return;
        }

        try {
            await axios.put(`${FIREBASE_URL}/db.json`, dbCache);
        } catch (err) {
            console.error('[Storage] Firebase save failed:', err.message);
            this.saveLocal();
        }
    },

    async saveUser(chatId, userData) {
        if (!chatId) return;
        const id = chatId.toString();
        
        // Update local cache
        if (!dbCache.users[id]) dbCache.users[id] = {};
        dbCache.users[id] = { ...dbCache.users[id], ...userData };

        if (!FIREBASE_URL) return this.saveLocal();

        try {
            // Use PATCH to update only specific user's fields
            await axios.patch(`${FIREBASE_URL}/users/${id}.json`, userData);
            console.log(`[Storage] Firebase User ${id} updated.`);
        } catch (err) {
            console.error(`[Storage] Firebase User ${id} save failed:`, err.message);
            this.saveLocal();
        }
    },

    async saveRedeemCode(code, codeData) {
        if (!code) return;
        
        // Update local cache
        if (!dbCache.redeem_codes[code]) dbCache.redeem_codes[code] = {};
        dbCache.redeem_codes[code] = { ...dbCache.redeem_codes[code], ...codeData };

        if (!FIREBASE_URL) return this.saveLocal();

        try {
            // Use PATCH to update only specific code's fields
            await axios.patch(`${FIREBASE_URL}/redeem_codes/${code}.json`, codeData);
            console.log(`[Storage] Firebase Redeem Code ${code} updated.`);
        } catch (err) {
            console.error(`[Storage] Firebase Redeem Code ${code} save failed:`, err.message);
            this.saveLocal();
        }
    },

    async saveSettings(settingsData) {
        if (!settingsData) return;
        
        // Update local cache
        dbCache.settings = { ...(dbCache.settings || {}), ...settingsData };

        if (!FIREBASE_URL) return this.saveLocal();

        try {
            // Use PATCH to update settings node
            await axios.patch(`${FIREBASE_URL}/settings.json`, settingsData);
            console.log(`[Storage] Firebase Settings updated.`);
        } catch (err) {
            console.error(`[Storage] Firebase Settings save failed:`, err.message);
            this.saveLocal();
        }
    },

    saveLocal() {
        try {
            fs.writeFileSync(path.join(__dirname, DB_PATH), JSON.stringify(dbCache, null, 2));
        } catch (e) {
            console.error('[Storage] Local save failed:', e.message);
        }
    },

    getDB() {
        if (!dbCache.users) dbCache.users = {};
        if (!dbCache.redeem_codes) dbCache.redeem_codes = {};
        return dbCache;
    }
};

module.exports = storage;
