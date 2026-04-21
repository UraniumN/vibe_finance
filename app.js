/**
 * VibeFinance — Main Application Controller (Fraud Detection Page)
 * 
 * Handles UI rendering, event binding, charting, table management,
 * and integration with the FraudDetectionEngine.
 */

(function () {
    'use strict';

    // ==========================================
    // State
    // ==========================================

    let engine = null;
    let rawTransactions = [];
    let processedTransactions = [];
    let filteredTransactions = [];
    let currentSort = { field: null, direction: 'asc' };
    let currentPage = 1;
    const PAGE_SIZE = 25;
    let charts = {};

    // ==========================================
    // Initialization
    // ==========================================

    document.addEventListener('DOMContentLoaded', async () => {
        initTheme();
        initEngine();
        await loadTransactions();
        runDetection();
        bindEvents();
    });

    function initTheme() {
        const savedTheme = localStorage.getItem('vf-theme') || 'dark';
        document.documentElement.setAttribute('data-theme', savedTheme);

        const toggle = document.getElementById('theme-toggle');
        if (toggle) {
            toggle.addEventListener('click', () => {
                const current = document.documentElement.getAttribute('data-theme');
                const next = current === 'dark' ? 'light' : 'dark';
                document.documentElement.setAttribute('data-theme', next);
                localStorage.setItem('vf-theme', next);
                // Redraw charts with new theme colors
                if (processedTransactions.length > 0) {
                    renderCharts(processedTransactions);
                }
            });
        }
    }

    function initEngine() {
        engine = new FraudDetectionEngine({
            threshold: getConfigValue('config-threshold', 50000),
            recursion: {
                timeWindowHours: getConfigValue('config-time-window', 24),
                amountTolerancePercent: getConfigValue('config-tolerance', 5),
                repeatThreshold: getConfigValue('config-repeat', 3),
            },
            flags: {
                allowUserOverride: true,
                autoTrustAfterVerify: true,
            },
        });
    }

    function getConfigValue(id, defaultVal) {
        const el = document.getElementById(id);
        if (el) {
            const v = parseFloat(el.value);
            return isNaN(v) ? defaultVal : v;
        }
        return defaultVal;
    }

    // ==========================================
    // Data Loading
    // ==========================================

    async function loadTransactions() {
        showLoading(true);
        try {
            const response = await fetch('transactions.json');
            if (!response.ok) throw new Error(`HTTP ${response.status}`);
            rawTransactions = await response.json();
        } catch (err) {
            console.error('Failed to load transactions.json:', err);
            rawTransactions = [];
        }
        showLoading(false);
    }

    // ==========================================
    // Detection Pipeline
    // ==========================================

    function runDetection() {
        showLoading(true);

        // Re-init engine with current config
        initEngine();

        // Transform raw data
        const transactions = engine.transformRawData(rawTransactions);

        // Run fraud detection
        processedTransactions = engine.processBatch(transactions);

        // Apply filters
        applyFilters();

        // Render everything
        const summary = engine.generateSummary(processedTransactions);
        renderSummaryCards(summary);
        renderCharts(processedTransactions);
        renderTable();

        showLoading(false);
    }

    // ==========================================
    // Event Binding
    // ==========================================

    function bindEvents() {
        // Run detection button
        document.getElementById('run-detection-btn')?.addEventListener('click', () => {
            runDetection();
        });

        // Search input
        document.getElementById('search-input')?.addEventListener('input', debounce(() => {
            currentPage = 1;
            applyFilters();
            renderTable();
        }, 250));

        // Filter selects
        document.getElementById('filter-flag')?.addEventListener('change', () => {
            currentPage = 1;
            applyFilters();
            renderTable();
        });

        document.getElementById('filter-type')?.addEventListener('change', () => {
            currentPage = 1;
            applyFilters();
            renderTable();
        });

        // Sort headers
        document.querySelectorAll('.sortable').forEach(th => {
            th.addEventListener('click', () => {
                const field = th.dataset.sort;
                if (currentSort.field === field) {
                    currentSort.direction = currentSort.direction === 'asc' ? 'desc' : 'asc';
                } else {
                    currentSort.field = field;
                    currentSort.direction = 'asc';
                }
                // Update header classes
                document.querySelectorAll('.sortable').forEach(h => {
                    h.classList.remove('sort-asc', 'sort-desc');
                });
                th.classList.add(currentSort.direction === 'asc' ? 'sort-asc' : 'sort-desc');

                applyFilters();
                renderTable();
            });
        });

        // Modal
        document.getElementById('modal-close')?.addEventListener('click', hideModal);
        document.getElementById('modal-cancel')?.addEventListener('click', hideModal);
        document.getElementById('override-modal')?.addEventListener('click', (e) => {
            if (e.target.id === 'override-modal') hideModal();
        });
    }

    // ==========================================
    // Filtering & Sorting
    // ==========================================

    function applyFilters() {
        const searchTerm = (document.getElementById('search-input')?.value || '').toLowerCase().trim();
        const flagFilter = document.getElementById('filter-flag')?.value || 'all';
        const typeFilter = document.getElementById('filter-type')?.value || 'all';

        filteredTransactions = processedTransactions.filter(tx => {
            // Flag filter
            if (flagFilter !== 'all' && tx.flag !== flagFilter) return false;

            // Type filter
            if (typeFilter !== 'all' && tx.type !== typeFilter) return false;

            // Search filter
            if (searchTerm) {
                const searchFields = [
                    tx.id,
                    tx.merchant,
                    tx.sender,
                    tx.type,
                    tx.flag,
                    String(tx.amount),
                    tx.alerts.join(' '),
                ].join(' ').toLowerCase();
                if (!searchFields.includes(searchTerm)) return false;
            }

            return true;
        });

        // Sort
        if (currentSort.field) {
            const dir = currentSort.direction === 'asc' ? 1 : -1;
            filteredTransactions.sort((a, b) => {
                let valA = a[currentSort.field];
                let valB = b[currentSort.field];

                if (currentSort.field === 'amount' || currentSort.field === 'confidence') {
                    valA = Number(valA) || 0;
                    valB = Number(valB) || 0;
                } else if (currentSort.field === 'flag') {
                    const order = { RED: 3, ORANGE: 2, GREEN: 1 };
                    valA = order[valA] || 0;
                    valB = order[valB] || 0;
                } else {
                    valA = String(valA || '').toLowerCase();
                    valB = String(valB || '').toLowerCase();
                }

                if (valA < valB) return -1 * dir;
                if (valA > valB) return 1 * dir;
                return 0;
            });
        }
    }

    // ==========================================
    // Rendering: Summary Cards
    // ==========================================

    function renderSummaryCards(summary) {
        animateCountUp('total-count', summary.total);
        animateCountUp('green-count', summary.greenCount);
        animateCountUp('orange-count', summary.orangeCount);
        animateCountUp('red-count', summary.redCount);

        const amountEl = document.getElementById('total-amount');
        if (amountEl) {
            amountEl.textContent = `₹${engine.formatCurrency(summary.totalAmount)}`;
        }
    }

    function animateCountUp(elementId, target) {
        const el = document.getElementById(elementId);
        if (!el) return;

        const duration = 600;
        const start = parseInt(el.textContent) || 0;
        const startTime = performance.now();

        function update(currentTime) {
            const elapsed = currentTime - startTime;
            const progress = Math.min(elapsed / duration, 1);
            const eased = 1 - Math.pow(1 - progress, 3);
            el.textContent = Math.round(start + (target - start) * eased);
            if (progress < 1) requestAnimationFrame(update);
        }

        requestAnimationFrame(update);
    }

    // ==========================================
    // Rendering: Charts
    // ==========================================

    function renderCharts(transactions) {
        const style = getComputedStyle(document.documentElement);
        const green = style.getPropertyValue('--green').trim();
        const orange = style.getPropertyValue('--orange').trim();
        const red = style.getPropertyValue('--red').trim();
        const textSecondary = style.getPropertyValue('--text-secondary').trim();
        const borderColor = style.getPropertyValue('--border-color').trim();
        const blue = style.getPropertyValue('--blue').trim();
        const purple = style.getPropertyValue('--purple').trim();

        // Destroy existing charts
        Object.values(charts).forEach(c => c.destroy());
        charts = {};

        // Flag Distribution Pie Chart
        const flagCounts = {
            GREEN: transactions.filter(t => t.flag === 'GREEN').length,
            ORANGE: transactions.filter(t => t.flag === 'ORANGE').length,
            RED: transactions.filter(t => t.flag === 'RED').length,
        };

        const pieCtx = document.getElementById('flag-pie-chart')?.getContext('2d');
        if (pieCtx) {
            charts.pie = new Chart(pieCtx, {
                type: 'doughnut',
                data: {
                    labels: ['Safe (Green)', 'Suspicious (Orange)', 'Flagged (Red)'],
                    datasets: [{
                        data: [flagCounts.GREEN, flagCounts.ORANGE, flagCounts.RED],
                        backgroundColor: [green, orange, red],
                        borderWidth: 0,
                        hoverOffset: 8,
                    }],
                },
                options: {
                    responsive: true,
                    maintainAspectRatio: false,
                    cutout: '65%',
                    plugins: {
                        legend: {
                            position: 'bottom',
                            labels: {
                                color: textSecondary,
                                padding: 16,
                                usePointStyle: true,
                                pointStyleWidth: 10,
                                font: { family: "'Inter', sans-serif", size: 12 },
                            },
                        },
                    },
                },
            });
        }

        // Type Breakdown Bar Chart
        const typeCounts = {
            credit: transactions.filter(t => t.type === 'credit').length,
            debit: transactions.filter(t => t.type === 'debit').length,
            unknown: transactions.filter(t => t.type === 'unknown').length,
        };

        const barCtx = document.getElementById('type-bar-chart')?.getContext('2d');
        if (barCtx) {
            charts.bar = new Chart(barCtx, {
                type: 'bar',
                data: {
                    labels: ['Credit', 'Debit', 'Unknown'],
                    datasets: [{
                        label: 'Transactions',
                        data: [typeCounts.credit, typeCounts.debit, typeCounts.unknown],
                        backgroundColor: [green + '99', red + '99', purple + '99'],
                        borderColor: [green, red, purple],
                        borderWidth: 1,
                        borderRadius: 6,
                        maxBarThickness: 60,
                    }],
                },
                options: {
                    responsive: true,
                    maintainAspectRatio: false,
                    plugins: {
                        legend: { display: false },
                    },
                    scales: {
                        y: {
                            beginAtZero: true,
                            grid: { color: borderColor },
                            ticks: { color: textSecondary, font: { family: "'Inter', sans-serif", size: 11 } },
                        },
                        x: {
                            grid: { display: false },
                            ticks: { color: textSecondary, font: { family: "'Inter', sans-serif", size: 12 } },
                        },
                    },
                },
            });
        }

        // Amount Scatter Chart
        const scatterData = {
            GREEN: [],
            ORANGE: [],
            RED: [],
        };
        transactions.forEach((tx, i) => {
            scatterData[tx.flag].push({ x: i, y: tx.amount });
        });

        const scatterCtx = document.getElementById('amount-scatter-chart')?.getContext('2d');
        if (scatterCtx) {
            charts.scatter = new Chart(scatterCtx, {
                type: 'scatter',
                data: {
                    datasets: [
                        {
                            label: 'Safe',
                            data: scatterData.GREEN,
                            backgroundColor: green + '80',
                            pointRadius: 3,
                            pointHoverRadius: 6,
                        },
                        {
                            label: 'Suspicious',
                            data: scatterData.ORANGE,
                            backgroundColor: orange + '80',
                            pointRadius: 4,
                            pointHoverRadius: 7,
                        },
                        {
                            label: 'Flagged',
                            data: scatterData.RED,
                            backgroundColor: red + '80',
                            pointRadius: 5,
                            pointHoverRadius: 8,
                        },
                    ],
                },
                options: {
                    responsive: true,
                    maintainAspectRatio: false,
                    plugins: {
                        legend: {
                            position: 'bottom',
                            labels: {
                                color: textSecondary,
                                padding: 16,
                                usePointStyle: true,
                                font: { family: "'Inter', sans-serif", size: 12 },
                            },
                        },
                        tooltip: {
                            callbacks: {
                                label: (ctx) => `₹${ctx.parsed.y.toFixed(2)}`,
                            },
                        },
                    },
                    scales: {
                        y: {
                            beginAtZero: true,
                            title: {
                                display: true,
                                text: 'Amount (₹)',
                                color: textSecondary,
                                font: { family: "'Inter', sans-serif", size: 12 },
                            },
                            grid: { color: borderColor },
                            ticks: { color: textSecondary, font: { size: 11 } },
                        },
                        x: {
                            title: {
                                display: true,
                                text: 'Transaction Index',
                                color: textSecondary,
                                font: { family: "'Inter', sans-serif", size: 12 },
                            },
                            grid: { display: false },
                            ticks: { color: textSecondary, font: { size: 11 } },
                        },
                    },
                },
            });
        }
    }

    // ==========================================
    // Rendering: Transaction Table
    // ==========================================

    function renderTable() {
        const tbody = document.getElementById('table-body');
        if (!tbody) return;

        const startIdx = (currentPage - 1) * PAGE_SIZE;
        const endIdx = startIdx + PAGE_SIZE;
        const pageTransactions = filteredTransactions.slice(startIdx, endIdx);

        tbody.innerHTML = pageTransactions.map(tx => {
            const flagClass = tx.flag.toLowerCase();
            const flagEmoji = { GREEN: '🟢', ORANGE: '🟠', RED: '🔴' }[tx.flag];
            const typeClass = tx.type;

            const alertsHtml = tx.alerts.length > 0
                ? `<ul class="alert-list">${tx.alerts.map(a => `<li>${escapeHtml(a)}</li>`).join('')}</ul>`
                : '<span style="color:var(--text-muted);font-size:11px;">None</span>';

            const confidenceColor = tx.confidence >= 0.7 ? 'var(--green)' :
                tx.confidence >= 0.4 ? 'var(--orange)' : 'var(--red)';

            const overrideBtn = (tx.flag === 'ORANGE' || tx.flag === 'RED')
                ? `<button class="btn-override" data-tx-id="${tx.id}" onclick="window.showOverrideModal('${tx.id}')">Verify</button>`
                : tx.verifiedBy ? `<span style="font-size:11px;color:var(--green);">✓ Verified</span>` : '—';

            return `
                <tr class="fade-in">
                    <td style="font-family:var(--font-mono);font-size:12px;color:var(--text-muted);">${tx.id}</td>
                    <td><span class="flag-badge ${flagClass}">${flagEmoji} ${tx.flag}</span></td>
                    <td class="amount-cell">₹${engine.formatCurrency(tx.amount)}</td>
                    <td><span class="type-badge ${typeClass}">${tx.type}</span></td>
                    <td>${escapeHtml(tx.merchant === 'UNKNOWN_MERCHANT' ? '—' : tx.merchant)}</td>
                    <td style="color:var(--text-secondary);">${escapeHtml(tx.sender)}</td>
                    <td>
                        <div class="confidence-bar">
                            <div class="confidence-track">
                                <div class="confidence-fill" style="width:${tx.confidence * 100}%;background:${confidenceColor};"></div>
                            </div>
                            <span class="confidence-value">${(tx.confidence * 100).toFixed(0)}%</span>
                        </div>
                    </td>
                    <td>${alertsHtml}</td>
                    <td>${overrideBtn}</td>
                </tr>
            `;
        }).join('');

        // Update info
        const totalFiltered = filteredTransactions.length;
        const showing = Math.min(endIdx, totalFiltered);
        const infoEl = document.getElementById('table-info');
        if (infoEl) {
            infoEl.textContent = `Showing ${startIdx + 1}–${showing} of ${totalFiltered}`;
        }

        // Render pagination
        renderPagination(totalFiltered);
    }

    function renderPagination(totalItems) {
        const container = document.getElementById('pagination');
        if (!container) return;

        const totalPages = Math.ceil(totalItems / PAGE_SIZE);
        if (totalPages <= 1) {
            container.innerHTML = '';
            return;
        }

        let html = '';

        // Previous
        if (currentPage > 1) {
            html += `<button onclick="window.goToPage(${currentPage - 1})">‹</button>`;
        }

        // Page numbers
        const maxVisible = 5;
        let startPage = Math.max(1, currentPage - Math.floor(maxVisible / 2));
        let endPage = Math.min(totalPages, startPage + maxVisible - 1);
        if (endPage - startPage < maxVisible - 1) {
            startPage = Math.max(1, endPage - maxVisible + 1);
        }

        if (startPage > 1) {
            html += `<button onclick="window.goToPage(1)">1</button>`;
            if (startPage > 2) html += `<button disabled>…</button>`;
        }

        for (let i = startPage; i <= endPage; i++) {
            html += `<button class="${i === currentPage ? 'active' : ''}" onclick="window.goToPage(${i})">${i}</button>`;
        }

        if (endPage < totalPages) {
            if (endPage < totalPages - 1) html += `<button disabled>…</button>`;
            html += `<button onclick="window.goToPage(${totalPages})">${totalPages}</button>`;
        }

        // Next
        if (currentPage < totalPages) {
            html += `<button onclick="window.goToPage(${currentPage + 1})">›</button>`;
        }

        container.innerHTML = html;
    }

    // ==========================================
    // Override Modal
    // ==========================================

    window.showOverrideModal = function (txId) {
        const tx = processedTransactions.find(t => t.id === txId);
        if (!tx) return;

        const modal = document.getElementById('override-modal');
        document.getElementById('modal-tx-id').textContent = txId;
        document.getElementById('modal-current-flag').innerHTML = `<span class="flag-badge ${tx.flag.toLowerCase()}">${tx.flag}</span>`;
        document.getElementById('modal-amount').textContent = `₹${engine.formatCurrency(tx.amount)}`;
        document.getElementById('modal-note').value = '';

        modal.classList.add('visible');

        // Bind confirm
        const confirmBtn = document.getElementById('modal-confirm');
        const newConfirmBtn = confirmBtn.cloneNode(true);
        confirmBtn.parentNode.replaceChild(newConfirmBtn, confirmBtn);
        newConfirmBtn.addEventListener('click', () => {
            const note = document.getElementById('modal-note').value;
            engine.overrideTransactionFlag(txId, tx, note);

            // Re-process all transactions
            const transactions = engine.transformRawData(rawTransactions);
            processedTransactions = engine.processBatch(transactions);
            applyFilters();

            const summary = engine.generateSummary(processedTransactions);
            renderSummaryCards(summary);
            renderCharts(processedTransactions);
            renderTable();

            hideModal();
        });
    };

    function hideModal() {
        document.getElementById('override-modal')?.classList.remove('visible');
    }

    // ==========================================
    // Pagination (global)
    // ==========================================

    window.goToPage = function (page) {
        currentPage = page;
        renderTable();
        // Scroll to table
        document.getElementById('table-section')?.scrollIntoView({ behavior: 'smooth', block: 'start' });
    };

    // ==========================================
    // Utilities
    // ==========================================

    function showLoading(show) {
        const overlay = document.getElementById('loading-overlay');
        if (overlay) {
            if (show) overlay.classList.add('visible');
            else overlay.classList.remove('visible');
        }
    }

    function escapeHtml(str) {
        if (!str) return '';
        const div = document.createElement('div');
        div.textContent = String(str);
        return div.innerHTML;
    }

    function debounce(fn, delay) {
        let timer;
        return function (...args) {
            clearTimeout(timer);
            timer = setTimeout(() => fn.apply(this, args), delay);
        };
    }
})();
