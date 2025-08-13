import express from 'express';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import { Connection, PublicKey } from '@solana/web3.js';
import fetch from 'node-fetch';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const app = express();
const port = process.env.PORT || 3000;

// اتصال به شبکه سولانا
const connection = new Connection(
    process.env.RPC_URL || 'https://api.mainnet-beta.solana.com',
    'confirmed'
);

// ذخیره موقعیت‌های کاربران
const userPositions = new Map();

// Jupiter API URLs
const jupiterQuoteAPI = 'https://quote-api.jup.ag/v6/quote';
const jupiterSwapAPI = 'https://quote-api.jup.ag/v6/swap';

// Middleware
app.use(express.json());
app.use(express.static(join(__dirname, '../public')));

// Routes
app.get('/', (req, res) => {
  res.sendFile(join(__dirname, '../public/index.html'));
});

app.post('/api/connect-wallet', async (req, res) => {
  try {
    const { publicKey } = req.body;
    
    if (!publicKey) {
      return res.status(400).json({ error: 'Public key is required' });
    }
    
    // بررسی معتبر بودن public key
    try {
      new PublicKey(publicKey);
    } catch {
      return res.status(400).json({ error: 'Invalid public key' });
    }
    
    // اگر کاربر موقعیت‌هایی نداشته باشد، یک Map جدید ایجاد کن
    if (!userPositions.has(publicKey)) {
      userPositions.set(publicKey, new Map());
    }
    
    res.json({ success: true, message: 'Wallet connected successfully' });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.post('/api/prepare-buy', async (req, res) => {
  try {
    const { tokenMint, solAmount, takeProfit, stopLoss, slippage, userPublicKey } = req.body;
    
    if (!userPublicKey) {
      return res.status(400).json({ error: 'Wallet not connected' });
    }
    
    // دریافت quote از Jupiter
    const inputAmount = Math.floor(solAmount * 1e9); // تبدیل به lamports
    
    const quoteResponse = await getQuote(
      'So11111111111111111111111111111111111111112', // SOL mint
      tokenMint,
      inputAmount,
      slippage || 500 // 5% default slippage
    );

    if (!quoteResponse) {
      return res.status(400).json({ error: 'Could not get quote' });
    }

    // ایجاد تراکنش
    const swapTransaction = await createSwapTransaction(quoteResponse, userPublicKey);
    
    if (swapTransaction) {
      // ذخیره اطلاعات موقعیت (قبل از تأیید)
      const position = {
        tokenMint,
        buyPrice: parseFloat(quoteResponse.outAmount) / inputAmount,
        amount: parseFloat(quoteResponse.outAmount),
        solInvested: solAmount,
        timestamp: Date.now(),
        stopLoss,
        takeProfit,
        status: 'pending'
      };
      
      const userPos = userPositions.get(userPublicKey) || new Map();
      userPos.set(tokenMint, position);
      userPositions.set(userPublicKey, userPos);
      
      res.json({ success: true, transaction: swapTransaction });
    } else {
      res.status(400).json({ error: 'Could not create transaction' });
    }
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.post('/api/prepare-sell', async (req, res) => {
  try {
    const { tokenMint, percentage, userPublicKey } = req.body;
    
    if (!userPublicKey) {
      return res.status(400).json({ error: 'Wallet not connected' });
    }
    
    // دریافت موجودی توکن کاربر
    const tokenBalance = await getTokenBalance(userPublicKey, tokenMint);
    if (!tokenBalance || tokenBalance === 0) {
      return res.status(400).json({ error: 'No token balance found' });
    }

    const sellAmount = Math.floor((tokenBalance * percentage) / 100);
    
    // دریافت quote برای فروش
    const quoteResponse = await getQuote(
      tokenMint,
      'So11111111111111111111111111111111111111112', // SOL mint
      sellAmount,
      500 // 5% slippage
    );

    if (!quoteResponse) {
      return res.status(400).json({ error: 'Could not get quote for sell' });
    }

    // ایجاد تراکنش فروش
    const swapTransaction = await createSwapTransaction(quoteResponse, userPublicKey);
    
    if (swapTransaction) {
      res.json({ success: true, transaction: swapTransaction });
    } else {
      res.status(400).json({ error: 'Could not create sell transaction' });
    }
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.get('/api/positions', (req, res) => {
  try {
    const { publicKey } = req.query;
    
    if (!publicKey) {
      return res.status(400).json({ error: 'Public key required' });
    }
    
    const userPos = userPositions.get(publicKey) || new Map();
    const positions = Array.from(userPos.entries()).map(([mint, position]) => ({
      tokenMint: mint,
      ...position
    }));
    
    res.json({ positions });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Helper functions
async function getQuote(inputMint, outputMint, amount, slippageBps) {
  try {
    const url = `${jupiterQuoteAPI}?inputMint=${inputMint}&outputMint=${outputMint}&amount=${amount}&slippageBps=${slippageBps}`;
    
    const response = await fetch(url);
    if (!response.ok) {
      throw new Error(`HTTP error! status: ${response.status}`);
    }
    
    return await response.json();
  } catch (error) {
    console.error('Error getting quote:', error.message);
    return null;
  }
}

async function createSwapTransaction(quoteResponse, userPublicKey) {
  try {
    const response = await fetch(jupiterSwapAPI, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        quoteResponse,
        userPublicKey: userPublicKey,
        wrapAndUnwrapSol: true
      })
    });

    if (!response.ok) {
      throw new Error(`HTTP error! status: ${response.status}`);
    }

    const { swapTransaction } = await response.json();
    return swapTransaction;
  } catch (error) {
    console.error('Error creating transaction:', error.message);
    return null;
  }
}

async function getTokenBalance(userPublicKey, tokenMint) {
  try {
    const tokenAccounts = await connection.getParsedTokenAccountsByOwner(
      new PublicKey(userPublicKey),
      { mint: new PublicKey(tokenMint) }
    );

    if (tokenAccounts.value.length === 0) {
      return 0;
    }

    return parseInt(tokenAccounts.value[0].account.data.parsed.info.tokenAmount.amount);
  } catch (error) {
    console.error('Error getting token balance:', error.message);
    return 0;
  }
}

app.listen(port, () => {
  console.log(`🚀 Server running on port ${port}`);
});

export default app;
