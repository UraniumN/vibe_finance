/**
 * VibeFinance — Fraud Detection Engine
 * 
 * Implements three independent detection logics + flag merging + override system
 * Based on Fraud_detection.md specification
 */

class FraudDetectionEngine {
    constructor(config) {
        this.config = config || {
            threshold: 50000,
            recursion: {
                timeWindowHours: 24,
                amountTolerancePercent: 5,
                repeatThreshold: 3,
            },
            flags: {
                allowUserOverride: true,
                autoTrustAfterVerify: true,
            },
        };

        this.verifiedMerchants = new Map(); // userId -> Set<merchant>
        this.overrides = new Map(); // transactionId -> Override
    }

    /**
     * Process raw JSON data from transactions.json and normalize it
     * Based on data_Exctract.md specification
     */
    transformRawData(rawTransactions) {
        let idCounter = 1;
        const transactions = [];

        for (const raw of rawTransactions) {
            // Skip non-transactions
            if (raw.transaction === false) continue;

            // Parse amount
            let amount = 0;
            if (raw.amount !== null && raw.amount !== undefined) {
                const cleaned = String(raw.amount)
                    .replace(/[₹,Rs\s]/gi, '')
                    .trim();
                amount = parseFloat(cleaned);
                if (isNaN(amount)) amount = 0;
            }

            // Normalize merchant/party
            let merchant = raw.party ? String(raw.party).trim() : 'UNKNOWN_MERCHANT';
            if (merchant === '' || merchant === 'null') merchant = 'UNKNOWN_MERCHANT';

            // Normalize sender as userId
            let userId = raw.sender ? String(raw.sender).trim() : 'UNKNOWN_USER';
            if (userId === '' || userId === 'null') userId = 'UNKNOWN_USER';

            // Parse timestamp
            let timestamp = new Date();
            if (raw.date) {
                try {
                    const dateStr = raw.date;
                    if (raw.time && raw.time.includes(':')) {
                        timestamp = new Date(`${dateStr} ${raw.time}`);
                    } else {
                        timestamp = new Date(dateStr);
                    }
                    if (isNaN(timestamp.getTime())) timestamp = new Date();
                } catch {
                    timestamp = new Date();
                }
            } else if (raw.time) {
                // Only time, no date — use today
                const today = new Date();
                const timeParts = raw.time.match(/(\d+):(\d+)/);
                if (timeParts) {
                    today.setHours(parseInt(timeParts[1]), parseInt(timeParts[2]), 0, 0);
                    timestamp = today;
                }
            }

            // Generate unique ID
            const id = `TX-${String(idCounter).padStart(5, '0')}`;
            idCounter++;

            transactions.push({
                id,
                amount,
                merchant,
                timestamp,
                userId,
                type: raw.type || 'unknown',
                confidence: raw.confidence || 0,
                sender: raw.sender || 'Unknown',
            });
        }

        return transactions;
    }

    /**
     * Logic 1: High-Value Threshold Detection
     */
    checkThreshold(transaction) {
        if (transaction.amount > this.config.threshold) {
            const excess = transaction.amount - this.config.threshold;
            return `Amount exceeds threshold by ₹${this.formatCurrency(excess)}`;
        }
        return null;
    }

    /**
     * Logic 2: Recursive Payment Detection
     * Finds similar transactions to the same merchant within time window
     */
    checkRecursivePayments(transaction, userHistory) {
        const timeWindow = this.config.recursion.timeWindowHours * 60 * 60 * 1000;
        const tolerance = this.config.recursion.amountTolerancePercent / 100;

        const similarTransactions = userHistory.filter(tx => {
            if (tx.merchant !== transaction.merchant) return false;
            if (tx.id === transaction.id) return false;

            const timeDiff = Math.abs(transaction.timestamp.getTime() - tx.timestamp.getTime());
            if (timeDiff > timeWindow) return false;

            if (transaction.amount === 0 && tx.amount === 0) return true;

            const amountDiff = Math.abs(transaction.amount - tx.amount);
            const avgAmount = (transaction.amount + tx.amount) / 2;
            if (avgAmount === 0) return false;
            const relativeDiff = amountDiff / avgAmount;

            return relativeDiff <= tolerance;
        });

        if (similarTransactions.length >= this.config.recursion.repeatThreshold - 1) {
            const totalTransactions = similarTransactions.length + 1;
            // Calculate max time span
            let maxTimeDiff = 0;
            for (const tx of similarTransactions) {
                const diff = Math.abs(transaction.timestamp.getTime() - tx.timestamp.getTime());
                if (diff > maxTimeDiff) maxTimeDiff = diff;
            }
            const hours = Math.ceil(maxTimeDiff / (60 * 60 * 1000)) || 1;
            return `${totalTransactions} similar payments to ${transaction.merchant} within ${hours} hours`;
        }

        return null;
    }

    /**
     * Logic 3: Merchant Flag Assignment
     */
    getMerchantFlag(transaction, hasFraudAlerts) {
        // Check for user override first
        const override = this.overrides.get(transaction.id);
        if (override && override.newFlag === 'GREEN') {
            return { flag: 'GREEN', verifiedBy: override.verifiedBy };
        }

        // Check verified merchant list
        const userVerified = this.verifiedMerchants.get(transaction.userId);
        if (userVerified && userVerified.has(transaction.merchant)) {
            return { flag: 'GREEN', verifiedBy: 'auto-trust' };
        }

        // If fraud was detected
        if (hasFraudAlerts) {
            return { flag: 'RED' };
        }

        // Check if merchant has prior history (simplified: check all transactions)
        return { flag: 'ORANGE' };
    }

