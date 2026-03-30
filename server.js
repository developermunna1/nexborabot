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

  url = url.split('#')[0].trim();

  // Stealth headers to mimic a real mobile browser
  const getHeaders = () => ({
    'User-Agent': 'Mozilla/5.0 (iPhone; CPU iPhone OS 16_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/16.5 Mobile/15E148 Safari/604.1',
    'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
    'Accept-Language': 'en-US,en;q=0.9',
    'Accept-Encoding': 'gzip, deflate, br',
    'Connection': 'keep-alive',
    'Upgrade-Insecure-Requests': '1',
    'Sec-Fetch-Dest': 'document',
    'Sec-Fetch-Mode': 'navigate',
    'Sec-Fetch-Site': 'none',
    'Sec-Fetch-User': '?1'
  });

  const performScrape = async (targetUrl) => {
    const response = await axios.get(targetUrl, {
      headers: getHeaders(),
      timeout: 8000,
      validateStatus: false
    });

    if (response.status !== 200) throw new Error(`Status ${response.status}`);
    const html = response.data.toString();
    
    let siteName = null;
    let amountStr = null;

    // Site Name Patterns
    const nameRegexes = [
      /\\"account_name\\":\\"([^\\"]+)\\"/,
      /\\"merchantName\\":\\"([^\\"]+)\\"/,
      /\\"business_name\\":\\"([^\\"]+)\\"/,
      /"account_name":"([^"]+)"/,
      /"merchant_name":"([^"]+)"/,
      /<title>([^<]+)<\/title>/
    ];

    for (const reg of nameRegexes) {
      const match = html.match(reg);
      if (match && match[1]) {
        siteName = match[1].replace(/\\u0026/g, '&').replace(' - Stripe Checkout', '').trim();
        break;
      }
    }

    // Amount Patterns
    let foundAmount = null;
    let foundCurrency = 'USD';
    const priceRegexes = [
      /\\"total\\":(\d+)/, /\\"amount_total\\":(\d+)/, /\\"unit_amount\\":(\d+)/,
      /"total":(\d+)/, /"amount_total":(\d+)/, /"amount":(\d+)/
    ];

    for (const reg of priceRegexes) {
      const match = html.match(reg);
      if (match && match[1]) { foundAmount = match[1]; break; }
    }

    const currRegexes = [/\\"currency\\":\\"([^\\"]+)\\"/, /"currency":"([^"]+)"/];
    for (const reg of currRegexes) {
      const match = html.match(reg);
      if (match && match[1]) { foundCurrency = match[1].toUpperCase(); break; }
    }

    if (foundAmount) {
      amountStr = `${(parseInt(foundAmount) / 100).toFixed(2)} ${foundCurrency}`;
    } else {
      const broadMatch = html.match(/\$([0-9]+\.[0-9]{2})/);
      if (broadMatch) amountStr = `${broadMatch[1]} USD`;
    }

    return { site: siteName || 'Stripe Checkout', amount: amountStr || 'Unknown' };
  };

  try {
    // Try primary scrape
    let result = await performScrape(url);
    
    // If we only got partial data, try one more time after a tiny delay
    if (result.amount === 'Unknown' || result.site === 'Stripe Checkout') {
      await new Promise(r => setTimeout(r, 1000));
      const retryResult = await performScrape(url);
      result = {
        site: retryResult.site !== 'Stripe Checkout' ? retryResult.site : result.site,
        amount: retryResult.amount !== 'Unknown' ? retryResult.amount : result.amount
      };
    }

    res.json(result);
  } catch (err) {
    console.error('Analysis failed:', err.message);
    res.status(500).json({ error: 'Blocked by Security' });
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
