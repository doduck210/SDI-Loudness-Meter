(function () {
    const STORAGE_KEY = 'sdilm.dashboard.layout.v1';
    const DEFAULT_LAYOUT = [
        { id: 'levels', x: 0, y: 0, w: 3, h: 4 },
        { id: 'lkfsDisplay', x: 3, y: 0, w: 2, h: 3 },
        { id: 'lkfsBars', x: 5, y: 0, w: 2, h: 4 },
        { id: 'vectorscope', x: 0, y: 4, w: 3, h: 4 },
        { id: 'correlation', x: 3, y: 3, w: 2, h: 2 },
        { id: 'lra', x: 5, y: 3, w: 2, h: 2 },
        { id: 'eq', x: 3, y: 5, w: 4, h: 4 },
        { id: 'systemStats', x: 7, y: 0, w: 2, h: 2 }
    ];

    const MIN_DB = -60;
    const MAX_DB = 0;
    const MIN_LKFS = -40;
    const MAX_LKFS = -18;
    const MIN_DB_EQ = -40;
    const MAX_DB_EQ = 5;
    const NUM_EQ_BANDS = 64;
    const LRA_MAX = 25;
    const LEVEL_SCALE_POINTS = [0, -6, -12, -18, -24, -30, -40, -50, -60];
    const LKFS_SCALE_POINTS = [-18, -20, -22, -24, -26, -30, -35, -40];
    const FALL_RATE = 15;
    const LKFS_FALL_RATE = FALL_RATE * (MAX_LKFS - MIN_LKFS) / (MAX_DB - MIN_DB);
    const CORR_FALL_RATE = 2.0;

    const socketController = { ws: null };

    class DataBus {
        constructor() {
            this.listeners = new Map();
            this.cache = new Map();
        }

        publish(topic, payload) {
            this.cache.set(topic, payload);
            const listeners = this.listeners.get(topic);
            if (!listeners) return;
            listeners.forEach(cb => {
                try {
                    cb(payload);
                } catch (err) {
                    console.error('DataBus listener error for', topic, err);
                }
            });
        }

        subscribe(topic, cb) {
            if (!this.listeners.has(topic)) {
                this.listeners.set(topic, new Set());
            }
            const set = this.listeners.get(topic);
            set.add(cb);
            if (this.cache.has(topic)) {
                cb(this.cache.get(topic));
            }
            return () => set.delete(cb);
        }
    }

    const dataBus = new DataBus();

    const animationState = {
        meters: {
            left: { latestValue: MIN_DB, displayValue: MIN_DB },
            right: { latestValue: MIN_DB, displayValue: MIN_DB }
        },
        lkfs: {
            momentary: { latestValue: MIN_LKFS, displayValue: MIN_LKFS, label: '-inf' },
            shortTerm: { latestValue: MIN_LKFS, displayValue: MIN_LKFS, label: '-inf' },
            integrated: { latestValue: MIN_LKFS, displayValue: MIN_LKFS, label: '-inf' }
        },
        eq: {
            bands: Array.from({ length: NUM_EQ_BANDS }, () => ({
                latestValue: MIN_DB_EQ,
                displayValue: MIN_DB_EQ
            }))
        },
        correlator: { latestValue: 0, displayValue: 0 }
    };

    const uiRefs = {
        meters: null,
        lkfsDisplay: null,
        lkfsBars: null,
        eq: null,
        correlator: null
    };

    function clamp(value, min, max) {
        return Math.min(max, Math.max(min, value));
    }

    function dbToPercentage(db) {
        if (!Number.isFinite(db)) return 0;
        return clamp((db - MIN_DB) / (MAX_DB - MIN_DB), 0, 1);
    }

    function lkfsDbToPercentage(db) {
        if (!Number.isFinite(db)) return 0;
        return clamp((db - MIN_LKFS) / (MAX_LKFS - MIN_LKFS), 0, 1);
    }

    function createScale(container, scalePoints, mapper) {
        if (!container) return;
        container.innerHTML = '';
        scalePoints.forEach(db => {
            const mark = document.createElement('div');
            mark.className = 'scale-mark';
            mark.style.bottom = `${mapper(db) * 100}%`;
            mark.innerHTML = `<span>${db}</span>`;
            container.appendChild(mark);
        });
    }

    function applyMeterColor(element, db) {
        if (!element) return;
        if (db > -6) element.style.backgroundColor = '#e74c3c';
        else if (db > -12) element.style.backgroundColor = '#f1c40f';
        else element.style.backgroundColor = '#27ae60';
    }

    function updateLkfsMeter(fillElement, dbValue) {
        if (!fillElement) return;
        const percentage = lkfsDbToPercentage(dbValue) * 100;
        fillElement.style.height = `${percentage}%`;
        fillElement.style.backgroundColor = Number.isFinite(dbValue) && dbValue >= -22 ? '#e74c3c' : '#27ae60';
    }

    function debounce(fn, wait = 200) {
        let timeout;
        return function (...args) {
            clearTimeout(timeout);
            timeout = setTimeout(() => fn.apply(this, args), wait);
        };
    }

    const widgetRegistry = {
        levels: {
            title: 'Levels',
            description: 'Stereo peak meters',
            defaultSize: { w: 3, h: 4 },
            minW: 2,
            minH: 3,
            mount(root) {
                root.innerHTML = `
                    <div class="widget-container levels-widget-container">
                        <div class="level-meter-container">
                            <div class="scale-container" data-role="scale"></div>
                            <div class="level-meter">
                                <div class="meter-fill" data-role="left-fill"></div>
                                <span class="meter-current-value" data-role="left-value">-inf</span>
                                <span class="meter-label">L</span>
                            </div>
                            <div class="level-meter">
                                <div class="meter-fill" data-role="right-fill"></div>
                                <span class="meter-current-value" data-role="right-value">-inf</span>
                                <span class="meter-label">R</span>
                            </div>
                        </div>
                    </div>
                `;
                const refs = {
                    leftFill: root.querySelector('[data-role="left-fill"]'),
                    rightFill: root.querySelector('[data-role="right-fill"]'),
                    leftValue: root.querySelector('[data-role="left-value"]'),
                    rightValue: root.querySelector('[data-role="right-value"]')
                };
                createScale(root.querySelector('[data-role="scale"]'), LEVEL_SCALE_POINTS, dbToPercentage);
                uiRefs.meters = refs;
                return () => {
                    if (uiRefs.meters === refs) uiRefs.meters = null;
                };
            }
        },
        lkfsDisplay: {
            title: 'LKFS',
            description: 'Momentary / Short / Integrated readout',
            defaultSize: { w: 2, h: 2 },
            minW: 2,
            minH: 2,
            mount(root, context) {
                root.innerHTML = `
                    <div class="widget-container lkfs-widget-container">
                        <div class="lkfs-display">
                            <div class="lkfs-row">
                                <span class="lkfs-label">M :</span>
                                <span class="lkfs-value" data-role="momentary-value">-inf</span>
                                <button class="placeholder-button">Start</button>
                            </div>
                            <div class="lkfs-row">
                                <span class="lkfs-label">S :</span>
                                <span class="lkfs-value" data-role="short-value">-inf</span>
                                <button class="placeholder-button">Start</button>
                            </div>
                            <div class="lkfs-row">
                                <span class="lkfs-label">I :</span>
                                <span class="lkfs-value" data-role="integrated-value">-inf</span>
                                <button class="integration-toggle" data-role="integration-toggle">Start</button>
                            </div>
                        </div>
                    </div>
                `;

                const valueRefs = {
                    momentary: root.querySelector('[data-role="momentary-value"]'),
                    shortTerm: root.querySelector('[data-role="short-value"]'),
                    integrated: root.querySelector('[data-role="integrated-value"]')
                };
                const toggleBtn = root.querySelector('[data-role="integration-toggle"]');
                uiRefs.lkfsDisplay = { values: valueRefs };

                const updateIntegrationUi = data => {
                    const active = !!data?.is_integrating;
                    toggleBtn.textContent = active ? 'Stop' : 'Start';
                    toggleBtn.style.backgroundColor = active ? '#e74c3c' : '#34495e';
                    toggleBtn.dataset.integrating = active ? '1' : '0';
                };
                const unsubIntegration = dataBus.subscribe('integration_state', updateIntegrationUi);

                const handleClick = () => {
                    const active = toggleBtn.dataset.integrating === '1';
                    context.sendCommand({
                        command: active ? 'stop_integration' : 'start_integration'
                    });
                };
                toggleBtn.addEventListener('click', handleClick);

                return () => {
                    toggleBtn.removeEventListener('click', handleClick);
                    unsubIntegration();
                    if (uiRefs.lkfsDisplay && uiRefs.lkfsDisplay.values === valueRefs) {
                        uiRefs.lkfsDisplay = null;
                    }
                };
            }
        },
        lkfsBars: {
            title: 'LKFS Bar',
            description: 'Momentary / Short / Integrated bars',
            defaultSize: { w: 2, h: 4 },
            minW: 2,
            minH: 3,
            mount(root) {
                root.innerHTML = `
                    <div class="widget-container lkfs-bar-widget-container">
                        <div class="lkfs-bar-display">
                            <div class="lkfs-bar-meter-container">
                                <div class="lkfs-bar-scale" data-role="lkfs-scale"></div>
                                <div class="level-meter" data-kind="momentary">
                                    <div class="meter-fill" data-role="momentary-bar"></div>
                                    <span class="meter-current-value" data-role="momentary-label">-inf</span>
                                    <span class="meter-label">M</span>
                                </div>
                                <div class="level-meter" data-kind="shortTerm">
                                    <div class="meter-fill" data-role="short-bar"></div>
                                    <span class="meter-current-value" data-role="short-label">-inf</span>
                                    <span class="meter-label">S</span>
                                </div>
                                <div class="level-meter" data-kind="integrated">
                                    <div class="meter-fill" data-role="integrated-bar"></div>
                                    <span class="meter-current-value" data-role="integrated-label">-inf</span>
                                    <span class="meter-label">I</span>
                                </div>
                            </div>
                        </div>
                    </div>
                `;

                const refs = {
                    bars: {
                        momentary: root.querySelector('[data-role="momentary-bar"]'),
                        shortTerm: root.querySelector('[data-role="short-bar"]'),
                        integrated: root.querySelector('[data-role="integrated-bar"]')
                    },
                    labels: {
                        momentary: root.querySelector('[data-role="momentary-label"]'),
                        shortTerm: root.querySelector('[data-role="short-label"]'),
                        integrated: root.querySelector('[data-role="integrated-label"]')
                    }
                };
                createScale(root.querySelector('[data-role="lkfs-scale"]'), LKFS_SCALE_POINTS, lkfsDbToPercentage);
                uiRefs.lkfsBars = refs;

                return () => {
                    if (uiRefs.lkfsBars === refs) uiRefs.lkfsBars = null;
                };
            }
        },
        vectorscope: {
            title: 'Vectorscope',
            description: 'Live luma/chroma vectorscope feed',
            defaultSize: { w: 3, h: 3 },
            minW: 2,
            minH: 2,
            mount(root) {
                root.innerHTML = `
                    <div class="widget-container">
                        <div class="vectorscope-container">
                            <img alt="Vectorscope Stream">
                        </div>
                    </div>
                `;
                const img = root.querySelector('img');
                let objectUrl = null;

                const unsubscribe = dataBus.subscribe('vectorscope_frame', blob => {
                    if (!blob) return;
                    if (objectUrl) URL.revokeObjectURL(objectUrl);
                    objectUrl = URL.createObjectURL(blob);
                    img.src = objectUrl;
                });

                return () => {
                    unsubscribe();
                    if (objectUrl) {
                        URL.revokeObjectURL(objectUrl);
                        objectUrl = null;
                    }
                };
            }
        },
        systemStats: {
            title: 'Status',
            description: 'CPU and memory telemetry',
            defaultSize: { w: 2, h: 2 },
            minW: 2,
            minH: 1,
            mount(root) {
                root.innerHTML = `
                    <div class="widget-container">
                        <div class="status-panel">
                            <div class="status-row">
                                <span>CPU:</span>
                                <span data-role="cpu">-</span>
                            </div>
                            <div class="status-row">
                                <span>Memory:</span>
                                <span data-role="mem">-</span>
                            </div>
                        </div>
                    </div>
                `;

                const cpuEl = root.querySelector('[data-role="cpu"]');
                const memEl = root.querySelector('[data-role="mem"]');

                const unsubscribe = dataBus.subscribe('system_stats', stats => {
                    if (!stats) return;
                    cpuEl.textContent = `${stats.cpu.toFixed(1)}%`;
                    const used = stats.memory.used / (1024 ** 3);
                    const total = stats.memory.total / (1024 ** 3);
                    memEl.innerHTML = `${stats.memory.percent.toFixed(1)}%<br><small>(${used.toFixed(2)}/${total.toFixed(2)} GB)</small>`;
                });

                return () => unsubscribe();
            }
        },
        correlation: {
            title: 'Correlator',
            description: 'Stereo phase correlation meter',
            defaultSize: { w: 2, h: 1 },
            minW: 2,
            minH: 1,
            mount(root) {
                root.innerHTML = `
                    <div class="widget-container">
                        <div class="correlator-container">
                            <div class="correlator-bar" data-role="bar"></div>
                        </div>
                        <div class="correlator-scale">
                            <span>-</span>
                            <span>0</span>
                            <span>+</span>
                        </div>
                    </div>
                `;
                const refs = { bar: root.querySelector('[data-role="bar"]') };
                uiRefs.correlator = refs;
                return () => {
                    if (uiRefs.correlator === refs) uiRefs.correlator = null;
                };
            }
        },
        eq: {
            title: 'EQ Meter',
            description: '64-band loudness history',
            defaultSize: { w: 4, h: 4 },
            minW: 3,
            minH: 3,
            mount(root) {
                const container = document.createElement('div');
                container.className = 'widget-container eq-widget-container';
                container.innerHTML = `
                    <canvas class="eq-canvas" width="500" height="250"></canvas>
                `;
                root.appendChild(container);

                const canvas = container.querySelector('canvas');
                const ctx = canvas.getContext('2d');
                uiRefs.eq = { canvas, ctx };

                const resize = () => {
                    const rect = container.getBoundingClientRect();
                    canvas.width = Math.max(300, rect.width - 24);
                    canvas.height = Math.max(200, rect.height - 24);
                    drawEq();
                };
                resize();

                let resizeObserver = null;
                if (typeof ResizeObserver !== 'undefined') {
                    resizeObserver = new ResizeObserver(resize);
                    resizeObserver.observe(container);
                }

                return () => {
                    if (resizeObserver) resizeObserver.disconnect();
                    if (uiRefs.eq && uiRefs.eq.canvas === canvas) {
                        uiRefs.eq = null;
                    }
                };
            }
        },
        lra: {
            title: 'LRA',
            description: 'Loudness range',
            defaultSize: { w: 2, h: 2 },
            minW: 2,
            minH: 1,
            mount(root) {
                root.innerHTML = `
                    <div class="widget-container lkfs-widget-container">
                        <div class="lra-display">
                            <div class="lkfs-row">
                                <div style="flex-basis: 100%;">
                                    <div style="display: flex; justify-content: space-between; align-items: center; font-size: 0.8em;">
                                        <span class="lkfs-label">LRA:</span>
                                        <span class="lkfs-value" data-role="lra-value" style="font-size: 1em;">0.0</span>
                                    </div>
                                    <div class="lra-bar-container">
                                        <div class="lra-bar" data-role="lra-bar"></div>
                                    </div>
                                </div>
                            </div>
                        </div>
                    </div>
                `;
                const valueEl = root.querySelector('[data-role="lra-value"]');
                const barEl = root.querySelector('[data-role="lra-bar"]');

                const unsubscribe = dataBus.subscribe('lra', payload => {
                    const value = payload?.value ?? 0;
                    valueEl.textContent = value.toFixed(1);
                    const pct = clamp(value / LRA_MAX, 0, 1) * 100;
                    barEl.style.width = `${pct}%`;
                });

                return () => unsubscribe();
            }
        }
    };

    const widgetInstances = new Map();
    let grid;

    document.addEventListener('DOMContentLoaded', () => {
        const gridElement = document.querySelector('#dashboardGrid');
        if (!gridElement || !window.GridStack) {
            console.error('GridStack not available or grid container missing.');
            return;
        }

        grid = GridStack.init({
            float: true,
            cellHeight: 110,
            column: 12,
            margin: 8,
            disableOneColumnMode: false,
            animate: true
        }, gridElement);

        const debouncedSave = debounce(saveLayout, 300);
        grid.on('change', debouncedSave);
        grid.on('added', debouncedSave);
        grid.on('removed', debouncedSave);

        setupControls();
        loadLayout();
        updateWidgetPickerState();
        toggleEmptyState(document.getElementById('emptyState'));
        setupWebSocket();
        requestAnimationFrame(animationLoop);
    });

    function setupControls() {
        const select = document.getElementById('widgetSelect');
        const addBtn = document.getElementById('addWidgetBtn');
        const resetBtn = document.getElementById('resetLayoutBtn');
        const emptyState = document.getElementById('emptyState');
        const handleSelectChange = () => {
            if (addBtn) addBtn.disabled = !select.value;
        };

        Object.entries(widgetRegistry).forEach(([id, def]) => {
            const option = document.createElement('option');
            option.value = id;
            option.textContent = def.title;
            select.appendChild(option);
        });

        select.addEventListener('change', handleSelectChange);

        addBtn.addEventListener('click', () => {
            const widgetId = select.value;
            if (!widgetId) return;
            addWidget(widgetId);
            select.value = '';
            updateWidgetPickerState();
            toggleEmptyState(emptyState);
            handleSelectChange();
        });

        resetBtn.addEventListener('click', () => {
            if (!confirm('레이아웃을 초기화할까요?')) return;
            removeAllWidgets();
            DEFAULT_LAYOUT.forEach(node => addWidget(node.id, node));
            saveLayout();
            updateWidgetPickerState();
            toggleEmptyState(emptyState);
            handleSelectChange();
        });

        updateWidgetPickerState();
        toggleEmptyState(emptyState);
        handleSelectChange();
    }

    function addWidget(widgetId, layout = {}) {
        if (!grid || widgetInstances.has(widgetId)) return;
        const def = widgetRegistry[widgetId];
        if (!def) return;

        const el = document.createElement('div');
        el.className = 'grid-stack-item';
        el.dataset.widgetId = widgetId;

        const content = document.createElement('div');
        content.className = 'grid-stack-item-content legacy-widget-shell';
        const removeBtn = document.createElement('button');
        removeBtn.type = 'button';
        removeBtn.className = 'widget-remove';
        removeBtn.innerHTML = '✕';
        const body = document.createElement('div');
        body.className = 'legacy-widget-body';
        content.appendChild(removeBtn);
        content.appendChild(body);
        el.appendChild(content);

        grid.addWidget(el, {
            x: layout.x,
            y: layout.y,
            w: layout.w ?? def.defaultSize.w,
            h: layout.h ?? def.defaultSize.h,
            minW: def.minW,
            minH: def.minH
        });

        const destroy = def.mount(body, {
            dataBus,
            sendCommand
        }) || (() => { });

        widgetInstances.set(widgetId, { el, destroy });
        removeBtn.addEventListener('click', () => removeWidget(widgetId));
    }

    function removeWidget(widgetId) {
        const instance = widgetInstances.get(widgetId);
        if (!instance) return;
        instance.destroy();
        grid.removeWidget(instance.el);
        widgetInstances.delete(widgetId);
        updateWidgetPickerState();
        toggleEmptyState(document.getElementById('emptyState'));
        saveLayout();
    }

    function removeAllWidgets() {
        Array.from(widgetInstances.keys()).forEach(id => removeWidget(id));
    }

    function updateWidgetPickerState() {
        const select = document.getElementById('widgetSelect');
        if (!select) return;
        Array.from(select.options).forEach(option => {
            if (!option.value) return;
            option.disabled = widgetInstances.has(option.value);
        });
    }

    function toggleEmptyState(emptyState) {
        if (!emptyState) return;
        emptyState.hidden = widgetInstances.size > 0;
    }

    function saveLayout() {
        if (!grid) return;
        const layout = [];
        grid.engine.nodes.forEach(node => {
            layout.push({
                id: node.el.dataset.widgetId,
                x: node.x,
                y: node.y,
                w: node.w,
                h: node.h
            });
        });
        localStorage.setItem(STORAGE_KEY, JSON.stringify(layout));
    }

    function loadLayout() {
        let saved = [];
        try {
            saved = JSON.parse(localStorage.getItem(STORAGE_KEY) || '[]');
        } catch (err) {
            console.warn('Failed to parse saved layout, using defaults.', err);
        }
        const layout = Array.isArray(saved) && saved.length ? saved : DEFAULT_LAYOUT;
        layout.forEach(node => addWidget(node.id, node));
    }

    function sendCommand(payload) {
        if (!socketController.ws || socketController.ws.readyState !== WebSocket.OPEN) {
            console.warn('WebSocket not ready for command', payload);
            return;
        }
        socketController.ws.send(JSON.stringify(payload));
    }

    function setupWebSocket() {
        const ws = new WebSocket(`ws://${window.location.host}/?role=sub&page=audio`);
        ws.binaryType = 'blob';
        socketController.ws = ws;

        ws.onopen = () => {
            ws.send(JSON.stringify({ command: 'get_settings' }));
            dataBus.publish('connection_state', { status: 'open' });
        };

        ws.onmessage = event => {
            if (typeof event.data !== 'string') {
                const blob = event.data instanceof Blob ? event.data : new Blob([event.data], { type: 'image/jpeg' });
                dataBus.publish('vectorscope_frame', blob);
                return;
            }

            let data;
            try {
                data = JSON.parse(event.data);
            } catch (err) {
                console.error('Failed to parse message', err);
                return;
            }

            switch (data.type) {
                case 'levels':
                    updateLevelState(data);
                    break;
                case 'system_stats':
                    dataBus.publish('system_stats', data);
                    break;
                case 'integration_state':
                    dataBus.publish('integration_state', data);
                    break;
                case 'correlation':
                    animationState.correlator.latestValue = clamp(data.value ?? 0, -1, 1);
                    break;
                case 'eq':
                    updateEqState(data.data);
                    break;
                case 'lkfs':
                    updateLkfsState('momentary', data.value);
                    break;
                case 's_lkfs':
                    updateLkfsState('shortTerm', data.value);
                    break;
                case 'i_lkfs':
                    updateLkfsState('integrated', data.value);
                    break;
                case 'lra':
                    dataBus.publish('lra', data);
                    break;
                case 'settings':
                    dataBus.publish('settings', data);
                    break;
                default:
                    break;
            }
        };

        ws.onerror = err => {
            console.error('WebSocket error', err);
            dataBus.publish('connection_state', { status: 'error', error: err });
        };

        ws.onclose = () => {
            dataBus.publish('connection_state', { status: 'closed' });
            setTimeout(setupWebSocket, 3000);
        };

        window.addEventListener('beforeunload', () => {
            ws.close();
        });
    }

    function updateLevelState(data) {
        const left = Number.isFinite(data.left) ? data.left : MIN_DB;
        const right = Number.isFinite(data.right) ? data.right : MIN_DB;
        animationState.meters.left.latestValue = left;
        animationState.meters.right.latestValue = right;
    }

    function updateLkfsState(key, value) {
        const entry = animationState.lkfs[key];
        if (!entry) return;
        if (Number.isFinite(value)) {
            const clamped = clamp(value, MIN_LKFS, MAX_LKFS);
            entry.latestValue = clamped;
            entry.label = value.toFixed(2);
        } else {
            entry.latestValue = MIN_LKFS;
            entry.displayValue = MIN_LKFS;
            entry.label = '-inf';
        }
    }

    function updateEqState(bands) {
        if (!Array.isArray(bands)) return;
        const stateBands = animationState.eq.bands;
        for (let i = 0; i < NUM_EQ_BANDS; i++) {
            if (bands[i] !== undefined) {
                const value = clamp(bands[i], MIN_DB_EQ, MAX_DB_EQ);
                stateBands[i].latestValue = value;
            }
        }
    }

    let lastFrameTime = performance.now();

    function animationLoop(currentTime) {
        const deltaSeconds = (currentTime - lastFrameTime) / 1000;
        lastFrameTime = currentTime;

        updateMeters(deltaSeconds);
        updateLkfs(deltaSeconds);
        updateEq(deltaSeconds);
        updateCorrelator(deltaSeconds);

        requestAnimationFrame(animationLoop);
    }

    function updateMeters(deltaSeconds) {
        const refs = uiRefs.meters;
        if (!refs) return;

        ['left', 'right'].forEach(channel => {
            const entry = animationState.meters[channel];
            if (entry.latestValue > entry.displayValue) entry.displayValue = entry.latestValue;
            else entry.displayValue = Math.max(entry.displayValue - FALL_RATE * deltaSeconds, MIN_DB);

            const fill = channel === 'left' ? refs.leftFill : refs.rightFill;
            const valueEl = channel === 'left' ? refs.leftValue : refs.rightValue;
            if (fill) {
                fill.style.height = `${dbToPercentage(entry.displayValue) * 100}%`;
                applyMeterColor(fill, entry.displayValue);
            }
            if (valueEl) valueEl.textContent = entry.displayValue.toFixed(1);
        });
    }

    function updateLkfs(deltaSeconds) {
        const displayRefs = uiRefs.lkfsDisplay;
        const barRefs = uiRefs.lkfsBars;

        Object.keys(animationState.lkfs).forEach(key => {
            const entry = animationState.lkfs[key];
            if (entry.latestValue > entry.displayValue) entry.displayValue = entry.latestValue;
            else entry.displayValue = Math.max(entry.displayValue - LKFS_FALL_RATE * deltaSeconds, MIN_LKFS);

            if (displayRefs?.values[key]) {
                displayRefs.values[key].textContent = Number.isFinite(entry.displayValue) ? entry.displayValue.toFixed(2) : '-inf';
            }
            if (barRefs?.bars[key]) {
                updateLkfsMeter(barRefs.bars[key], entry.displayValue);
            }
            if (barRefs?.labels[key]) {
                barRefs.labels[key].textContent = Number.isFinite(entry.displayValue) ? entry.displayValue.toFixed(1) : '-inf';
            }
        });
    }

    function updateEq(deltaSeconds) {
        const bands = animationState.eq.bands;
        for (let i = 0; i < NUM_EQ_BANDS; i++) {
            const band = bands[i];
            if (band.latestValue > band.displayValue) band.displayValue = band.latestValue;
            else band.displayValue = Math.max(band.displayValue - FALL_RATE * deltaSeconds, MIN_DB_EQ);
        }
        drawEq();
    }

    function drawEq() {
        const refs = uiRefs.eq;
        if (!refs) return;
        const { canvas, ctx } = refs;
        const axisYWidth = 30;
        const axisXHeight = 20;
        const meterWidth = Math.max(10, canvas.width - axisYWidth);
        const meterHeight = Math.max(10, canvas.height - axisXHeight);

        ctx.clearRect(0, 0, canvas.width, canvas.height);
        ctx.save();
        ctx.fillStyle = '#1c2833';
        ctx.fillRect(0, 0, canvas.width, canvas.height);
        ctx.translate(axisYWidth, 0);

        const barWidth = meterWidth / NUM_EQ_BANDS;
        for (let i = 0; i < NUM_EQ_BANDS; i++) {
            const db = animationState.eq.bands[i].displayValue;
            const percent = (db - MIN_DB_EQ) / (MAX_DB_EQ - MIN_DB_EQ);
            const barHeight = Math.max(0, meterHeight * percent);
            if (db > 0) ctx.fillStyle = '#e74c3c';
            else if (db > -9) ctx.fillStyle = '#f1c40f';
            else ctx.fillStyle = '#27ae60';
            const x = i * barWidth;
            const y = meterHeight - barHeight;
            ctx.fillRect(x, y, Math.max(1, barWidth - 1), barHeight);
        }

        ctx.fillStyle = '#bdc3c7';
        ctx.font = '10px sans-serif';
        ctx.textAlign = 'center';
        const freqLabels = [30, 60, 125, 250, 500, 1000, 2000, 4000, 8000, 16000];
        const minLogFreq = Math.log(20);
        const maxLogFreq = Math.log(20000);
        const logRange = maxLogFreq - minLogFreq;
        freqLabels.forEach(freq => {
            const logFreq = Math.log(freq);
            const x = meterWidth * (logFreq - minLogFreq) / logRange;
            ctx.fillText(freq < 1000 ? freq : `${freq / 1000}k`, x, canvas.height - 5);
        });
        ctx.restore();

        ctx.save();
        ctx.fillStyle = '#bdc3c7';
        ctx.font = '10px sans-serif';
        ctx.textAlign = 'right';
        const dbLabels = [0, -9, -18, -27, -36];
        dbLabels.forEach(db => {
            const percent = (db - MIN_DB_EQ) / (MAX_DB_EQ - MIN_DB_EQ);
            const y = meterHeight - (meterHeight * percent);
            ctx.fillText(db, axisYWidth - 8, y + 3);
            ctx.strokeStyle = '#4a627a';
            ctx.beginPath();
            ctx.moveTo(axisYWidth - 4, y);
            ctx.lineTo(canvas.width, y);
            ctx.stroke();
        });
        ctx.restore();
    }

    function updateCorrelator(deltaSeconds) {
        const refs = uiRefs.correlator;
        const state = animationState.correlator;
        const decay = CORR_FALL_RATE * deltaSeconds;

        if (Math.abs(state.latestValue) > Math.abs(state.displayValue)) {
            state.displayValue = state.latestValue;
        }
        if (state.displayValue > 0) state.displayValue = Math.max(0, state.displayValue - decay);
        else if (state.displayValue < 0) state.displayValue = Math.min(0, state.displayValue + decay);
        if (Math.abs(state.latestValue) > Math.abs(state.displayValue)) {
            state.displayValue = state.latestValue;
        }

        if (!refs?.bar) return;
        const value = state.displayValue;
        if (value >= 0) {
            refs.bar.style.left = '50%';
            refs.bar.style.width = `${value * 50}%`;
        } else {
            const width = -value * 50;
            refs.bar.style.left = `${50 - width}%`;
            refs.bar.style.width = `${width}%`;
        }
    }
})();
