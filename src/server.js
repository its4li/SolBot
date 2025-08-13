import express from 'express';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import SolanaTradeBot from './index.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const app = express();
const port = process.env.PORT || 3000;

// Middleware
app.use(express.json());
app.use(express.static(join(__dirname, '../public')));

// Instance of trading bot
let bot = null;

// Routes
app.get('/', (req, res) => {
  res.sendFile(join(__dirname, '../public/index.html'));
});

app.post('/api/connect-wallet', async (req, res) => {
  try {
    const { privateKey } = req.body;
    
    if (!privateKey) {
      return res.status(400).json({ error: 'Private key is required' });
    }
    
    bot = new SolanaTradeBot();
    const connected = await bot.connectWallet(privateKey);
    
    if (connected) {
      bot.startMonitoring(30);
      res.json({ success: true, message: 'Wallet connected successfully' });
    } else {
      res.status(400).json({ error: 'Failed to connect wallet' });
    }
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.post('/api/buy-token', async (req, res) => {
  try {
    if (!bot) {
      return res.status(400).json({ error: 'Wallet not connected' });
    }
    
    const { tokenMint, solAmount, takeProfit, stopLoss, slippage } = req.body;
    
    const result = await bot.buyToken(tokenMint, solAmount, {
      takeProfit,
      stopLoss,
      slippage
    });
    
    res.json(result);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.post('/api/sell-token', async (req, res) => {
  try {
    if (!bot) {
      return res.status(400).json({ error: 'Wallet not connected' });
    }
    
    const { tokenMint, percentage } = req.body;
    
    const result = await bot.sellToken(tokenMint, percentage);
    
    res.json(result);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.get('/api/positions', (req, res) => {
  try {
    if (!bot) {
      return res.status(400).json({ error: 'Wallet not connected' });
    }
    
    const positions = Array.from(bot.activePositions.entries()).map(([mint, position]) => ({
      tokenMint: mint,
      ...position
    }));
    
    res.json({ positions });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.listen(port, () => {
  console.log(`🚀 Server running on port ${port}`);
});

// For Vercel
export default app;
