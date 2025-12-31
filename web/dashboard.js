(function () {
    const STORAGE_KEY = 'sdilm.dashboard.layout.v1';
    const SETTINGS_KEY = 'sdilm.dashboard.settings.v1';
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
    const PEAK_HOLD_DURATION = 3;

    const socketController = { ws: null };
    const defaultVectorscopeSettings = {
        dotSize: 1,
        fadeAlpha: 0.15,
        amp: 3,
        color: '#45f7aa'
    };
    let vectorscopeSettings = { ...defaultVectorscopeSettings };

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
    dataBus.publish('vectorscope_settings', vectorscopeSettings);

    const animationState = {
        meters: {
            left: {
                latestValue: MIN_DB,
                displayValue: MIN_DB,
                peakHoldValue: MIN_DB,
                peakHoldTimer: 0
            },
            right: {
                latestValue: MIN_DB,
                displayValue: MIN_DB,
                peakHoldValue: MIN_DB,
                peakHoldTimer: 0
            }
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
    const channelMeterFills = [];

    const hexToRgb = (hex) => {
        if (!hex || typeof hex !== 'string') return { r: 0, g: 255, b: 255 };
        const cleaned = hex.replace('#', '');
        if (cleaned.length !== 6) return { r: 0, g: 255, b: 255 };
        const num = parseInt(cleaned, 16);
        return {
            r: (num >> 16) & 255,
            g: (num >> 8) & 255,
            b: num & 255
        };
    };

    const invertFadeValue = (val, min = 0.05, max = 0.3) => {
        const v = isNaN(val) ? min : val;
        return min + max - v;
    };

    const videoStreamManager = (() => {
        const consumers = {
            raw: new Set(),
            waveform: new Set(),
            vectorscope: new Set()
        };
        const streams = {
            raw: null,
            waveform: null,
            vectorscope: null
        };

        let pc = null;
        let ws = null;
        let makingAnswer = false;
        let pendingRemoteOffer = null;
        let currentPubId = null;
        const pendingIce = [];
        let reconnectTimer = null;

        const trackMap = {
            raw: ['video-raw', 'stream-raw'],
            vectorscope: ['video-vs', 'stream-vectorscope'],
            waveform: ['video-wf', 'stream-waveform']
        };

        const hasConsumers = () => Object.values(consumers).some(set => set.size > 0);

        const scheduleReconnect = () => {
            if (reconnectTimer || !hasConsumers()) return;
            reconnectTimer = setTimeout(() => {
                reconnectTimer = null;
                teardownConnection();
                if (hasConsumers()) ensureConnection();
            }, 2000);
        };

        const teardownConnection = () => {
            if (ws) {
                ws.onopen = ws.onclose = ws.onerror = ws.onmessage = null;
                try {
                    ws.close();
                } catch (_) { /* noop */ }
            }
            if (pc) {
                pc.ontrack = pc.onicecandidate = pc.onconnectionstatechange = null;
                try {
                    pc.close();
                } catch (_) { /* noop */ }
            }
            ws = null;
            pc = null;
            makingAnswer = false;
            pendingRemoteOffer = null;
            currentPubId = null;
            pendingIce.length = 0;
            Object.keys(streams).forEach(key => {
                streams[key] = null;
                consumers[key].forEach(video => {
                    video.srcObject = null;
                });
            });
        };

        const attachStream = (key, stream) => {
            streams[key] = stream;
            consumers[key].forEach(video => {
                if (video.srcObject !== stream) video.srcObject = stream;
            });
        };

        const identifyTrack = (trackId, streamId) => {
            if (trackMap.raw.includes(trackId) || trackMap.raw.includes(streamId)) return 'raw';
            if (trackMap.vectorscope.includes(trackId) || trackMap.vectorscope.includes(streamId)) return 'vectorscope';
            if (trackMap.waveform.includes(trackId) || trackMap.waveform.includes(streamId)) return 'waveform';
            return null;
        };

        const handleOffer = async (sdp) => {
            if (makingAnswer) {
                pendingRemoteOffer = sdp;
                return;
            }
            makingAnswer = true;

            try {
                if (pc.signalingState !== 'stable') {
                    try {
                        await pc.setLocalDescription({ type: 'rollback' });
                    } catch (err) {
                        console.warn('Rollback failed', err);
                    }
                }

                await pc.setRemoteDescription({ type: 'offer', sdp });

                let vtrans = pc.getTransceivers().find(t => t.receiver && t.receiver.track?.kind === 'video');
                if (!vtrans) {
                    vtrans = pc.addTransceiver('video', { direction: 'recvonly' });
                }

                const answer = await pc.createAnswer();
                await pc.setLocalDescription(answer);
                ws?.send(JSON.stringify({ type: 'answer', sdp: answer.sdp, to: currentPubId }));

                while (pendingIce.length) {
                    const ice = pendingIce.shift();
                    try {
                        await pc.addIceCandidate(ice);
                    } catch (err) {
                        console.warn('addIceCandidate(pending) failed', err, ice);
                    }
                }
            } catch (err) {
                console.error('handleOffer failed', err);
            } finally {
                makingAnswer = false;
                if (pendingRemoteOffer) {
                    const next = pendingRemoteOffer;
                    pendingRemoteOffer = null;
                    handleOffer(next);
                }
            }
        };

        const ensureConnection = () => {
            if (pc || !hasConsumers()) return;
            pc = new RTCPeerConnection();
            pc.ontrack = (event) => {
                const streamId = event.streams[0]?.id;
                const trackId = event.track.id;
                const key = identifyTrack(trackId, streamId);
                if (key) {
                    attachStream(key, event.streams[0]);
                } else {
                    console.log('Unknown video track', trackId, streamId);
                }
            };
            pc.onicecandidate = (event) => {
                if (event.candidate) {
                    ws?.send(JSON.stringify({
                        type: 'candidate',
                        candidate: event.candidate.candidate,
                        mid: event.candidate.sdpMid,
                        sdpMLineIndex: event.candidate.sdpMLineIndex ?? 0,
                        to: currentPubId
                    }));
                }
            };
            pc.onconnectionstatechange = () => {
                if (pc && ['failed', 'disconnected', 'closed'].includes(pc.connectionState)) {
                    scheduleReconnect();
                }
            };
            connectSignal();
        };

        const connectSignal = () => {
            if (ws || !hasConsumers()) return;
            ws = new WebSocket(`ws://${window.location.host}/?role=sub&page=video`);

            ws.onopen = () => {
                ws?.send(JSON.stringify({ type: 'need-offer' }));
            };

            ws.onmessage = async (event) => {
                try {
                    const text = typeof event.data === 'string' ? event.data : await event.data.text();
                    const data = JSON.parse(text);
                    if (data.type === 'offer') {
                        currentPubId = data.from || currentPubId;
                        if (!pc) ensureConnection();
                        handleOffer(data.sdp);
                    } else if (data.type === 'candidate') {
                        const ice = {
                            candidate: data.candidate,
                            sdpMLineIndex: typeof data.sdpMLineIndex === 'number' ? data.sdpMLineIndex : 0,
                            sdpMid: data.mid ?? null
                        };
                        if (pc?.remoteDescription) {
                            await pc.addIceCandidate(ice);
                        } else {
                            pendingIce.push(ice);
                        }
                    }
                } catch (err) {
                    console.error('Video signaling error', err);
                }
            };

            ws.onerror = (err) => {
                console.error('Video signaling socket error', err);
            };

            ws.onclose = () => {
                ws = null;
                scheduleReconnect();
            };
        };

        const register = (key, video) => {
            consumers[key].add(video);
            video.autoplay = true;
            video.playsInline = true;
            video.muted = true;
            video.controls = false;
            if (streams[key]) {
                video.srcObject = streams[key];
            }
            ensureConnection();
            return () => {
                consumers[key].delete(video);
                video.srcObject = null;
                video.removeAttribute('src');
                if (!hasConsumers()) {
                    teardownConnection();
                }
            };
        };

        return {
            register
        };
    })();


    function clamp(value, min, max) {
        return Math.min(max, Math.max(min, value));
    }

    function formatVideoInfo(video) {
        if (!video) return '-';
        const name = video.name || 'Unknown';
        const pix = video.pixel_format || '';
        if (pix) return `${name} | ${pix}`;
        const resolution = (video.width && video.height) ? `${video.width}x${video.height}` : '';
        return [name, resolution].filter(Boolean).join(' | ') || '-';
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
            defaultSize: { w: 1, h: 3 },
            minW: 1,
            minH: 3,
            mount(root) {
                root.innerHTML = `
                    <div class="widget-container levels-widget-container">
                        <div class="level-meter-container">
                            <div class="scale-container" data-role="scale"></div>
                            <div class="level-meter">
                                <div class="meter-fill" data-role="left-fill"></div>
                                <div class="meter-peak-hold" data-role="left-peak"></div>
                                <span class="meter-current-value" data-role="left-value">-inf</span>
                                <span class="meter-label">L</span>
                            </div>
                            <div class="level-meter">
                                <div class="meter-fill" data-role="right-fill"></div>
                                <div class="meter-peak-hold" data-role="right-peak"></div>
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
                    rightValue: root.querySelector('[data-role="right-value"]'),
                    leftPeak: root.querySelector('[data-role="left-peak"]'),
                    rightPeak: root.querySelector('[data-role="right-peak"]')
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
                            <canvas width="250" height="250"></canvas>
                        </div>
                    </div>
                `;
                const canvas = root.querySelector('canvas');
                const ctx = canvas.getContext('2d');

                const resizeCanvas = () => {
                    const rect = canvas.getBoundingClientRect();
                    if (!rect.width || !rect.height) return;
                    canvas.width = rect.width;
                    canvas.height = rect.height;
                };
                resizeCanvas();
                const resizeObserver = new ResizeObserver(resizeCanvas);
                resizeObserver.observe(canvas);

                let localSettings = { ...vectorscopeSettings };
                dataBus.subscribe('vectorscope_settings', (s) => {
                    if (!s) return;
                    localSettings = { ...localSettings, ...s };
                });

                const drawSamples = (samples) => {
                    if (!Array.isArray(samples)) return;
                    const w = canvas.width;
                    const h = canvas.height;
                    const invSqrt2 = 1 / Math.sqrt(2);
                    const { dotSize = 1, fadeAlpha = 0.15, amp = 3, color = '#00ffff' } = localSettings;
                    const { r, g, b } = hexToRgb(color);
                    // 가벼운 잔상 효과로 부드럽게 표현
                    ctx.fillStyle = `rgba(0, 0, 0, ${fadeAlpha})`;
                    ctx.fillRect(0, 0, w, h);
                    // 누적되며 밝아지도록 낮은 알파 + lighter 합성
                    ctx.globalCompositeOperation = 'lighter';
                    ctx.fillStyle = `rgba(${r}, ${g}, ${b}, 0.08)`;
                    ctx.strokeStyle = `rgba(${r}, ${g}, ${b}, 0.15)`;
                    ctx.lineWidth = 1.5;
                    let hasPath = false;
                    ctx.beginPath();
                    let prevPx = null;
                    let prevPy = null;
                    for (const pair of samples) {
                        if (!Array.isArray(pair) || pair.length < 2) continue;
                        const x = Math.max(-1, Math.min(1, pair[0] * amp));
                        const y = Math.max(-1, Math.min(1, pair[1] * amp));
                        // 45도 회전: 모노 신호가 수직선 상에 보이도록
                        const rx = (x - y) * invSqrt2;
                        const ry = (x + y) * invSqrt2;
                        const px = w / 2 + rx * (w / 2 - 1);
                        const py = h / 2 - ry * (h / 2 - 1);
                        ctx.fillRect(px, py, dotSize, dotSize);
                        if (prevPx !== null) {
                            ctx.moveTo(prevPx, prevPy);
                            ctx.lineTo(px, py);
                            hasPath = true;
                        }
                        prevPx = px;
                        prevPy = py;
                    }
                    if (hasPath) {
                        ctx.stroke();
                    }
                    ctx.globalCompositeOperation = 'source-over';
                };

                const drawBlob = (blob) => {
                    if (!blob) return;
                    createImageBitmap(blob).then(bitmap => {
                        ctx.clearRect(0, 0, canvas.width, canvas.height);
                        ctx.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
                        bitmap.close?.();
                    }).catch(() => {});
                };

                const unsubscribeSamples = dataBus.subscribe('vectorscope_samples', drawSamples);
                const unsubscribeFrame = dataBus.subscribe('vectorscope_frame', drawBlob);

                return () => {
                    unsubscribeSamples();
                    unsubscribeFrame();
                    resizeObserver.disconnect();
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

                const unsubscribeStats = dataBus.subscribe('system_stats', stats => {
                    if (!stats) return;
                    cpuEl.textContent = `${stats.cpu.toFixed(1)}%`;
                    const used = stats.memory.used / (1024 ** 3);
                    const total = stats.memory.total / (1024 ** 3);
                    memEl.innerHTML = `${stats.memory.percent.toFixed(1)}%<br><small>(${used.toFixed(2)}/${total.toFixed(2)} GB)</small>`;
                });

                return () => {
                    unsubscribeStats();
                };
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
            defaultSize: { w: 4, h: 3 },
            minW: 3,
            minH: 2,
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
        },
        videoRaw: {
            title: 'Video – SDI Feed',
            description: 'Live SDI program video',
            defaultSize: { w: 4, h: 4 },
            minW: 3,
            minH: 3,
            mount(root) {
                const container = document.createElement('div');
                container.className = 'widget-container video-widget';
                container.innerHTML = `
                    <div class="video-frame">
                        <video playsinline autoplay muted></video>
                    </div>
                `;
                root.appendChild(container);
                const videoEl = container.querySelector('video');
                const unregister = videoStreamManager.register('raw', videoEl);
                return () => unregister();
            }
        },
        videoWaveform: {
            title: 'Video – Waveform',
            description: 'Waveform monitor',
            defaultSize: { w: 3, h: 2 },
            minW: 2,
            minH: 2,
            mount(root) {
                const container = document.createElement('div');
                container.className = 'widget-container video-widget';
                container.innerHTML = `
                    <div class="video-frame">
                        <video playsinline autoplay muted></video>
                    </div>
                `;
                root.appendChild(container);
                const videoEl = container.querySelector('video');
                const unregister = videoStreamManager.register('waveform', videoEl);
                return () => unregister();
            }
        },
        videoVectorscope: {
            title: 'Video – Vectorscope',
            description: 'Video vectorscope overlay',
            defaultSize: { w: 3, h: 3 },
            minW: 2,
            minH: 2,
            mount(root) {
                const container = document.createElement('div');
                container.className = 'widget-container video-widget';
                container.innerHTML = `
                    <div class="video-frame">
                        <video playsinline autoplay muted></video>
                    </div>
                `;
                root.appendChild(container);
                const videoEl = container.querySelector('video');
                const unregister = videoStreamManager.register('vectorscope', videoEl);
                return () => unregister();
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

        setupControlToggle();
        setupChannelSettingsPanel();
        setupWidgetSettingsPanel();
        setupFullscreenToggle();
        setupControls();
        setupLayoutTransfer();
        loadLayout();
        updateWidgetPickerState();
        toggleEmptyState(document.getElementById('emptyState'));
        setupWebSocket();
        requestAnimationFrame(animationLoop);
    });

    function setupControlToggle() {
        const toggleBtn = document.getElementById('controlToggle');
        const panel = document.getElementById('controlPanel');
        if (!toggleBtn || !panel) return;

        const hidePanel = () => {
            if (document.body.classList.contains('controls-collapsed')) return;
            document.body.classList.add('controls-collapsed');
            updateLabel();
        };

        const updateLabel = () => {
            const collapsed = document.body.classList.contains('controls-collapsed');
            toggleBtn.setAttribute('aria-expanded', (!collapsed).toString());
            panel.setAttribute('aria-hidden', collapsed ? 'true' : 'false');
            toggleBtn.setAttribute('aria-label', collapsed ? '위젯 메뉴 열기' : '위젯 메뉴 닫기');
            toggleBtn.textContent = collapsed ? '＋' : '×';
            toggleBtn.classList.toggle('open', !collapsed);
        };

        toggleBtn.addEventListener('click', () => {
            document.body.classList.toggle('controls-collapsed');
            updateLabel();
        });

        panel.addEventListener('click', (evt) => evt.stopPropagation());
        document.addEventListener('click', (evt) => {
            if (panel.contains(evt.target) || evt.target === toggleBtn) return;
            hidePanel();
        });

        updateLabel();
    }

    function setupChannelSettingsPanel() {
        const toggleBtn = document.getElementById('channelSettingsToggle');
        const panel = document.getElementById('channelSettingsPanel');
        const leftSelect = document.getElementById('channelSettingLeft');
        const rightSelect = document.getElementById('channelSettingRight');
        const saveBtn = document.getElementById('channelSettingsSave');
        const metersContainer = document.getElementById('channelSettingsMeters');
        const videoInfoLabel = document.getElementById('channelVideoInfo');
        if (!toggleBtn || !panel || !leftSelect || !rightSelect || !saveBtn) return;

        const hidePanel = () => {
            panel.classList.remove('open');
            panel.setAttribute('aria-hidden', 'true');
            toggleBtn.setAttribute('aria-expanded', 'false');
        };

        const showPanel = () => {
            const rect = toggleBtn.getBoundingClientRect();
            panel.style.top = `${rect.bottom + 8}px`;
            panel.style.right = `${window.innerWidth - rect.right}px`;
            panel.classList.add('open');
            panel.setAttribute('aria-hidden', 'false');
            toggleBtn.setAttribute('aria-expanded', 'true');
        };

        const togglePanel = () => {
            const isOpen = panel.classList.contains('open');
            if (isOpen) hidePanel();
            else showPanel();
        };

        toggleBtn.addEventListener('click', (evt) => {
            evt.stopPropagation();
            togglePanel();
        });

        panel.addEventListener('click', (evt) => evt.stopPropagation());

        document.addEventListener('click', (evt) => {
            if (!panel.classList.contains('open')) return;
            if (panel.contains(evt.target) || evt.target === toggleBtn) return;
            hidePanel();
        });

        window.addEventListener('scroll', () => {
            if (!panel.classList.contains('open')) return;
            const rect = toggleBtn.getBoundingClientRect();
            panel.style.top = `${rect.bottom + 8}px`;
            panel.style.right = `${window.innerWidth - rect.right}px`;
        }, { passive: true });

        for (let i = 0; i < 16; i++) {
            const optionL = document.createElement('option');
            optionL.value = i;
            optionL.textContent = `Channel ${i + 1}`;
            leftSelect.appendChild(optionL);

            const optionR = document.createElement('option');
            optionR.value = i;
            optionR.textContent = `Channel ${i + 1}`;
            rightSelect.appendChild(optionR);

            if (metersContainer) {
                const meter = document.createElement('div');
                meter.className = 'channel-meter';

                const bar = document.createElement('div');
                bar.className = 'channel-meter-bar';
                const fill = document.createElement('div');
                fill.className = 'channel-meter-fill';
                fill.id = `channel-meter-${i}`;
                bar.appendChild(fill);

                const label = document.createElement('div');
                label.className = 'channel-meter-number';
                label.textContent = i + 1;

                meter.appendChild(bar);
                meter.appendChild(label);
                metersContainer.appendChild(meter);
                channelMeterFills[i] = fill;
            }
        }

        const applySettings = (settings) => {
            if (!settings) return;
            if (Number.isInteger(settings.leftAudioChannel)) {
                leftSelect.value = String(settings.leftAudioChannel);
            }
            if (Number.isInteger(settings.rightAudioChannel)) {
                rightSelect.value = String(settings.rightAudioChannel);
            }
        };

        fetch('/api/settings')
            .then(res => res.ok ? res.json() : Promise.reject(new Error(res.statusText)))
            .then(applySettings)
            .catch(err => console.warn('채널 설정 불러오기 실패:', err));

        dataBus.subscribe('signal_info', info => {
            if (!info || !videoInfoLabel) return;
            videoInfoLabel.textContent = formatVideoInfo(info.video);
        });

        saveBtn.addEventListener('click', () => {
            const payload = {
                leftChannel: leftSelect.value,
                rightChannel: rightSelect.value
            };
            fetch('/api/settings', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(payload)
            })
                .then(res => res.json())
                .then(() => {
                    alert('채널 설정을 저장하고 캡처를 재시작했습니다.');
                    hidePanel();
                })
                .catch(err => {
                    console.error('채널 설정 저장 실패:', err);
                    alert('채널 설정 저장에 실패했습니다.');
                });
        });
    }

    function setupWidgetSettingsPanel() {
        const toggleBtn = document.getElementById('widgetSettingsToggle');
        const panel = document.getElementById('widgetSettingsPanel');
        const dotInput = document.getElementById('vsDotSize');
        const fadeInput = document.getElementById('vsFadeAlpha');
        const ampInput = document.getElementById('vsAmp');
        const colorInput = document.getElementById('vsColor');
        const dotValue = document.getElementById('vsDotSizeValue');
        const fadeValue = document.getElementById('vsFadeAlphaValue');
        const ampValue = document.getElementById('vsAmpValue');
        const colorValue = document.getElementById('vsColorValue');
        const tabButtons = panel?.querySelectorAll('.widget-settings-tab');
        const sections = panel?.querySelectorAll('.widget-settings-section');
        if (!toggleBtn || !panel || !dotInput || !fadeInput || !ampInput || !colorInput) return;

        const syncPanelValues = () => {
                dotInput.value = String(vectorscopeSettings.dotSize);
                fadeInput.value = String(invertFadeValue(vectorscopeSettings.fadeAlpha));
                ampInput.value = String(vectorscopeSettings.amp);
                colorInput.value = vectorscopeSettings.color;
            if (dotValue) dotValue.textContent = vectorscopeSettings.dotSize.toFixed(1);
            if (fadeValue) fadeValue.textContent = vectorscopeSettings.fadeAlpha.toFixed(2);
            if (ampValue) ampValue.textContent = vectorscopeSettings.amp.toFixed(1);
            if (colorValue) colorValue.textContent = vectorscopeSettings.color;
        };
        syncPanelValues();

        const hidePanel = () => {
            panel.classList.remove('open');
            panel.setAttribute('aria-hidden', 'true');
            toggleBtn.setAttribute('aria-expanded', 'false');
        };

        const showPanel = () => {
            const rect = toggleBtn.getBoundingClientRect();
            panel.style.top = `${rect.bottom + 8}px`;
            panel.style.right = `${window.innerWidth - rect.right}px`;
            panel.classList.add('open');
            panel.setAttribute('aria-hidden', 'false');
            toggleBtn.setAttribute('aria-expanded', 'true');
            activateTab('widgetSettingsVectorscope');
        };

        toggleBtn.addEventListener('click', (evt) => {
            evt.stopPropagation();
            if (panel.classList.contains('open')) hidePanel();
            else showPanel();
        });

        panel.addEventListener('click', (evt) => evt.stopPropagation());
        document.addEventListener('click', (evt) => {
            if (!panel.classList.contains('open')) return;
            if (panel.contains(evt.target) || evt.target === toggleBtn) return;
            hidePanel();
        });

        const activateTab = (targetId) => {
            if (!sections || !tabButtons) return;
            sections.forEach(sec => sec.classList.toggle('active', sec.id === targetId));
            tabButtons.forEach(btn => btn.classList.toggle('active', btn.dataset.target === targetId));
        };
        tabButtons?.forEach(btn => {
            btn.addEventListener('click', () => {
                const targetId = btn.dataset.target;
                activateTab(targetId);
            });
        });

        const updateAndPublish = () => {
            vectorscopeSettings = {
                dotSize: Math.max(0.5, Math.min(4, parseFloat(dotInput.value) || 1)),
                fadeAlpha: Math.max(0.01, invertFadeValue(parseFloat(fadeInput.value) || 0.15)),
                amp: Math.max(1, parseFloat(ampInput.value) || 3),
                color: colorInput.value || '#00ffff'
            };
            if (dotValue) dotValue.textContent = vectorscopeSettings.dotSize.toFixed(1);
            if (fadeValue) fadeValue.textContent = vectorscopeSettings.fadeAlpha.toFixed(2);
            if (ampValue) ampValue.textContent = vectorscopeSettings.amp.toFixed(1);
            if (colorValue) colorValue.textContent = vectorscopeSettings.color;
            dataBus.publish('vectorscope_settings', { ...vectorscopeSettings });
        };

        [dotInput, fadeInput, ampInput, colorInput].forEach(input => {
            input.addEventListener('input', updateAndPublish);
            input.addEventListener('change', updateAndPublish);
        });

        dataBus.subscribe('vectorscope_settings', (s) => {
            if (!s) return;
            vectorscopeSettings = { ...vectorscopeSettings, ...s };
            syncPanelValues();
        });
    }

    function updateChannelMeters(allLevels) {
        if (!Array.isArray(allLevels) || channelMeterFills.length === 0) return;
        allLevels.forEach((db, idx) => {
            const fill = channelMeterFills[idx];
            if (!fill) return;
            const pct = clamp(((db - MIN_DB) / (MAX_DB - MIN_DB)) * 100, 0, 100);
            fill.style.height = `${pct}%`;
            if (db > -6) fill.style.backgroundColor = '#e74c3c';
            else if (db > -12) fill.style.backgroundColor = '#f1c40f';
            else fill.style.backgroundColor = '#27ae60';
        });
    }

    function setupFullscreenToggle() {
        const btn = document.getElementById('fullscreenToggle');
        if (!btn) return;

        let wasControlsCollapsed = true;

        const setStaticMode = (isStatic) => {
            if (!grid) return;
            if (typeof grid.setStatic === 'function') {
                grid.setStatic(isStatic);
            } else {
                grid.enableMove?.(!isStatic);
                grid.enableResize?.(!isStatic);
            }
        };

        const syncButton = () => {
            const active = document.body.classList.contains('fullscreen-mode');
            btn.classList.toggle('open', active);
            btn.setAttribute('aria-pressed', active ? 'true' : 'false');
            btn.setAttribute('aria-label', active ? '전체화면 종료' : '전체화면 전환');
            btn.textContent = active ? '⤡' : '⤢';
        };

        const enterFullscreen = async () => {
            wasControlsCollapsed = document.body.classList.contains('controls-collapsed');
            document.body.classList.add('fullscreen-mode');
            document.body.classList.add('controls-collapsed');
            setStaticMode(true);
            syncButton();
            if (!document.fullscreenElement && document.documentElement.requestFullscreen) {
                try {
                    await document.documentElement.requestFullscreen();
                } catch (err) {
                    console.warn('전체화면 진입 실패:', err);
                }
            }
        };

        const exitFullscreen = async () => {
            document.body.classList.remove('fullscreen-mode');
            if (!wasControlsCollapsed) {
                document.body.classList.remove('controls-collapsed');
            }
            setStaticMode(false);
            syncButton();
            if (document.fullscreenElement && document.exitFullscreen) {
                try {
                    await document.exitFullscreen();
                } catch (err) {
                    console.warn('전체화면 종료 실패:', err);
                }
            }
        };

        btn.addEventListener('click', () => {
            const active = document.body.classList.contains('fullscreen-mode');
            if (active) exitFullscreen();
            else enterFullscreen();
        });

        document.addEventListener('fullscreenchange', () => {
            if (!document.fullscreenElement && document.body.classList.contains('fullscreen-mode')) {
                document.body.classList.remove('fullscreen-mode');
                if (!wasControlsCollapsed) {
                    document.body.classList.remove('controls-collapsed');
                }
                setStaticMode(false);
                syncButton();
            }
        });

        syncButton();
    }

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
        const layout = getCurrentLayout();
        localStorage.setItem(STORAGE_KEY, JSON.stringify(layout));
        localStorage.setItem(SETTINGS_KEY, JSON.stringify({ vectorscope: vectorscopeSettings }));
    }

    function getCurrentLayout() {
        if (!grid) return [];
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
        return layout;
    }

    function loadLayout() {
        let saved = [];
        try {
            saved = JSON.parse(localStorage.getItem(STORAGE_KEY) || '[]');
        } catch (err) {
            console.warn('Failed to parse saved layout, using defaults.', err);
        }
        const layout = Array.isArray(saved) && saved.length ? saved : DEFAULT_LAYOUT;
        try {
            applyLayout(layout);
        } catch (err) {
            console.warn('Failed to apply saved layout, using defaults.', err);
            applyLayout(DEFAULT_LAYOUT);
        }
        try {
            const savedSettings = JSON.parse(localStorage.getItem(SETTINGS_KEY) || '{}');
            if (savedSettings && savedSettings.vectorscope) {
                vectorscopeSettings = { ...vectorscopeSettings, ...savedSettings.vectorscope };
                dataBus.publish('vectorscope_settings', { ...vectorscopeSettings });
            }
        } catch (err) {
            console.warn('Failed to load saved settings.', err);
        }
    }

    function sendCommand(payload) {
        if (!socketController.ws || socketController.ws.readyState !== WebSocket.OPEN) {
            console.warn('WebSocket not ready for command', payload);
            return;
        }
        socketController.ws.send(JSON.stringify(payload));
    }

    function applyLayout(layout) {
        if (!Array.isArray(layout)) {
            throw new Error('레이아웃 데이터 형식이 올바르지 않습니다.');
        }
        removeAllWidgets();
        layout.forEach(node => {
            if (!node || typeof node.id !== 'string') {
                throw new Error('위젯 ID가 누락되었습니다.');
            }
            addWidget(node.id, {
                id: node.id,
                x: Number.isFinite(node.x) ? node.x : undefined,
                y: Number.isFinite(node.y) ? node.y : undefined,
                w: Number.isFinite(node.w) ? node.w : undefined,
                h: Number.isFinite(node.h) ? node.h : undefined
            });
        });
        updateWidgetPickerState();
        toggleEmptyState(document.getElementById('emptyState'));
        saveLayout();
    }

    function setupLayoutTransfer() {
        const exportBtn = document.getElementById('exportLayoutBtn');
        const importBtn = document.getElementById('importLayoutBtn');
        const importInput = document.getElementById('importLayoutInput');
        if (!exportBtn || !importBtn || !importInput) return;

        const downloadLayoutFile = () => {
            const layout = getCurrentLayout();
            const blob = new Blob([JSON.stringify(layout, null, 2)], { type: 'application/json' });
            const url = URL.createObjectURL(blob);
            const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
            const userName = prompt('레이아웃 파일 이름을 입력하세요 (확장자 제외)', `sdilm-layout-${timestamp}`) || '';
            const safeName = userName
                .trim()
                .replace(/[\\/:*?"<>|]+/g, '')
                .replace(/\s+/g, '_')
                || `sdilm-layout-${timestamp}`;
            const a = document.createElement('a');
            a.href = url;
            a.download = `${safeName}.json`;
            document.body.appendChild(a);
            a.click();
            setTimeout(() => {
                document.body.removeChild(a);
                URL.revokeObjectURL(url);
            }, 0);
        };

        exportBtn.addEventListener('click', () => {
            try {
                downloadLayoutFile();
            } catch (err) {
                console.error('레이아웃 저장 실패', err);
                alert('레이아웃 저장 중 문제가 발생했습니다.');
            }
        });

        importBtn.addEventListener('click', () => importInput.click());

        importInput.addEventListener('change', () => {
            const file = importInput.files && importInput.files[0];
            if (!file) return;
            const reader = new FileReader();
            reader.onload = () => {
                try {
                    const parsed = JSON.parse(reader.result);
                    applyLayout(parsed);
                    alert('레이아웃을 성공적으로 불러왔습니다.');
                } catch (err) {
                    console.error('레이아웃 불러오기 실패', err);
                    alert('레이아웃 파일을 읽는 데 실패했습니다. JSON 형식을 확인하세요.');
                } finally {
                    importInput.value = '';
                }
            };
            reader.onerror = () => {
                console.error('레이아웃 파일 읽기 실패', reader.error);
                alert('레이아웃 파일을 읽을 수 없습니다.');
                importInput.value = '';
            };
            reader.readAsText(file, 'utf-8');
        });
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
                case 'vectorscope_samples':
                    dataBus.publish('vectorscope_samples', data.samples);
                    break;
                case 'system_stats':
                    dataBus.publish('system_stats', data);
                    break;
                case 'signal_info':
                    dataBus.publish('signal_info', data);
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
        if (Array.isArray(data.all)) {
            updateChannelMeters(data.all);
        }
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

            entry.peakHoldTimer = Math.max(0, entry.peakHoldTimer - deltaSeconds);
            if (entry.latestValue > entry.peakHoldValue) {
                entry.peakHoldValue = entry.latestValue;
                entry.peakHoldTimer = PEAK_HOLD_DURATION;
            } else if (entry.peakHoldTimer === 0 && entry.peakHoldValue > entry.displayValue) {
                entry.peakHoldValue = entry.displayValue;
            }

            const fill = channel === 'left' ? refs.leftFill : refs.rightFill;
            const valueEl = channel === 'left' ? refs.leftValue : refs.rightValue;
            const peakEl = channel === 'left' ? refs.leftPeak : refs.rightPeak;
            if (fill) {
                fill.style.height = `${dbToPercentage(entry.displayValue) * 100}%`;
                applyMeterColor(fill, entry.displayValue);
            }
            if (valueEl) valueEl.textContent = entry.displayValue.toFixed(1);
            if (peakEl) {
                const percent = dbToPercentage(entry.peakHoldValue) * 100;
                peakEl.style.bottom = `${percent}%`;
                peakEl.style.opacity = percent <= 0 ? '0' : '1';
            }
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
                displayRefs.values[key].textContent = entry.label ?? '-inf';
            }
            if (barRefs?.bars[key]) {
                updateLkfsMeter(barRefs.bars[key], entry.displayValue);
            }
            if (barRefs?.labels[key]) {
                const latest = Number.isFinite(entry.latestValue) ? entry.latestValue.toFixed(1) : '-inf';
                barRefs.labels[key].textContent = latest;
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