    /**
     * Process a single transaction through all three logics
     */
    processTransaction(transaction, userHistory, allMerchantHistory) {
        const alerts = [];

        // Logic 1: Threshold check
        const thresholdAlert = this.checkThreshold(transaction);
        if (thresholdAlert) alerts.push(thresholdAlert);

        // Logic 2: Recursive payment check
        const recursiveAlert = this.checkRecursivePayments(transaction, userHistory);
        if (recursiveAlert) alerts.push(recursiveAlert);

        // Logic 3: Merchant flag assignment
        const hasFraudAlerts = alerts.length > 0;

        // Check if merchant has prior transactions (known merchant = GREEN, new = ORANGE)
        const merchantHistory = allMerchantHistory.get(transaction.merchant) || [];
        const hasPrior = merchantHistory.some(tx => tx.id !== transaction.id);

        let flagInfo;
        const override = this.overrides.get(transaction.id);
        if (override && override.newFlag === 'GREEN') {
            flagInfo = { flag: 'GREEN', verifiedBy: override.verifiedBy };
        } else {
            const userVerified = this.verifiedMerchants.get(transaction.userId);
            if (userVerified && userVerified.has(transaction.merchant)) {
                flagInfo = { flag: 'GREEN', verifiedBy: 'auto-trust' };
            } else if (hasFraudAlerts) {
                flagInfo = { flag: 'RED' };
            } else if (hasPrior) {
                flagInfo = { flag: 'GREEN' };
            } else {
                flagInfo = { flag: 'ORANGE' };
            }
        }

        return {
            ...transaction,
            flag: flagInfo.flag,
            alerts,
            verifiedBy: flagInfo.verifiedBy || null,
        };
    }

    /**
     * Batch process all transactions
     */
    processBatch(transactions) {
        // Group by user for recursive detection
        const userTransactions = new Map();
        const merchantTransactions = new Map();

        for (const tx of transactions) {
            if (!userTransactions.has(tx.userId)) {
                userTransactions.set(tx.userId, []);
            }
            userTransactions.get(tx.userId).push(tx);

            if (!merchantTransactions.has(tx.merchant)) {
                merchantTransactions.set(tx.merchant, []);
            }
            merchantTransactions.get(tx.merchant).push(tx);
        }

        return transactions.map(transaction => {
            const userHistory = userTransactions.get(transaction.userId) || [];
            return this.processTransaction(transaction, userHistory, merchantTransactions);
        });
    }

    /**
     * Override a transaction's flag (ORANGE/RED → GREEN)
     */
    overrideTransactionFlag(transactionId, transaction, note) {
        if (!this.config.flags.allowUserOverride) return false;
        if (!transaction) return false;

        const currentFlag = transaction.flag;
        if (currentFlag !== 'ORANGE' && currentFlag !== 'RED') return false;

        this.overrides.set(transactionId, {
            transactionId,
            previousFlag: currentFlag,
            newFlag: 'GREEN',
            verifiedBy: transaction.userId || 'user',
            verifiedAt: new Date(),
            note: note || '',
        });

        // Add to verified merchants if auto-trust enabled
        if (this.config.flags.autoTrustAfterVerify) {
            if (!this.verifiedMerchants.has(transaction.userId)) {
                this.verifiedMerchants.set(transaction.userId, new Set());
            }
            this.verifiedMerchants.get(transaction.userId).add(transaction.merchant);
        }

        return true;
    }

    /**
     * Update configuration
     */
    updateConfig(newConfig) {
        this.config = { ...this.config, ...newConfig };
    }

    /**
     * Format currency value
     */
    formatCurrency(value) {
        return new Intl.NumberFormat('en-IN', {
            minimumFractionDigits: 2,
            maximumFractionDigits: 2,
        }).format(value);
    }

    /**
     * Generate summary statistics
     */
    generateSummary(flaggedTransactions) {
        const total = flaggedTransactions.length;
        const greenCount = flaggedTransactions.filter(t => t.flag === 'GREEN').length;
        const orangeCount = flaggedTransactions.filter(t => t.flag === 'ORANGE').length;
        const redCount = flaggedTransactions.filter(t => t.flag === 'RED').length;
        const totalAmount = flaggedTransactions.reduce((sum, t) => sum + t.amount, 0);

        const creditCount = flaggedTransactions.filter(t => t.type === 'credit').length;
        const debitCount = flaggedTransactions.filter(t => t.type === 'debit').length;
        const unknownCount = flaggedTransactions.filter(t => t.type === 'unknown').length;

        const creditAmount = flaggedTransactions.filter(t => t.type === 'credit').reduce((s, t) => s + t.amount, 0);
        const debitAmount = flaggedTransactions.filter(t => t.type === 'debit').reduce((s, t) => s + t.amount, 0);

        // Group by merchant for top merchants
        const merchantMap = new Map();
        for (const tx of flaggedTransactions) {
            if (!merchantMap.has(tx.merchant)) {
                merchantMap.set(tx.merchant, { count: 0, total: 0 });
            }
            const m = merchantMap.get(tx.merchant);
            m.count++;
            m.total += tx.amount;
        }

        const topMerchants = [...merchantMap.entries()]
            .sort((a, b) => b[1].total - a[1].total)
            .slice(0, 10);

        return {
            total,
            greenCount,
            orangeCount,
            redCount,
            totalAmount,
            creditCount,
            debitCount,
            unknownCount,
            creditAmount,
            debitAmount,
            topMerchants,
        };
    }
}

// Export for use in app.js
window.FraudDetectionEngine = FraudDetectionEngine;
