const deviceSelect = document.getElementById('deviceSelect');
const videoInputSelect = document.getElementById('videoInputSelect');
const audioInputSelect = document.getElementById('audioInputSelect');
const refreshBtn = document.getElementById('refreshDevices');
const applyBtn = document.getElementById('applyConfig');
const statusLabel = document.getElementById('status');

const setStatus = (text, isError = false) => {
    statusLabel.textContent = text;
    statusLabel.classList.toggle('error', isError);
};

const fillSelect = (select, options) => {
    select.innerHTML = '';
    if (!options || options.length === 0) {
        const option = document.createElement('option');
        option.value = '';
        option.textContent = '옵션 없음';
        select.appendChild(option);
        select.disabled = true;
        return;
    }

    options.forEach((opt) => {
        const option = document.createElement('option');
        option.value = String(opt.id);
        option.textContent = opt.label || String(opt.id);
        if (opt.selected) option.selected = true;
        select.appendChild(option);
    });
    select.disabled = false;
};

const loadOptions = async (deviceId) => {
    setStatus('입력 옵션 불러오는 중...');
    try {
        const res = await fetch(`/api/input-config/options?device=${encodeURIComponent(deviceId)}`);
        if (!res.ok) throw new Error(res.statusText);
        const data = await res.json();
        fillSelect(videoInputSelect, data.videoInputs);
        fillSelect(audioInputSelect, data.audioInputs);
        setStatus('옵션 로드 완료');
    } catch (err) {
        console.error(err);
        setStatus('옵션 로드 실패', true);
    }
};

const loadDevices = async () => {
    setStatus('디바이스 불러오는 중...');
    try {
        const res = await fetch('/api/input-config/devices');
        if (!res.ok) throw new Error(res.statusText);
        const data = await res.json();
        deviceSelect.innerHTML = '';
        if (!data.devices || data.devices.length === 0) {
            const option = document.createElement('option');
            option.value = '';
            option.textContent = '디바이스 없음';
            deviceSelect.appendChild(option);
            deviceSelect.disabled = true;
            setStatus('사용 가능한 장비가 없습니다.', true);
            return;
        }
        data.devices.forEach((device) => {
            const option = document.createElement('option');
            option.value = String(device.id);
            option.textContent = `${device.id}: ${device.name}`;
            deviceSelect.appendChild(option);
        });
        deviceSelect.disabled = false;
        setStatus('디바이스 로드 완료');
        await loadOptions(deviceSelect.value);
    } catch (err) {
        console.error(err);
        setStatus('디바이스 로드 실패', true);
    }
};

deviceSelect.addEventListener('change', () => {
    if (!deviceSelect.value) return;
    loadOptions(deviceSelect.value);
});

refreshBtn.addEventListener('click', () => {
    loadDevices();
});

applyBtn.addEventListener('click', async () => {
    if (!deviceSelect.value) return;
    setStatus('설정 적용 중...');
    try {
        const payload = {
            device: deviceSelect.value,
            videoInputId: videoInputSelect.disabled ? undefined : videoInputSelect.value,
            audioInputId: audioInputSelect.disabled ? undefined : audioInputSelect.value
        };
        const res = await fetch('/api/input-config/apply', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(payload)
        });
        if (!res.ok) throw new Error(res.statusText);
        setStatus('설정이 적용되었습니다.');
    } catch (err) {
        console.error(err);
        setStatus('설정 적용 실패', true);
    }
});

loadDevices();
