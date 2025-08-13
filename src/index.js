import { Connection, Keypair, VersionedTransaction, PublicKey } from '@solana/web3.js';
import { Wallet } from '@project-serum/anchor';
import bs58 from 'bs58';
import fetch from 'cross-fetch';
import WebSocket from 'ws';
import cron from 'node-cron';
import dotenv from 'dotenv';

dotenv.config();

class SolanaTradeBot {
    constructor() {
        // اتصال به شبکه سولانا
        this.connection = new Connection(
            process.env.RPC_URL || 'https://api.mainnet-beta.solana.com',
            'confirmed'
        );
        
        // والت کاربر
        this.wallet = null;
        
        // لیست موقعیت‌های فعال
        this.activePositions = new Map();
        
        // تنظیمات پیش‌فرض
        this.defaultSlippage = 100; // 1%
        this.maxRetries = 3;
        this.retryDelay = 1000;
        
        // Jupiter API URLs
        this.jupiterQuoteAPI = 'https://quote-api.jup.ag/v6/quote';
        this.jupiterSwapAPI = 'https://quote-api.jup.ag/v6/swap';
        
        console.log('🤖 ربات معامله‌گر سولانا راه‌اندازی شد');
    }

    // اتصال والت
    async connectWallet(privateKey) {
        try {
            const keypair = Keypair.fromSecretKey(bs58.decode(privateKey));
            this.wallet = new Wallet(keypair);
            
            const balance = await this.connection.getBalance(this.wallet.publicKey);
            console.log(`💼 والت متصل شد: ${this.wallet.publicKey.toString()}`);
            console.log(`💰 موجودی SOL: ${balance / 1e9}`);
            
            return true;
        } catch (error) {
            console.error('❌ خطا در اتصال والت:', error.message);
            return false;
        }
    }

    // دریافت قیمت توکن
    async getTokenPrice(tokenMint, amount = 1000000) {
        try {
            const response = await fetch(
                `${this.jupiterQuoteAPI}?inputMint=${tokenMint}&outputMint=EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v&amount=${amount}&slippageBps=${this.defaultSlippage}`
            );
            
            if (!response.ok) {
                throw new Error(`HTTP error! status: ${response.status}`);
            }
            
            const quote = await response.json();
            return {
                inputAmount: amount,
                outputAmount: parseInt(quote.outAmount),
                price: parseInt(quote.outAmount) / amount,
                priceImpact: parseFloat(quote.priceImpactPct || 0)
            };
        } catch (error) {
            console.error('❌ خطا در دریافت قیمت:', error.message);
            return null;
        }
    }

    // خرید سریع (Sniper)
    async buyToken(tokenMint, solAmount, options = {}) {
        if (!this.wallet) {
            throw new Error('والت متصل نیست');
        }

        try {
            console.log(`🎯 شروع خرید سریع توکن: ${tokenMint}`);
            console.log(`💰 مقدار SOL برای خرید: ${solAmount}`);

            const inputAmount = Math.floor(solAmount * 1e9); // تبدیل به lamports
            
            // دریافت quote
            const quoteResponse = await this.getQuote(
                'So11111111111111111111111111111111111111112', // SOL mint
                tokenMint,
                inputAmount,
                options.slippage || this.defaultSlippage
            );

            if (!quoteResponse) {
                throw new Error('نتوانست quote دریافت کند');
            }

            // ایجاد تراکنش swap
            const swapTransaction = await this.createSwapTransaction(quoteResponse);
            
            // ارسال تراکنش
            const signature = await this.sendTransaction(swapTransaction);
            
            if (signature) {
                // ثبت موقعیت جدید
                const position = {
                    tokenMint,
                    buyPrice: parseFloat(quoteResponse.outAmount) / inputAmount,
                    amount: parseFloat(quoteResponse.outAmount),
                    solInvested: solAmount,
                    buySignature: signature,
                    timestamp: Date.now(),
                    stopLoss: options.stopLoss,
                    takeProfit: options.takeProfit
                };
                
                this.activePositions.set(tokenMint, position);
                
                console.log(`✅ خرید موفق! امضا: ${signature}`);
                console.log(`📊 قیمت خرید: ${position.buyPrice}`);
                
                return { success: true, signature, position };
            }
            
        } catch (error) {
            console.error('❌ خطا در خرید:', error.message);
            return { success: false, error: error.message };
        }
    }

