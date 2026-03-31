const axios = require('axios');
const fs = require('fs');
const path = require('path');
const config = require('./config');

// --- CONFIGURATION ---
// We use the REST API because it's lightweight and doesn't require new dependencies.
const FIREBASE_URL = config.FIREBASE_URL.endsWith('/') ? config.FIREBASE_URL.slice(0, -1) : config.FIREBASE_URL;
const DB_PATH = 'database.json';

let dbCache = null;

/**
 * Firebase Realtime Storage Provider (via REST API)
 * Prevents data loss on Render and provides real-time persistence.
 */
const storage = {
    async init() {
        if (!FIREBASE_URL) {
            console.warn('⚠️ FIREBASE_URL is not set. Data will NOT persist on Render restarts!');
            return this.loadLocal();
        }
        return this.loadFirebase();
    },

    async loadLocal() {
        try {
            const filePath = path.join(__dirname, DB_PATH);
            if (fs.existsSync(filePath)) {
                dbCache = JSON.parse(fs.readFileSync(filePath, 'utf8'));
            } else {
                dbCache = { users: {}, redeem_codes: {} };
            }
            return dbCache;
        } catch (err) {
            console.error('[Storage] Local load failed:', err.message);
            return { users: {}, redeem_codes: {} };
        }
    },

    async loadFirebase() {
        try {
            console.log('[Storage] Fetching DB from Firebase Realtime Database...');
            const response = await axios.get(`${FIREBASE_URL}/db.json`);
            
            if (response.data) {
                dbCache = response.data;
                console.log('[Storage] DB loaded successfully from Firebase.');
            } else {
                console.log('[Storage] Firebase DB is empty. Initializing...');
                dbCache = await this.loadLocal(); // Try to seed from local if firebase is empty
                await this.save(dbCache);
            }
            return dbCache;
        } catch (err) {
            console.error('[Storage] Firebase load failed:', err.message);
            return this.loadLocal();
        }
    },

    async save(data) {
        dbCache = data || dbCache;
        
        if (!FIREBASE_URL) {
            // Fallback to local write
            fs.writeFileSync(path.join(__dirname, DB_PATH), JSON.stringify(dbCache, null, 2));
            return;
        }

        try {
            // Simple PUT replaces the entire object at /db.json
            await axios.put(`${FIREBASE_URL}/db.json`, dbCache);
            // console.log('[Storage] DB synced to Firebase.');
        } catch (err) {
            console.error('[Storage] Firebase save failed:', err.response ? err.response.data : err.message);
        }
    },

    getDB() {
        return dbCache || { users: {}, redeem_codes: {} };
    }
};

module.exports = storage;
