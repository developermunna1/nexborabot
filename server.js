const express = require('express');
const path = require('path');
const https = require('https');
const app = express();
const PORT = process.env.PORT || 3000;

const axios = require('axios');

// Serve static files from the current directory
app.use(express.static(__dirname));
app.use(express.json());

// Link Analysis Endpoint (Updated to use User's Local Extraction API)
app.post('/analyze-link', async (req, res) => {
  let { url } = req.body;
  if (!url || !url.includes('stripe.com')) {
    return res.status(400).json({ error: 'Invalid Stripe URL' });
  }

  // Clean-up URL
  url = url.split('#')[0].trim();

  const apiUrl = 'https://nonburnable-undolorously-sheilah.ngrok-free.dev/api/extract';

  try {
    console.log(`[Link Analysis] Fetching: ${url}`);
    
    const response = await axios.post(apiUrl, {
        url: url
    }, {
        headers: { 'Content-Type': 'application/json' },
        timeout: 15000 // Extended timeout for scraping
    });

    const data = response.data;
    console.log('[Link Analysis] Response:', data);

    // Dynamic extraction based on user's API response structure
    // Handling common keys like 'name', 'dollar', 'amount', 'merchant'
    const siteName = data.name || data.merchant || data.business_name || data.site || 'Stripe Checkout';
    let amountStr = data.dollar || data.amount || data.price || 'Unknown';

    // Format amount if it's just a number
    if (typeof amountStr === 'number' || (!isNaN(amountStr) && !amountStr.toString().includes(' '))) {
        amountStr = `${amountStr} USD`;
    }

    res.json({ 
        site: siteName, 
        amount: amountStr 
    });

  } catch (err) {
    console.error('Analysis failed:', err.message);
    
    // Fallback message to prevent app from breaking
    res.status(500).json({ 
        error: 'Extraction service unavailable',
        details: err.message
    });
  }
});


// Ping endpoint
app.get('/ping', (req, res) => {
  res.send('PONG');
});

// Send index.html for all routes to handle TWA correctly
app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, 'index.html'));
});

// Self-ping to prevent Render sleeping
function startKeepAlive() {
  const url = process.env.RENDER_EXTERNAL_URL;
  if (url) {
    console.log(`Keep-alive started for: ${url}`);
    setInterval(() => {
      https.get(`${url}/ping`, (res) => {
        console.log(`Self-ping status: ${res.statusCode}`);
      }).on('error', (err) => {
        console.error(`Self-ping failed: ${err.message}`);
      });
    }, 14 * 60 * 1000); // 14 minutes (Render sleeps after 15)
  }
}

const bot = require('./bot');

app.listen(PORT, () => {
  console.log(`Server is running on port ${PORT}`);
  console.log(`Open http://localhost:${PORT} to view your app`);
  startKeepAlive();
  
  // Launch Bot
  bot.launch()
    .then(() => {
      console.log('✅ Telegram Bot is active!');
    })
    .catch(err => {
      console.error('❌ Telegram Bot Error:', err.message);
      console.log('⚠️ Server will continue running without the bot.');
    });

  // Enable graceful stop
  process.once('SIGINT', () => bot.stop('SIGINT'));
  process.once('SIGTERM', () => bot.stop('SIGTERM'));
});