    // فروش توکن
    async sellToken(tokenMint, percentage = 100, options = {}) {
        if (!this.wallet) {
            throw new Error('والت متصل نیست');
        }

        try {
            console.log(`💸 شروع فروش توکن: ${tokenMint}`);
            
            // دریافت موجودی توکن
            const tokenBalance = await this.getTokenBalance(tokenMint);
            if (!tokenBalance || tokenBalance === 0) {
                throw new Error('موجودی توکن صفر است');
            }

            const sellAmount = Math.floor((tokenBalance * percentage) / 100);
            console.log(`📊 مقدار فروش: ${sellAmount} (${percentage}%)`);

            // دریافت quote برای فروش
            const quoteResponse = await this.getQuote(
                tokenMint,
                'So11111111111111111111111111111111111111112', // SOL mint
                sellAmount,
                options.slippage || this.defaultSlippage
            );

            if (!quoteResponse) {
                throw new Error('نتوانست quote دریافت کند');
            }

            // ایجاد تراکنش swap
            const swapTransaction = await this.createSwapTransaction(quoteResponse);
            
            // ارسال تراکنش
            const signature = await this.sendTransaction(swapTransaction);
            
            if (signature) {
                const position = this.activePositions.get(tokenMint);
                if (position) {
                    const profit = (parseFloat(quoteResponse.outAmount) / 1e9) - position.solInvested;
                    const profitPercentage = ((profit / position.solInvested) * 100).toFixed(2);
                    
                    console.log(`✅ فروش موفق! امضا: ${signature}`);
                    console.log(`💰 سود/زیان: ${profit.toFixed(4)} SOL (${profitPercentage}%)`);
                    
                    if (percentage === 100) {
                        this.activePositions.delete(tokenMint);
                    }
                }
                
                return { success: true, signature };
            }
            
        } catch (error) {
            console.error('❌ خطا در فروش:', error.message);
            return { success: false, error: error.message };
        }
    }

    // دریافت quote از Jupiter
    async getQuote(inputMint, outputMint, amount, slippageBps) {
        try {
            const url = `${this.jupiterQuoteAPI}?inputMint=${inputMint}&outputMint=${outputMint}&amount=${amount}&slippageBps=${slippageBps}&onlyDirectRoutes=false&asLegacyTransaction=false`;
            
            const response = await fetch(url);
            if (!response.ok) {
                throw new Error(`HTTP error! status: ${response.status}`);
            }
            
            return await response.json();
        } catch (error) {
            console.error('❌ خطا در دریافت quote:', error.message);
            return null;
        }
    }

