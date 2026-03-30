const axios = require('axios');

async function test() {
    const url = 'https://nonburnable-undolorously-sheilah.ngrok-free.dev/api/extract';
    // Use a real URL from your previous session for testing
    const payload = { url: 'https://billing.gamma.app/c/pay/cs_live_b11zfcC7uN2Uq' };
    
    console.log('--- API DIAGNOSTIC TEST ---');
    console.log('Testing URL:', url);
    
    try {
        const response = await axios.post(url, payload, { 
            headers: { 'Content-Type': 'application/json' },
            timeout: 15000 
        });
        console.log('\n✅ [SUCCESS]');
        console.log('Response Status:', response.status);
        console.log('Response Data:', JSON.stringify(response.data, null, 2));
    } catch (err) {
        console.log('\n❌ [FAILED]');
        console.log('Error Message:', err.message);
        if (err.response) {
            console.log('Server responded with:', err.response.status, err.response.data);
        } else if (err.code === 'ECONNABORTED') {
            console.log('Result: Timeout (API took too long to respond)');
        } else {
            console.log('Result: Network Error (Is your ngrok tunnel running?)');
        }
    }
}

test();
