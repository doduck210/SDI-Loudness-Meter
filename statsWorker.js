const os = require('os');

let lastCpuTimes = os.cpus().map(c => c.times);

function getCpuUsage() {
    const currentCpuTimes = os.cpus().map(c => c.times);
    const usage = currentCpuTimes.map((times, i) => {
        const last = lastCpuTimes[i];
        const idle = times.idle - last.idle;
        const total = (times.user - last.user) + (times.nice - last.nice) + (times.sys - last.sys) + (times.irq - last.irq) + idle;
        return total > 0 ? 1 - (idle / total) : 0;
    });
    lastCpuTimes = currentCpuTimes;
    const avgUsage = usage.reduce((a, b) => a + b, 0) / usage.length;
    return avgUsage;
}

const interval = setInterval(() => {
    const cpuUsage = getCpuUsage();
    const totalMem = os.totalmem();
    const freeMem = os.freemem();
    const usedMem = totalMem - freeMem;

    if (process.send) {
        process.send({
            type: 'system_stats',
            cpu: cpuUsage * 100,
            memory: {
                percent: (usedMem / totalMem) * 100,
                used: usedMem,
                total: totalMem
            }
        });
    }
}, 2000);

function shutdown() {
    clearInterval(interval);
    process.exit(0);
}

process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
