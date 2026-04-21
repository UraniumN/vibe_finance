/**
 * VibeFinance — AI Finance Chatbot
 * 
 * Implements the chatbot logic from streamlit_app.py in pure JS:
 * - Expense tracking with NLP parsing
 * - Budget summary (50/30/20 rule)
 * - Stock forecast simulation
 * - Investment advisor logic
 * - CSV/Excel bank statement analysis & dashboard
 * 
 * All logic runs client-side for this standalone version.
 * Reads from transactions.json for transaction data.
 */

(function () {
    'use strict';

    // ==========================================
    // State
    // ==========================================

    const state = {
        messages: [],
        expenses: [],
        income: 50000,
        ticker: 'TCS.NS',
        uploadedData: null,
        normalizedData: null,
        selectedMonth: null,
        transactionsData: [],
        geminiEnabled: false,
        geminiApiKey: '',
    };

    // NIFTY50 ticker list for stopword filtering
    const STOCK_STOPWORDS = new Set([
        'SHOULD', 'INVEST', 'FORECAST', 'PREDICT', 'STOCK', 'GIVE',
        'SHOW', 'PLEASE', 'BUDGET', 'SUMMARY', 'THE', 'FOR', 'HOW',
        'WHAT', 'CAN', 'YOU', 'HELP', 'WITH', 'NOW', 'MY', 'ME',
    ]);

    // Category classification mapping (from streamlit_app.py)
    const CATEGORY_MAP = {
        'insurance': ['lic', 'insurance', 'premium'],
        'cash withdrawal': ['atm', 'cash'],
        'utilities': ['electric', 'water', 'gas', 'bill', 'utility', 'recharge'],
        'shopping': ['amazon', 'flipkart', 'shopping', 'myntra'],
        'groceries': ['grocery', 'mart', 'supermarket', 'dmart', 'bigbasket'],
        'food and dining': ['swiggy', 'zomato', 'restaurant', 'food', 'dinner', 'cafe', 'lunch', 'breakfast'],
        'entertainment': ['netflix', 'prime', 'fancode', 'hotstar', 'movie'],
        'travel': ['uber', 'ola', 'flight', 'train', 'bus', 'irctc'],
    };

    let dashboardCharts = {};

    // ==========================================
    // Initialization
    // ==========================================

    document.addEventListener('DOMContentLoaded', async () => {
        initTheme();
        initGemini();
        await loadTransactionData();
        initChat();
        bindEvents();
    });

    function initTheme() {
        const savedTheme = localStorage.getItem('vf-theme') || 'dark';
        document.documentElement.setAttribute('data-theme', savedTheme);

        document.getElementById('theme-toggle')?.addEventListener('click', () => {
            const current = document.documentElement.getAttribute('data-theme');
            const next = current === 'dark' ? 'light' : 'dark';
            document.documentElement.setAttribute('data-theme', next);
            localStorage.setItem('vf-theme', next);
            if (state.normalizedData) {
                renderDashboard();
            }
        });
    }

    function initGemini() {
        const savedKey = localStorage.getItem('vf-gemini-key') || '';
        const savedEnabled = localStorage.getItem('vf-gemini-enabled') === 'true';

        state.geminiApiKey = savedKey;
        state.geminiEnabled = savedEnabled;

        const keyInput = document.getElementById('gemini-api-key');
        const toggle = document.getElementById('gemini-toggle');

        if (keyInput && savedKey) keyInput.value = savedKey;
        if (toggle) toggle.checked = savedEnabled;

        updateGeminiStatus();
    }

    function updateGeminiStatus() {
        const statusEl = document.getElementById('gemini-status');
        if (!statusEl) return;

        if (state.geminiEnabled && state.geminiApiKey) {
            statusEl.innerHTML = '<span style="color:var(--green);">✅ Gemini AI active</span>';
        } else if (state.geminiEnabled && !state.geminiApiKey) {
            statusEl.innerHTML = '<span style="color:var(--orange);">⚠️ Enter API key above</span>';
        } else {
            statusEl.innerHTML = '<span style="color:var(--text-muted);">Disabled — using local logic</span>';
        }
    }

    /**
     * Call Gemini API with financial context.
     * Uses the structured reply from the rule-based engine as grounding data.
     */
    async function callGeminiAPI(userMessage, structuredReply) {
        const API_URL = `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.0-flash:generateContent?key=${state.geminiApiKey}`;

        // Build financial context for Gemini
        const totalSpent = state.expenses
            .filter(e => e.type === 'debit' || e.type === 'unknown')
            .reduce((sum, e) => sum + e.amount, 0);
        const budgetRemaining = state.income - totalSpent;

        const financialContext = [
            `User monthly income: ₹${state.income}`,
            `Total expenses tracked: ${state.expenses.length}`,
            `Total spent: ₹${totalSpent.toFixed(2)}`,
            `Budget remaining: ₹${Math.max(0, budgetRemaining).toFixed(2)}`,
            `Selected stock ticker: ${state.ticker}`,
            state.normalizedData ? `Uploaded statement: ${state.normalizedData.length} transactions` : 'No statement uploaded',
        ].join('\n');

        // System prompt
        const systemPrompt = `You are VibeFinance AI — a friendly, expert personal finance assistant embedded in a web dashboard.
Your capabilities: expense tracking, budget analysis (50/30/20 rule), stock forecasting, investment advice, and bank statement analysis.
Keep responses concise (under 200 words), use markdown formatting with **bold** and bullet points (•).
Always use ₹ for Indian Rupees. Be encouraging but honest about financial risks.
Include relevant emojis for visual appeal.

CURRENT USER FINANCIAL CONTEXT:
${financialContext}`;

        // Build messages
        const parts = [];

        // Add system context
        parts.push({ text: systemPrompt });

        // If rule-based engine produced data, include it as grounding
        if (structuredReply) {
            parts.push({ text: `[INTERNAL DATA - Use this to ground your response, but rephrase naturally]:\n${structuredReply}` });
        }

        // Add user message
        parts.push({ text: `User asks: ${userMessage}` });

        const body = {
            contents: [{ parts }],
            generationConfig: {
                temperature: 0.7,
                maxOutputTokens: 512,
                topP: 0.9,
            },
        };

        const response = await fetch(API_URL, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(body),
        });

        if (!response.ok) {
            const errData = await response.json().catch(() => ({}));
            const errMsg = errData?.error?.message || response.statusText;
            throw new Error(`Gemini API error: ${errMsg}`);
        }

        const data = await response.json();
        const text = data?.candidates?.[0]?.content?.parts?.[0]?.text;

        if (!text) {
            throw new Error('Empty response from Gemini');
        }

        return text;
    }

    async function loadTransactionData() {
        try {
            const response = await fetch('transactions.json');
            if (response.ok) {
                state.transactionsData = await response.json();
                // Parse expenses from transactions for budget analysis
                for (const tx of state.transactionsData) {
                    if (tx.transaction && tx.amount) {
                        const amount = parseFloat(String(tx.amount).replace(/[₹,Rs\s]/gi, ''));
                        if (!isNaN(amount) && amount > 0) {
                            state.expenses.push({
                                amount,
                                category: classifyCategory(tx.party || ''),
                                description: tx.party || 'Transaction',
                                type: tx.type || 'unknown',
                                timestamp: new Date().toISOString(),
                            });
                        }
                    }
                }
            }
        } catch (err) {
            console.error('Failed to load transactions:', err);
        }
    }

    function initChat() {
        addMessage('assistant', 
            `👋 Hi! I'm your **VibeFinance** AI assistant. I can help you with:\n\n` +
            `• **Expense tracking**: "Spent 500 on dinner"\n` +
            `• **Budget summary**: "Show my monthly summary"\n` +
            `• **Stock forecast**: "Forecast TCS.NS"\n` +
            `• **Investment advice**: "Should I invest in RELIANCE.NS?"\n` +
            `• **File analytics**: Upload CSV/Excel and ask "Give file insights"\n\n` +
            `_Try the quick actions on the sidebar to get started!_`
        );
    }

    // ==========================================
    // Event Binding
    // ==========================================

    function bindEvents() {
        // Chat send
        const sendBtn = document.getElementById('chat-send');
        const chatInput = document.getElementById('chat-input');

        sendBtn?.addEventListener('click', handleSend);
        chatInput?.addEventListener('keydown', (e) => {
            if (e.key === 'Enter' && !e.shiftKey) {
                e.preventDefault();
                handleSend();
            }
        });

        // Quick action buttons
        document.querySelectorAll('.quick-btn').forEach(btn => {
            btn.addEventListener('click', () => {
                const msg = btn.dataset.msg;
                if (msg) {
                    addMessage('user', msg);
                    processUserMessage(msg);
                }
            });
        });

        // File upload
        document.getElementById('file-upload')?.addEventListener('change', handleFileUpload);

        // Income change
        document.getElementById('income-input')?.addEventListener('change', (e) => {
            state.income = parseFloat(e.target.value) || 50000;
        });

        // Ticker change
        document.getElementById('ticker-select')?.addEventListener('change', (e) => {
            state.ticker = e.target.value;
        });

        // Month selector
        document.getElementById('month-select')?.addEventListener('change', (e) => {
            state.selectedMonth = e.target.value;
            renderDashboard();
        });

        // Gemini toggle
        document.getElementById('gemini-toggle')?.addEventListener('change', (e) => {
            state.geminiEnabled = e.target.checked;
            const apiKey = document.getElementById('gemini-api-key')?.value.trim();
            state.geminiApiKey = apiKey;
            localStorage.setItem('vf-gemini-key', apiKey);
            localStorage.setItem('vf-gemini-enabled', state.geminiEnabled);
            updateGeminiStatus();
        });

        document.getElementById('gemini-api-key')?.addEventListener('change', (e) => {
            state.geminiApiKey = e.target.value.trim();
            localStorage.setItem('vf-gemini-key', state.geminiApiKey);
            updateGeminiStatus();
        });
    }

    // ==========================================
    // Chat Logic
    // ==========================================

    function handleSend() {
        const input = document.getElementById('chat-input');
        const text = input?.value.trim();
        if (!text) return;

        addMessage('user', text);
        input.value = '';
        processUserMessage(text);
    }

    async function processUserMessage(text) {
        // Show typing indicator
        showTyping(true);

        // Get structured reply from rule-based engine
        const structuredReply = generateReply(text);

        // Check if Gemini is enabled and API key is set
        if (state.geminiEnabled && state.geminiApiKey) {
            try {
                const geminiReply = await callGeminiAPI(text, structuredReply);
                showTyping(false);
                addMessage('assistant', geminiReply);
            } catch (err) {
                console.warn('Gemini API error, falling back:', err);
                showTyping(false);
                // If structured reply is null (open-ended), show error + help
                const fallback = structuredReply || `⚠️ Gemini API error: ${err.message}\n\n_Try checking your API key or ask a specific question like "Show my budget summary"._`;
                addMessage('assistant', fallback);
            }
        } else {
            // Fallback: use local logic with natural delay
            setTimeout(() => {
                showTyping(false);
                addMessage('assistant', structuredReply);
            }, 500 + Math.random() * 800);
        }
    }

    /**
     * Generate reply based on user input.
     * Mirrors the logic from streamlit_app.py's generate_reply function.
     */
    function generateReply(userText) {
        const text = userText.toLowerCase().trim();
        const effectiveTicker = extractTicker(userText, state.ticker);

        // 1. Investment advice
        if (text.includes('should i invest') || (text.includes('invest') && !text.includes('insight'))) {
            if (effectiveTicker === 'NIFTY50') {
                return '📊 For investment advice, please pick an **individual stock ticker**. NIFTY50 returns portfolio-wide data.\n\nTry: "Should I invest in TCS.NS?"';
            }
            return generateInvestAdvice(effectiveTicker);
        }

        // 2. Stock forecast
        if (text.includes('forecast') || text.includes('predict') || text.includes('stock price')) {
            if (effectiveTicker === 'NIFTY50') {
                return generateNifty50Snapshot();
            }
            return generateStockForecast(effectiveTicker);
        }

        // 3. Budget summary
        if (text.includes('summary') || text.includes('budget')) {
            return generateBudgetSummary();
        }

        // 4. Expense entry
        if (/\bspent\b|\bexpense\b|\bpaid\b/.test(text)) {
            return parseAndSaveExpense(userText);
        }

        // 5. File insights
        if (text.includes('insight') || text.includes('analy') || text.includes('file') || text.includes('excel') || text.includes('csv')) {
            if (!state.normalizedData) {
                return '📁 Please **upload a CSV/Excel file** first using the sidebar, then ask for insights.';
            }
            return generateFileSummary();
        }

        // Default: if Gemini is enabled, return null to let Gemini handle freely
        if (state.geminiEnabled && state.geminiApiKey) {
            return null; // Signal to use Gemini for open-ended conversation
        }

        // Default help message
        return `I can help with:\n\n` +
            `• **Expense entry**: "Spent 500 on dinner"\n` +
            `• **Budget summary**: "Show my monthly summary"\n` +
            `• **Stock forecast**: "Forecast INFY.NS"\n` +
            `• **Investment advice**: "Should I invest in TCS.NS?"\n` +
            `• **File analytics**: Upload CSV/Excel and ask "Give file insights"`;
    }

    // ==========================================
    // Feature: Expense Tracking
    // ==========================================

    function parseAndSaveExpense(text) {
        // Extract amount using regex
        const amountMatch = text.match(/(?:₹|Rs\.?\s*|INR\s*)?(\d[\d,]*\.?\d*)/i);
        const amount = amountMatch ? parseFloat(amountMatch[1].replace(/,/g, '')) : 0;

        if (amount <= 0) {
            return '❌ I couldn\'t detect a valid amount. Please try: "Spent 500 on dinner"';
        }

        // Extract category
        const category = classifyCategory(text);

        // Extract description
        const descMatch = text.match(/(?:on|at|for|to)\s+(.+)/i);
        const description = descMatch ? descMatch[1].trim() : text;

        const expense = {
            amount,
            category,
            description,
            type: 'debit',
            timestamp: new Date().toISOString(),
        };

        state.expenses.push(expense);

        return `✅ **Expense saved!**\n\n` +
            `• **Amount**: ₹${formatCurrency(amount)}\n` +
            `• **Category**: ${category}\n` +
            `• **Description**: ${description}\n\n` +
            `_Total expenses tracked: ${state.expenses.length}_`;
    }

    function classifyCategory(text) {
        const t = String(text).toLowerCase();
        for (const [label, keywords] of Object.entries(CATEGORY_MAP)) {
            if (keywords.some(k => t.includes(k))) return label;
        }
        return 'other';
    }

    // ==========================================
    // Feature: Budget Summary (50/30/20)
    // ==========================================

    function generateBudgetSummary() {
        const totalSpent = state.expenses
            .filter(e => e.type === 'debit' || e.type === 'unknown')
            .reduce((sum, e) => sum + e.amount, 0);

        const budgetRemaining = state.income - totalSpent;
        const savingsRate = ((budgetRemaining / state.income) * 100).toFixed(1);

        // Group by category
        const categories = {};
        state.expenses.forEach(e => {
            if (e.type === 'debit' || e.type === 'unknown') {
                categories[e.category] = (categories[e.category] || 0) + e.amount;
            }
        });

        const topCategory = Object.entries(categories).sort((a, b) => b[1] - a[1])[0];

        // 50/30/20 breakdown
        const needs = state.income * 0.5;
        const wants = state.income * 0.3;
        const savings = state.income * 0.2;

        return `📊 **Monthly Budget Summary**\n\n` +
            `• **Income**: ₹${formatCurrency(state.income)}\n` +
            `• **Total Spent**: ₹${formatCurrency(totalSpent)}\n` +
            `• **Remaining**: ₹${formatCurrency(Math.max(0, budgetRemaining))}\n` +
            `• **Savings Rate**: ${savingsRate}%\n` +
            `• **Top Category**: ${topCategory ? `${topCategory[0]} (₹${formatCurrency(topCategory[1])})` : 'None'}\n\n` +
            `**50/30/20 Rule Targets:**\n` +
            `• Needs (50%): ₹${formatCurrency(needs)}\n` +
            `• Wants (30%): ₹${formatCurrency(wants)}\n` +
            `• Savings (20%): ₹${formatCurrency(savings)}\n\n` +
            (budgetRemaining < 0 ? '⚠️ _You are over budget this month!_' :
                budgetRemaining > savings ? '✅ _You are on track to meet savings goals!_' :
                    '⚠️ _Consider reducing expenses to hit your 20% savings target._');
    }

    // ==========================================
    // Feature: Stock Forecast (Simulated)
    // ==========================================

    function generateStockForecast(ticker) {
        // Simulate stock data (since we can't call yfinance from browser)
        const seed = hashCode(ticker);
        const currentPrice = 1000 + (seed % 5000);
        const change = ((seed % 200) - 100) / 100; // -1% to +1%
        const predicted = currentPrice * (1 + change / 100);
        const changePct = ((predicted - currentPrice) / currentPrice * 100).toFixed(2);

        // SMA simulation
        const sma20 = currentPrice * (1 + (seed % 50 - 25) / 1000);
        const sma50 = currentPrice * (1 + (seed % 80 - 40) / 1000);

        // Trend recommendation (from IMPLEMENTATION_HANDOFF.md)
        let recommendation, emoji;
        if (currentPrice > sma20 && sma20 > sma50) {
            recommendation = 'STRONG BUY';
            emoji = '✅';
        } else if (currentPrice > sma20) {
            recommendation = 'HOLD / CAUTIOUS';
            emoji = '⚠️';
        } else {
            recommendation = 'AVOID / SELL';
            emoji = '❌';
        }

        const trendSignal = changePct >= 0 ? 'BULLISH 📈' : 'BEARISH 📉';

        return `📈 **Stock Forecast for ${ticker}**\n\n` +
            `• **Current Price**: ₹${formatCurrency(currentPrice)}\n` +
            `• **Predicted Next Day**: ₹${formatCurrency(predicted)}\n` +
            `• **Expected Change**: ${changePct}%\n` +
            `• **Trend Signal**: ${trendSignal}\n` +
            `• **Technical View**: ${emoji} ${recommendation}\n` +
            `• **SMA20**: ₹${formatCurrency(sma20)} | **SMA50**: ₹${formatCurrency(sma50)}\n\n` +
            `_⚠️ This is a simulated forecast. Connect a live API (yfinance) for real data._`;
    }

    function generateNifty50Snapshot() {
        const tickers = ['RELIANCE.NS', 'TCS.NS', 'HDFCBANK.NS', 'INFY.NS', 'ICICIBANK.NS'];
        const lines = ['📊 **NIFTY50 Forecast Snapshot** (Top 5 Predicted Gainers)\n'];

        tickers.forEach(ticker => {
            const seed = hashCode(ticker);
            const price = 1000 + (seed % 5000);
            const change = ((seed % 200 - 50) / 100).toFixed(2);

            const sma20 = price * (1 + (seed % 50 - 25) / 1000);
            const sma50 = price * (1 + (seed % 80 - 40) / 1000);
            let rec;
            if (price > sma20 && sma20 > sma50) rec = 'STRONG BUY ✅';
            else if (price > sma20) rec = 'HOLD ⚠️';
            else rec = 'AVOID ❌';

            lines.push(`• **${ticker}**: ${change}% | ${rec}`);
        });

        lines.push('\n_⚠️ Simulated data. Connect yfinance API for real-time forecasts._');
        return lines.join('\n');
    }

    // ==========================================
    // Feature: Investment Advisor
    // ==========================================

    function generateInvestAdvice(ticker) {
        const totalSpent = state.expenses
            .filter(e => e.type === 'debit' || e.type === 'unknown')
            .reduce((sum, e) => sum + e.amount, 0);

        const budgetRemaining = state.income - totalSpent;
        const surplusRatio = budgetRemaining / state.income;

        // Get stock data
        const seed = hashCode(ticker);
        const currentPrice = 1000 + (seed % 5000);
        const sma20 = currentPrice * (1 + (seed % 50 - 25) / 1000);
        const sma50 = currentPrice * (1 + (seed % 80 - 40) / 1000);
        const changePct = ((seed % 200 - 100) / 100).toFixed(2);

        let trendSignal, trendRec, trendEmoji;
        if (currentPrice > sma20 && sma20 > sma50) {
            trendRec = 'STRONG BUY';
            trendEmoji = '✅';
            trendSignal = 'BULLISH';
        } else if (currentPrice > sma20) {
            trendRec = 'HOLD / CAUTIOUS';
            trendEmoji = '⚠️';
            trendSignal = 'NEUTRAL';
        } else {
            trendRec = 'AVOID / SELL';
            trendEmoji = '❌';
            trendSignal = 'BEARISH';
        }

        // Decision logic (from IMPLEMENTATION_HANDOFF.md)
        const hasBudget = surplusRatio > 0.2;
        const isBullish = trendSignal === 'BULLISH';

        let aiMessage;
        let suggestedAmount = 0;

        if (hasBudget && isBullish) {
            suggestedAmount = Math.round(budgetRemaining * 0.3);
            aiMessage = `✅ **Go ahead!** You have a healthy surplus and ${ticker} shows a bullish trend. Consider investing ₹${formatCurrency(suggestedAmount)} (30% of your remaining budget).`;
        } else if (hasBudget && !isBullish) {
            aiMessage = `⚠️ **Wait.** Your budget is healthy, but ${ticker} is not showing a strong upward trend. Consider waiting for a better entry point or try a SIP approach.`;
        } else if (!hasBudget && isBullish) {
            aiMessage = `⚠️ **Not now.** ${ticker} looks promising, but your budget surplus is below 20%. Focus on building an emergency fund first.`;
        } else {
            aiMessage = `❌ **Not recommended.** Both your budget position and market trend are unfavorable. Focus on reducing expenses and building savings.`;
        }

        return `💡 **Investment Advisor for ${ticker}**\n\n` +
            `**Budget Health:**\n` +
            `• Remaining: ₹${formatCurrency(Math.max(0, budgetRemaining))}\n` +
            `• Surplus Ratio: ${(surplusRatio * 100).toFixed(1)}% ${hasBudget ? '✅' : '❌'} (need >20%)\n\n` +
            `**Market Signal:**\n` +
            `• Forecast Change: ${changePct}%\n` +
            `• Trend: ${trendSignal} ${trendEmoji}\n` +
            `• Technical: ${trendRec}\n` +
            `• SMA20/SMA50: ₹${formatCurrency(sma20)} / ₹${formatCurrency(sma50)}\n\n` +
            `**Recommendation:**\n${aiMessage}\n\n` +
            `_⚠️ This is educational guidance — consult a certified advisor for actual investment decisions._`;
    }

    // ==========================================
    // Feature: File Upload & Statement Analysis
    // ==========================================

    function handleFileUpload(event) {
        const file = event.target.files[0];
        if (!file) return;

        const statusEl = document.getElementById('upload-status');
        const name = file.name.toLowerCase();

        if (name.endsWith('.csv')) {
            const reader = new FileReader();
            reader.onload = (e) => {
                try {
                    const result = Papa.parse(e.target.result, { header: true, skipEmptyLines: true });
                    state.uploadedData = result.data;
                    state.normalizedData = normalizeStatementData(result.data);
                    statusEl.innerHTML = `<div class="upload-success">✅ Loaded: ${file.name} (${result.data.length} rows)</div>`;
                    setupMonthSelector();
                    renderDashboard();
                } catch (err) {
                    statusEl.innerHTML = `<div style="color:var(--red);font-size:12px;">❌ Error: ${err.message}</div>`;
                }
            };
            reader.readAsText(file);
        } else if (name.endsWith('.xlsx') || name.endsWith('.xls')) {
            const reader = new FileReader();
            reader.onload = (e) => {
                try {
                    const workbook = XLSX.read(e.target.result, { type: 'array' });
                    const firstSheet = workbook.SheetNames[0];
                    const data = XLSX.utils.sheet_to_json(workbook.Sheets[firstSheet]);
                    state.uploadedData = data;
                    state.normalizedData = normalizeStatementData(data);
                    statusEl.innerHTML = `<div class="upload-success">✅ Loaded: ${file.name} (${data.length} rows)</div>`;
                    setupMonthSelector();
                    renderDashboard();
                } catch (err) {
                    statusEl.innerHTML = `<div style="color:var(--red);font-size:12px;">❌ Error: ${err.message}</div>`;
                }
            };
            reader.readAsArrayBuffer(file);
        } else {
            statusEl.innerHTML = `<div style="color:var(--red);font-size:12px;">❌ Unsupported file type. Upload CSV or Excel.</div>`;
        }
    }

    /**
     * Normalize statement data (mirrors streamlit_app.py normalize_statement_df)
     */
    function normalizeStatementData(data) {
        return data.map(row => {
            const dateCol = findColumn(row, ['date', 'txn date', 'transaction date', 'value date']);
            const descCol = findColumn(row, ['description', 'narration', 'remarks', 'details']);
            const accountCol = findColumn(row, ['account', 'acct', 'beneficiary', 'merchant', 'counterparty']);
            const debitCol = findColumn(row, ['debit', 'withdraw', 'dr']);
            const creditCol = findColumn(row, ['credit', 'deposit', 'cr']);
            const amountCol = findColumn(row, ['amount', 'amt', 'transaction amount']);
            const balanceCol = findColumn(row, ['balance', 'closing balance', 'running balance']);

            // Parse date
            let txnDate = null;
            if (dateCol !== null) {
                const d = new Date(row[dateCol]);
                if (!isNaN(d.getTime())) txnDate = d;
            }

            // Parse amounts
            let debit = 0, credit = 0;
            if (debitCol !== null && creditCol !== null) {
                debit = parseAmount(row[debitCol]);
                credit = parseAmount(row[creditCol]);
            } else if (amountCol !== null) {
                const amt = parseAmount(row[amountCol]);
                if (amt >= 0) { credit = amt; } else { debit = Math.abs(amt); }
            }

            const description = descCol !== null ? String(row[descCol]) : 'Unknown';
            const accountName = accountCol !== null ? String(row[accountCol]) : 'Primary Account';
            const balance = balanceCol !== null ? parseAmount(row[balanceCol]) : null;
            const category = classifyCategory(description);

            // Compute month
            let month = null;
            if (txnDate) {
                month = `${txnDate.getFullYear()}-${String(txnDate.getMonth() + 1).padStart(2, '0')}`;
            }

            return {
                txnDate,
                description,
                accountName,
                debit,
                credit,
                amountSigned: credit - debit,
                balance,
                month,
                category,
            };
        }).filter(r => r.txnDate !== null);
    }

    function findColumn(row, aliases) {
        const keys = Object.keys(row);
        for (const key of keys) {
            const lower = key.toLowerCase().trim();
            for (const alias of aliases) {
                if (lower.includes(alias)) return key;
            }
        }
        return null;
    }

    function parseAmount(val) {
        if (val === null || val === undefined || val === '') return 0;
        const cleaned = String(val).replace(/[₹,Rs\s]/gi, '').trim();
        const num = parseFloat(cleaned);
        return isNaN(num) ? 0 : num;
    }

    function setupMonthSelector() {
        if (!state.normalizedData) return;

        const months = [...new Set(state.normalizedData.map(r => r.month).filter(Boolean))].sort();
        const select = document.getElementById('month-select');
        if (!select) return;

        select.innerHTML = months.map(m => `<option value="${m}">${m}</option>`).join('');
        state.selectedMonth = months[months.length - 1] || null;
        if (state.selectedMonth) {
            select.value = state.selectedMonth;
        }
    }

    function generateFileSummary() {
        if (!state.normalizedData || state.normalizedData.length === 0) {
            return '📁 No valid data found. Please upload a CSV/Excel file with date, description, and amount columns.';
        }

        let data = state.normalizedData;
        if (state.selectedMonth) {
            data = data.filter(r => r.month === state.selectedMonth);
        }

        if (data.length === 0) return 'No transactions found for the selected period.';

        const totalCredits = data.reduce((s, r) => s + r.credit, 0);
        const totalDebits = data.reduce((s, r) => s + r.debit, 0);
        const net = totalCredits - totalDebits;
        const txCount = data.length;

        // Top categories
        const cats = {};
        data.forEach(r => {
            if (r.debit > 0) {
                cats[r.category] = (cats[r.category] || 0) + r.debit;
            }
        });
        const topCats = Object.entries(cats).sort((a, b) => b[1] - a[1]).slice(0, 5);

        let result = `📄 **Statement Summary**\n\n` +
            `• **Total Credits**: +₹${formatCurrency(totalCredits)}\n` +
            `• **Total Debits**: -₹${formatCurrency(totalDebits)}\n` +
            `• **Net**: ${net >= 0 ? '+' : ''}₹${formatCurrency(Math.abs(net))}\n` +
            `• **Transactions**: ${txCount}\n\n`;

        if (topCats.length > 0) {
            result += `**Top Spending Categories:**\n`;
            topCats.forEach(([cat, amt]) => {
                const pct = totalDebits > 0 ? ((amt / totalDebits) * 100).toFixed(1) : 0;
                result += `• ${cat}: ₹${formatCurrency(amt)} (${pct}%)\n`;
            });
        }

        return result;
    }

    // ==========================================
    // Statement Dashboard Rendering
    // ==========================================

    function renderDashboard() {
        if (!state.normalizedData || state.normalizedData.length === 0) return;

        const dashboard = document.getElementById('statement-dashboard');
        dashboard.style.display = 'block';

        let data = state.normalizedData;
        if (state.selectedMonth) {
            data = data.filter(r => r.month === state.selectedMonth);
        }
        if (data.length === 0) return;

        data.sort((a, b) => a.txnDate - b.txnDate);

        const totalCredits = data.reduce((s, r) => s + r.credit, 0);
        const totalDebits = data.reduce((s, r) => s + r.debit, 0);
        const net = totalCredits - totalDebits;
        const creditCount = data.filter(r => r.credit > 0).length;
        const debitCount = data.filter(r => r.debit > 0).length;

        const balances = data.filter(r => r.balance !== null).map(r => r.balance);
        const openingBalance = balances.length > 0 ? balances[0] : 0;
        const closingBalance = balances.length > 0 ? balances[balances.length - 1] : 0;

        // Render stat cards
        const cardsRow = document.getElementById('stat-cards-row');
        cardsRow.innerHTML = `
            <div class="stat-mini-card">
                <div class="stat-label">Opening Balance</div>
                <div class="stat-value">₹${formatCurrency(openingBalance)}</div>
            </div>
            <div class="stat-mini-card">
                <div class="stat-label">Total Credits</div>
                <div class="stat-value positive">+₹${formatCurrency(totalCredits)}</div>
            </div>
            <div class="stat-mini-card">
                <div class="stat-label">Total Debits</div>
                <div class="stat-value negative">-₹${formatCurrency(totalDebits)}</div>
            </div>
            <div class="stat-mini-card">
                <div class="stat-label">Closing Balance</div>
                <div class="stat-value">₹${formatCurrency(closingBalance)}</div>
            </div>
        `;

        // Summary narrative
        const summaryEl = document.getElementById('summary-narrative');
        summaryEl.innerHTML = `During this period, the account received <strong style="color:var(--green);">₹${formatCurrency(totalCredits)}</strong> across ${creditCount} credit transactions and spent <strong style="color:var(--red);">₹${formatCurrency(totalDebits)}</strong> across ${debitCount} debit transactions. The period ended with a net <strong style="color:${net >= 0 ? 'var(--green)' : 'var(--red)'};">${net >= 0 ? 'gain' : 'decline'} of ₹${formatCurrency(Math.abs(net))}</strong>.`;

        // Merchant narrative
        const merchants = {};
        data.filter(r => r.debit > 0).forEach(r => {
            merchants[r.accountName] = (merchants[r.accountName] || 0) + 1;
        });
        const topMerchants = Object.entries(merchants).sort((a, b) => b[1] - a[1]).slice(0, 3);
        const merchantEl = document.getElementById('merchant-narrative');
        if (topMerchants.length > 0) {
            const parts = topMerchants.map(([n, c]) => `${n} (${c} payments)`);
            merchantEl.textContent = `Most frequent payment destinations were ${parts.join(', ')}.`;
        } else {
            merchantEl.textContent = 'No repeating merchant payments were detected.';
        }

        // Spending bars
        const categories = {};
        data.forEach(r => {
            if (r.debit > 0) {
                categories[r.category] = (categories[r.category] || 0) + r.debit;
            }
        });
        const sortedCats = Object.entries(categories).sort((a, b) => b[1] - a[1]).slice(0, 7);
        const maxSpend = sortedCats.length > 0 ? sortedCats[0][1] : 1;

        const barsEl = document.getElementById('spending-bars');
        barsEl.innerHTML = sortedCats.map(([cat, amt]) => {
            const pct = (amt / maxSpend) * 100;
            const share = totalDebits > 0 ? ((amt / totalDebits) * 100).toFixed(1) : 0;
            return `
                <div class="spending-bar-row">
                    <span class="spending-bar-label">${capitalize(cat)}</span>
                    <div class="spending-bar-track">
                        <div class="spending-bar-fill" style="width:${pct.toFixed(1)}%"></div>
                    </div>
                    <span class="spending-bar-amount">₹${formatCurrency(amt)}</span>
                    <span class="spending-bar-pct">${share}%</span>
                </div>
            `;
        }).join('') || '<p style="color:var(--text-muted);">No debit transactions found.</p>';

        // Render charts
        renderDashboardCharts(state.normalizedData, data);
    }

    function renderDashboardCharts(allData, monthData) {
        const style = getComputedStyle(document.documentElement);
        const green = style.getPropertyValue('--green').trim();
        const red = style.getPropertyValue('--red').trim();
        const blue = style.getPropertyValue('--blue').trim();
        const purple = style.getPropertyValue('--purple').trim();
        const textSecondary = style.getPropertyValue('--text-secondary').trim();
        const borderColor = style.getPropertyValue('--border-color').trim();

        // Destroy existing
        Object.values(dashboardCharts).forEach(c => c.destroy());
        dashboardCharts = {};

        // Monthly trend chart (all months)
        const monthlySpend = {};
        allData.forEach(r => {
            if (r.month) {
                monthlySpend[r.month] = (monthlySpend[r.month] || 0) + r.debit;
            }
        });
        const months = Object.keys(monthlySpend).sort();
        const monthlyValues = months.map(m => monthlySpend[m]);

        const trendCtx = document.getElementById('monthly-trend-chart')?.getContext('2d');
        if (trendCtx) {
            dashboardCharts.trend = new Chart(trendCtx, {
                type: 'line',
                data: {
                    labels: months,
                    datasets: [{
                        label: 'Monthly Spend',
                        data: monthlyValues,
                        borderColor: blue,
                        backgroundColor: blue + '20',
                        fill: true,
                        tension: 0.4,
                        pointRadius: 4,
                        pointHoverRadius: 6,
                    }],
                },
                options: {
                    responsive: true,
                    maintainAspectRatio: false,
                    plugins: { legend: { display: false } },
                    scales: {
                        y: {
                            beginAtZero: true,
                            grid: { color: borderColor },
                            ticks: { color: textSecondary, font: { size: 11 } },
                        },
                        x: {
                            grid: { display: false },
                            ticks: { color: textSecondary, font: { size: 11 } },
                        },
                    },
                },
            });
        }

        // Category pie chart
        const cats = {};
        monthData.forEach(r => {
            if (r.debit > 0) {
                cats[r.category] = (cats[r.category] || 0) + r.debit;
            }
        });
        const catLabels = Object.keys(cats);
        const catValues = Object.values(cats);
        const catColors = [
            '#818cf8', '#c084fc', '#f472b6', '#34d399', '#fb923c',
            '#60a5fa', '#a78bfa', '#fbbf24', '#f87171', '#22d3ee',
        ];

        const catCtx = document.getElementById('category-chart')?.getContext('2d');
        if (catCtx) {
            dashboardCharts.category = new Chart(catCtx, {
                type: 'doughnut',
                data: {
                    labels: catLabels.map(capitalize),
                    datasets: [{
                        data: catValues,
                        backgroundColor: catColors.slice(0, catLabels.length),
                        borderWidth: 0,
                        hoverOffset: 8,
                    }],
                },
                options: {
                    responsive: true,
                    maintainAspectRatio: false,
                    cutout: '60%',
                    plugins: {
                        legend: {
                            position: 'bottom',
                            labels: {
                                color: textSecondary,
                                padding: 12,
                                usePointStyle: true,
                                pointStyleWidth: 8,
                                font: { family: "'Inter', sans-serif", size: 11 },
                            },
                        },
                    },
                },
            });
        }
    }

    // ==========================================
    // Ticker Extraction (from streamlit_app.py)
    // ==========================================

    function extractTicker(text, defaultTicker) {
        const upper = text.toUpperCase();

        if (upper.includes('NIFTY50') || upper.includes('NIFTY 50')) {
            return 'NIFTY50';
        }

        // Check for explicit .NS/.BO pattern
        const nseMatch = upper.match(/\b([A-Z]{1,10}\.(?:NS|BO|BSE|NSE))\b/);
        if (nseMatch) return nseMatch[1];

        // Check for uppercase words that aren't stopwords
        const tokens = upper.match(/\b[A-Z]{1,5}\b/g) || [];
        for (const token of tokens) {
            if (!STOCK_STOPWORDS.has(token)) {
                return token;
            }
        }

        return defaultTicker;
    }

    // ==========================================
    // UI: Message Rendering
    // ==========================================

    function addMessage(role, content) {
        state.messages.push({ role, content });
        renderMessages();
    }

    function renderMessages() {
        const container = document.getElementById('chat-messages');
        if (!container) return;

        container.innerHTML = state.messages.map(msg => {
            const avatar = msg.role === 'assistant' ? '🤖' : '👤';
            const formattedContent = formatMarkdown(msg.content);

            return `
                <div class="chat-message ${msg.role}">
                    <div class="chat-avatar">${avatar}</div>
                    <div class="chat-bubble">${formattedContent}</div>
                </div>
            `;
        }).join('');

        // Scroll to bottom
        container.scrollTop = container.scrollHeight;
    }

    function showTyping(show) {
        const container = document.getElementById('chat-messages');
        if (!container) return;

        const existingTyping = container.querySelector('.typing-message');
        if (existingTyping) existingTyping.remove();

        if (show) {
            const typingHtml = `
                <div class="chat-message assistant typing-message">
                    <div class="chat-avatar">🤖</div>
                    <div class="chat-bubble">
                        <div class="typing-indicator">
                            <div class="typing-dot"></div>
                            <div class="typing-dot"></div>
                            <div class="typing-dot"></div>
                        </div>
                    </div>
                </div>
            `;
            container.insertAdjacentHTML('beforeend', typingHtml);
            container.scrollTop = container.scrollHeight;
        }
    }

    // ==========================================
    // Utilities
    // ==========================================

    function formatCurrency(value) {
        return new Intl.NumberFormat('en-IN', {
            minimumFractionDigits: 2,
            maximumFractionDigits: 2,
        }).format(value);
    }

    function formatMarkdown(text) {
        // Simple markdown to HTML
        return text
            .replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>')
            .replace(/_(.+?)_/g, '<em>$1</em>')
            .replace(/`(.+?)`/g, '<code>$1</code>')
            .replace(/\n/g, '<br>')
            .replace(/•/g, '&bull;');
    }

    function capitalize(str) {
        return str.replace(/\b\w/g, c => c.toUpperCase());
    }

    function hashCode(str) {
        let hash = 0;
        for (let i = 0; i < str.length; i++) {
            const char = str.charCodeAt(i);
            hash = ((hash << 5) - hash) + char;
            hash = hash & hash; // Convert to 32bit
        }
        return Math.abs(hash);
    }
})();