    // ایجاد تراکنش swap
    async createSwapTransaction(quoteResponse) {
        try {
            const response = await fetch(this.jupiterSwapAPI, {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json'
                },
                body: JSON.stringify({
                    quoteResponse,
                    userPublicKey: this.wallet.publicKey.toString(),
                    wrapAndUnwrapSol: true,
                    dynamicComputeUnitLimit: true,
                    prioritizationFeeLamports: {
                        priorityLevelWithMaxLamports: {
                            maxLamports: 10000000,
                            priorityLevel: "veryHigh"
                        }
                    }
                })
            });

            if (!response.ok) {
                throw new Error(`HTTP error! status: ${response.status}`);
            }

            const { swapTransaction } = await response.json();
            return swapTransaction;
        } catch (error) {
            console.error('❌ خطا در ایجاد تراکنش:', error.message);
            throw error;
        }
    }

    // ارسال تراکنش
    async sendTransaction(swapTransaction) {
        try {
            // تبدیل از base64 به transaction
            const swapTransactionBuf = Buffer.from(swapTransaction, 'base64');
            const transaction = VersionedTransaction.deserialize(swapTransactionBuf);
            
            // امضای تراکنش
            transaction.sign([this.wallet.payer]);
            
            // دریافت blockhash جدید
            const latestBlockHash = await this.connection.getLatestBlockhash();
            
            // ارسال تراکنش
            const rawTransaction = transaction.serialize();
            const signature = await this.connection.sendRawTransaction(rawTransaction, {
                skipPreflight: true,
                maxRetries: this.maxRetries
            });

            // تأیید تراکنش
            await this.connection.confirmTransaction({
                blockhash: latestBlockHash.blockhash,
                lastValidBlockHeight: latestBlockHash.lastValidBlockHeight,
                signature: signature
            });

            return signature;
        } catch (error) {
            console.error('❌ خطا در ارسال تراکنش:', error.message);
            throw error;
        }
    }

    // دریافت موجودی توکن
    async getTokenBalance(tokenMint) {
        try {
            const tokenAccounts = await this.connection.getParsedTokenAccountsByOwner(
                this.wallet.publicKey,
                { mint: new PublicKey(tokenMint) }
            );

            if (tokenAccounts.value.length === 0) {
                return 0;
            }

            return parseInt(tokenAccounts.value[0].account.data.parsed.info.tokenAmount.amount);
        } catch (error) {
            console.error('❌ خطا در دریافت موجودی:', error.message);
            return 0;
        }
    }

    // مانیتورینگ قیمت‌ها برای stop loss و take profit
    async monitorPositions() {
        if (this.activePositions.size === 0) {
            return;
        }

        console.log(`📊 بررسی ${this.activePositions.size} موقعیت فعال...`);

        for (const [tokenMint, position] of this.activePositions.entries()) {
            try {
                const currentPrice = await this.getTokenPrice(tokenMint);
                if (!currentPrice) continue;

                const currentValue = currentPrice.price;
                const buyPrice = position.buyPrice;
                const changePercent = ((currentValue - buyPrice) / buyPrice) * 100;

                console.log(`📈 ${tokenMint.slice(0, 8)}... | قیمت: ${currentValue.toFixed(8)} | تغییر: ${changePercent.toFixed(2)}%`);

                // بررسی Take Profit
                if (position.takeProfit && changePercent >= position.takeProfit) {
                    console.log(`🎯 Take Profit فعال شد برای ${tokenMint.slice(0, 8)}... در ${changePercent.toFixed(2)}%`);
                    await this.sellToken(tokenMint, 100, { reason: 'take_profit' });
                }
                // بررسی Stop Loss
                else if (position.stopLoss && changePercent <= -Math.abs(position.stopLoss)) {
                    console.log(`🛑 Stop Loss فعال شد برای ${tokenMint.slice(0, 8)}... در ${changePercent.toFixed(2)}%`);
                    await this.sellToken(tokenMint, 100, { reason: 'stop_loss' });
                }

            } catch (error) {
                console.error(`❌ خطا در مانیتورینگ ${tokenMint}:`, error.message);
            }
        }
    }

    // شروع مانیتورینگ خودکار
    startMonitoring(intervalSeconds = 30) {
        console.log(`🔄 مانیتورینگ خودکار شروع شد (هر ${intervalSeconds} ثانیه)`);
        
        setInterval(() => {
            this.monitorPositions();
        }, intervalSeconds * 1000);
    }

    // نمایش موقعیت‌های فعال
    showActivePositions() {
        if (this.activePositions.size === 0) {
            console.log('📊 هیچ موقعیت فعالی وجود ندارد');
            return;
        }

        console.log('\n📊 موقعیت‌های فعال:');
        console.log('═'.repeat(80));
        
        for (const [tokenMint, position] of this.activePositions.entries()) {
            console.log(`🪙 توکن: ${tokenMint.slice(0, 8)}...`);
            console.log(`💰 مقدار سرمایه: ${position.solInvested} SOL`);
            console.log(`📈 قیمت خرید: ${position.buyPrice.toFixed(8)}`);
            console.log(`🎯 Take Profit: ${position.takeProfit || 'تعیین نشده'}%`);
            console.log(`🛑 Stop Loss: ${position.stopLoss || 'تعیین نشده'}%`);
            console.log(`⏰ زمان خرید: ${new Date(position.timestamp).toLocaleString('fa-IR')}`);
            console.log('─'.repeat(40));
        }
    }
}

// نمونه استفاده
async function main() {
    const bot = new SolanaTradeBot();
    
    // اتصال والت (کلید خصوصی را از متغیر محیطی بخوانید)
    const privateKey = process.env.PRIVATE_KEY;
    if (!privateKey) {
        console.error('❌ لطفاً کلید خصوصی را در فایل .env تنظیم کنید');
        return;
    }
    
    const connected = await bot.connectWallet(privateKey);
    if (!connected) {
        console.error('❌ اتصال به والت ناموفق');
        return;
    }
    
    // شروع مانیتورینگ خودکار
    bot.startMonitoring(30); // هر 30 ثانیه
    
    console.log('🚀 ربات معامله‌گر آماده است!');
    console.log('📝 برای خرید توکن از متد buyToken استفاده کنید');
    console.log('📝 برای فروش از متد sellToken استفاده کنید');
}

// اجرای ربات
if (import.meta.url === `file://${process.argv[1]}`) {
    main().catch(console.error);
}

export default SolanaTradeBot;
