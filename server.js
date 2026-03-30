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

  // We MUST use the full URL as requested by the user (do not split on #)
  url = url.trim();

  const apiUrl = 'https://nonburnable-undolorously-sheilah.ngrok-free.dev/api/extract';

  try {
    console.log(`[Link Analysis] Fetching: ${url}`);
    
    const response = await axios.post(apiUrl, {
        url: url
    }, {
        headers: { 'Content-Type': 'application/json' },
        timeout: 20000 // Extended timeout for scraping
    });

    const data = response.data;
    console.log('[Link Analysis] Response:', JSON.stringify(data));

    // Mapping exact keys from user's API response: 'name' and 'price'
    let siteName = data.name || data.merchant || 'Stripe Checkout';
    let amountStr = data.price || data.amount || 'Unknown';

    // Clean up if there are escaped slashes/characters (e.g., Back\na2e.ai -> Backna2e.ai)
    if (siteName && typeof siteName === 'string') {
        siteName = siteName.replace(/\\n/g, '').replace(/\\/g, '').trim();
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
