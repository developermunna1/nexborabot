const express = require('express');
const path = require('path');
const https = require('https');
const app = express();
const PORT = process.env.PORT || 3000;

const axios = require('axios');

// Serve static files from the current directory
app.use(express.static(__dirname));
app.use(express.json());

// Link Analysis Endpoint
app.post('/analyze-link', async (req, res) => {
  const { url } = req.body;
  if (!url || !url.includes('stripe.com')) {
    return res.status(400).json({ error: 'Invalid Stripe URL' });
  }

  try {
    const response = await axios.get(url, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/114.0.0.0 Safari/537.36'
      },
      timeout: 10000
    });

    const html = response.data.toString();
    
    // Extract Business Name
    let siteName = 'Stripe Checkout';
    const sitePatterns = [
      /"account_name":"([^"]+)"/,
      /"merchantName":"([^"]+)"/,
      /"business_name":"([^"]+)"/,
      /<title>([^<]+)<\/title>/
    ];

    for (const pattern of sitePatterns) {
      const match = html.match(pattern);
      if (match && match[1]) {
        siteName = match[1].replace(' - Stripe Checkout', '').replace('Stripe Checkout - ', '').trim();
        break;
      }
    }

    // Extract Amount and Currency
    let amount = 'Unknown';
    const amountMatch = html.match(/"total":(\d+)/) || html.match(/"amount":(\d+)/) || html.match(/"amount_total":(\d+)/) || html.match(/"unit_amount":(\d+)/);
    const currencyMatch = html.match(/"currency":"([^"]+)"/) || html.match(/"currency_code":"([^"]+)"/);
    
    if (amountMatch && currencyMatch) {
      const value = (parseInt(amountMatch[1]) / 100).toFixed(2);
      amount = `${value} ${currencyMatch[1].toUpperCase()}`;
    } else if (amountMatch) {
      // Fallback if currency is missing
      const value = (parseInt(amountMatch[1]) / 100).toFixed(2);
      amount = `${value} USD`; // Common default
    }

    res.json({ site: siteName, amount: amount });
  } catch (err) {
    console.error('Analysis failed:', err.message);
    res.status(500).json({ error: 'Failed to analyze link' });
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
