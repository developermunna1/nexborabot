const axios = require('axios');

async function testHitter() {
    const API_URL = 'https://hitter1month.replit.app';
    const API_KEY = 'hitchk_c321efa228654c3433cf37b8d6aa38b42e83ded5325d504f';
    const gate = 'checkout';
    
    console.log('--- HITTER API DIAGNOSTIC ---');
    console.log('Testing URL:', `${API_URL}/hit/${gate}`);
    console.log('Testing Key:', API_KEY);
    
    try {
        const response = await axios.post(`${API_URL}/hit/${gate}`, {
            url: 'https://billing.gamma.app/c/pay/cs_live_b11zfcC7uN2Uq',
            card: '4242424242424242|12|26|123'
        }, {
            headers: { 'X-API-Key': API_KEY, 'Content-Type': 'application/json' },
            timeout: 10000,
            validateStatus: () => true
        });

        console.log('\nResponse Status:', response.status);
        console.log('Response Content-Type:', response.headers['content-type']);
        console.log('Response Data Name:', typeof response.data);
        console.log('Response Data:', response.data);
    } catch (err) {
        console.log('\n❌ [FAILED]');
        console.log('Error:', err.message);
    }
}

testHitter();
