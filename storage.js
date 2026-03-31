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
            console.log('[Storage] Fetching DB from Firebase...');
            const response = await axios.get(`${FIREBASE_URL}/db.json`);
            
            if (response.data && typeof response.data === 'object') {
                dbCache = response.data;
                if (!dbCache.users) dbCache.users = {};
                if (!dbCache.redeem_codes) dbCache.redeem_codes = {};
                console.log('[Storage] DB loaded from Firebase.');
            } else {
                console.log('[Storage] Firebase DB empty. Initializing...');
                await this.loadLocal();
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
        if (!dbCache.users) dbCache.users = {};
        if (!dbCache.redeem_codes) dbCache.redeem_codes = {};

        if (!FIREBASE_URL) {
            fs.writeFileSync(path.join(__dirname, DB_PATH), JSON.stringify(dbCache, null, 2));
            return;
        }

        try {
            await axios.put(`${FIREBASE_URL}/db.json`, dbCache);
        } catch (err) {
            console.error('[Storage] Firebase save failed:', err.message);
            // Fallback: update local file just in case
            try {
                fs.writeFileSync(path.join(__dirname, DB_PATH), JSON.stringify(dbCache, null, 2));
            } catch (e) {}
        }
    },

    getDB() {
        if (!dbCache.users) dbCache.users = {};
        if (!dbCache.redeem_codes) dbCache.redeem_codes = {};
        return dbCache;
    }
};

module.exports = storage;
