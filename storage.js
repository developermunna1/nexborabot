const axios = require('axios');
const fs = require('fs');
const path = require('path');

// --- CONFIGURATION ---
const GH_TOKEN = process.env.GH_TOKEN; // Set this in Render Env Vars
const REPO_OWNER = 'munna1234mm';
const REPO_NAME = 'newhiitttergoodworl';
const DB_PATH = 'database.json';

let dbCache = null;
let dbSha = null;

/**
 * GitHub Storage Provider
 * Syncs database.json with the repository to prevent data loss on Render.
 */
const storage = {
    async init() {
        if (!GH_TOKEN) {
            console.warn('⚠️ GH_TOKEN is not set. Data will NOT persist on Render restarts!');
            return this.loadLocal();
        }
        return this.loadGitHub();
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

    async loadGitHub() {
        try {
            console.log('[Storage] Fetching DB from GitHub...');
            const response = await axios.get(`https://api.github.com/repos/${REPO_OWNER}/${REPO_NAME}/contents/${DB_PATH}`, {
                headers: { Authorization: `token ${GH_TOKEN}` }
            });
            
            dbSha = response.data.sha;
            const content = Buffer.from(response.data.content, 'base64').toString('utf8');
            dbCache = JSON.parse(content);
            console.log('[Storage] DB loaded successfully from GitHub.');
            return dbCache;
        } catch (err) {
            if (err.response && err.response.status === 404) {
                console.log('[Storage] DB file not found on GitHub. Initializing empty DB.');
                dbCache = { users: {}, redeem_codes: {} };
                return dbCache;
            }
            console.error('[Storage] GitHub load failed:', err.message);
            return this.loadLocal();
        }
    },

    async save(data) {
        dbCache = data || dbCache;
        if (!GH_TOKEN) {
            // Fallback to local write
            fs.writeFileSync(path.join(__dirname, DB_PATH), JSON.stringify(dbCache, null, 2));
            return;
        }

        try {
            // We need to fetch the latest SHA before saving to avoid conflicts
            const getRes = await axios.get(`https://api.github.com/repos/${REPO_OWNER}/${REPO_NAME}/contents/${DB_PATH}`, {
                headers: { Authorization: `token ${GH_TOKEN}` }
            }).catch(() => null);

            if (getRes) dbSha = getRes.data.sha;

            const content = Buffer.from(JSON.stringify(dbCache, null, 2)).toString('base64');
            const putRes = await axios.put(`https://api.github.com/repos/${REPO_OWNER}/${REPO_NAME}/contents/${DB_PATH}`, {
                message: `Sync Database: ${new Date().toISOString()}`,
                content: content,
                sha: dbSha
            }, {
                headers: { Authorization: `token ${GH_TOKEN}` }
            });
            
            dbSha = putRes.data.content.sha;
            console.log('[Storage] DB synced to GitHub.');
        } catch (err) {
            console.error('[Storage] GitHub save failed:', err.response ? err.response.data : err.message);
        }
    },

    getDB() {
        return dbCache || { users: {}, redeem_codes: {} };
    }
};

module.exports = storage;
