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
  let { url } = req.body;
  if (!url || !url.includes('stripe.com')) {
    return res.status(400).json({ error: 'Invalid Stripe URL' });
  }

  // Strip fragment and trailing whitespace
  url = url.split('#')[0].trim();

  try {
    const response = await axios.get(url, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/116.0.0.0 Safari/537.36',
        'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,image/apng,*/*;q=0.8',
        'Accept-Language': 'en-US,en;q=0.9'
      },
      timeout: 10000
    });

    const html = response.data.toString();
    
    // Deep Scanning for Site Name
    let siteName = 'Stripe Checkout';
    const nameRegexes = [
      /\\"account_name\\":\\"([^\\"]+)\\"/,
      /\\"merchantName\\":\\"([^\\"]+)\\"/,
      /\\"business_name\\":\\"([^\\"]+)\\"/,
      /"account_name":"([^"]+)"/,
      /"merchant_name":"([^"]+)"/,
      /"business_name":"([^"]+)"/,
      /<title>([^<]+)<\/title>/
    ];

    for (const reg of nameRegexes) {
      const match = html.match(reg);
      if (match && match[1]) {
        siteName = match[1].replace(/\\u0026/g, '&').replace(' - Stripe Checkout', '').replace('Stripe Checkout - ', '').trim();
        break;
      }
    }

    // Deep Scanning for Amount and Currency
    let amountStr = 'Unknown';
    const amountRegexes = [
      /\\"total\\":(\d+)/,
      /\\"amount_total\\":(\d+)/,
      /\\"unit_amount\\":(\d+)/,
      /\\"amount\\":(\d+)/,
      /"total":(\d+)/,
      /"amount_total":(\d+)/,
      /"amount":(\d+)/
    ];

    const currencyRegexes = [
      /\\"currency\\":\\"([^\\"]+)\\"/,
      /\\"currency_code\\":\\"([^\\"]+)\\"/,
      /"currency":"([^"]+)"/
    ];

    let foundAmount = null;
    for (const reg of amountRegexes) {
      const match = html.match(reg);
      if (match && match[1]) {
        foundAmount = match[1];
        break;
      }
    }

    let foundCurrency = 'USD';
    for (const reg of currencyRegexes) {
      const match = html.match(reg);
      if (match && match[1]) {
        foundCurrency = match[1].toUpperCase();
        break;
      }
    }

    if (foundAmount) {
      const value = (parseInt(foundAmount) / 100).toFixed(2);
      amountStr = `${value} ${foundCurrency}`;
    }

    res.json({ site: siteName, amount: amountStr });
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
