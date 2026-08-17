const express = require('express');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const app = express();
const PORT = 4000; // پورت طبق کد اصلی شما تنظیم شده است

// ==========================================
// ⚙️ تنظیمات اصلی سرور
// ==========================================
const ADMIN_API_KEY = "admin123";
const SERVER_URL = "http://192.168.1.100:4000/"; // آدرس سرور شما (برای ساخت توکن)

const publicDir = path.join(__dirname, 'public');
const logDir = path.join(__dirname, 'logs');

if (!fs.existsSync(logDir)) fs.mkdirSync(logDir);

app.use(express.json());
app.use(express.static(publicDir));

// ==========================================
// 🛡️ دیتابیس و مموری‌های موقت
// ==========================================
const allowedCards = {
    "47:35:35:02": "Welcome Boss!",
    "12:34:56:78": "Hello User 1",
    "34:DE:E6:A3": "Hello User 2"
};

const recentScans = {};
const liveLogs = []; // آرایه نگهداری لاگ‌های زنده برای نمایش در پنل وب

let testMode = { active: false, action: "0000", message: "Test Mode" };

// ==========================================
// 🔒 میدلور امنیتی (SHA256 Auth)
// ==========================================
const authMiddleware = (req, res, next) => {
    const deviceId = req.headers['x-device-id'] || req.query.device; // پشتیبانی از هدر یا کوئری
    const clientToken = req.headers['x-auth-token'];

    if (!deviceId || !clientToken) {
        return res.status(401).json({ error: "Unauthorized: Missing Headers" });
    }

    const payloadToHash = SERVER_URL + deviceId;
    const expectedToken = crypto.createHmac('sha256', ADMIN_API_KEY)
                                .update(payloadToHash)
                                .digest('hex');

    if (clientToken !== expectedToken) {
        console.log(`[AUTH FAILED] Expected: ${expectedToken} | Got: ${clientToken}`);
        return res.status(403).json({ error: "Forbidden: Invalid Token" });
    }

    req.deviceId = deviceId;
    next();
};

// ==========================================
// 🎛️ پنل وب و مانیتورینگ زنده (UI)
// ==========================================
app.get('/panel', (req, res) => {
    const html = `<!DOCTYPE html><html><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>BLH Hardware Test & Monitor</title>
    <style>
        body { font-family: 'Segoe UI', sans-serif; background: #0f172a; color: white; padding: 20px; display: flex; flex-direction: column; align-items: center; gap: 20px; }
        .card { background: #1e293b; padding: 30px; border-radius: 12px; width: 100%; max-width: 600px; box-shadow: 0 4px 20px rgba(0,0,0,0.5); }
        h2 { color: #3b82f6; text-align: center; margin-top: 0; }
        .grid { display: grid; grid-template-columns: 1fr 1fr; gap: 15px; margin: 20px 0; }
        label { background: #334155; padding: 15px; border-radius: 8px; cursor: pointer; display: flex; align-items: center; gap: 10px; font-weight: bold; }
        input[type="checkbox"] { transform: scale(1.5); }
        input[type="text"] { width: 100%; padding: 12px; margin-bottom: 20px; border-radius: 8px; border: 1px solid #475569; background: #0f172a; color: white; box-sizing: border-box; }
        .btn { width: 100%; padding: 15px; background: #22c55e; color: white; border: none; border-radius: 8px; font-size: 16px; font-weight: bold; cursor: pointer; }
        .btn:hover { background: #16a34a; }
        .status { text-align: center; margin-top: 15px; color: #fbbf24; font-size: 14px; }
        table { width: 100%; border-collapse: collapse; margin-top: 15px; font-size: 14px; text-align: left; }
        th, td { padding: 12px; border-bottom: 1px solid #334155; }
        th { background: #0f172a; color: #94a3b8; }
        .action-badge { padding: 4px 8px; border-radius: 4px; font-weight: bold; font-family: monospace; }
        .act-1101 { background: rgba(34, 197, 94, 0.2); color: #4ade80; }
        .act-0110 { background: rgba(239, 68, 68, 0.2); color: #f87171; }
        .act-0000 { background: rgba(148, 163, 184, 0.2); color: #cbd5e1; }
        .act-0100 { background: rgba(234, 179, 8, 0.2); color: #fde047; }
        .act-test { background: rgba(168, 85, 247, 0.2); color: #c084fc;} 
    </style>
    </head><body>
    
    <div class="card">
        <h2>🛠️ Hardware Test Panel</h2>
        <p style="text-align:center; color:#94a3b8; font-size:13px;">کارت بعدی که روی دستگاه قرار بگیرد، این دستورات را اجرا می‌کند.</p>
        <div class="grid">
            <label style="color: #60a5fa;"><input type="checkbox" id="relay"> Relay (در)</label>
            <label style="color: #facc15;"><input type="checkbox" id="buzzer"> Buzzer (بوق)</label>
            <label style="color: #f87171;"><input type="checkbox" id="red"> Red LED</label>
            <label style="color: #4ade80;"><input type="checkbox" id="green"> Green LED</label>
        </div>
        <input type="text" id="msg" maxlength="16" placeholder="LCD Message (Max 16 chars)">
        <button class="btn" onclick="setTestMode()">🚀 Set Next Action</button>
        <div id="status" class="status"></div>
    </div>
    
    <div class="card" style="max-width: 800px;">
        <h2 style="color: #8b5cf6;">📡 Live Access Logs</h2>
        <table>
            <thead>
                <tr><th>زمان و تاریخ</th><th>کارت (UID)</th><th>پیام (LCD)</th><th>کد اکشن</th></tr>
            </thead>
            <tbody id="logTableBody">
                <tr><td colspan="4" style="text-align:center; color:#94a3b8;">در حال دریافت اطلاعات...</td></tr>
            </tbody>
        </table>
    </div>
    
    <script>
        function setTestMode() {
            const relay = document.getElementById('relay').checked ? '1' : '0';
            const buzzer = document.getElementById('buzzer').checked ? '1' : '0';
            const red = document.getElementById('red').checked ? '1' : '0';
            const green = document.getElementById('green').checked ? '1' : '0';
            const actionCode = relay + buzzer + red + green;
            const msg = document.getElementById('msg').value || "Test Mode OK";
    
            fetch('/api/test-mode', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ action: actionCode, message: msg })
            }).then(res => res.json()).then(data => {
                document.getElementById('status').innerText = '✅ Test mode activated! Scan a card on ESP32 now.';
                setTimeout(() => document.getElementById('status').innerText = '', 5000);
            });
        }
    
        function fetchLogs() {
            fetch('/api/live-logs')
                .then(res => res.json())
                .then(logs => {
                    const tbody = document.getElementById('logTableBody');
                    if(logs.length === 0) {
                        tbody.innerHTML = '<tr><td colspan="4" style="text-align:center; color:#94a3b8;">هنوز کارتی اسکن نشده است.</td></tr>';
                        return;
                    }
                    tbody.innerHTML = '';
                    logs.forEach(log => {
                        let badgeClass = 'act-' + log.action;
                        if(!['1101', '0110', '0000', '0100'].includes(log.action)) badgeClass = 'act-test';
    
                        tbody.innerHTML += \`<tr>
                            <td style="color:#94a3b8; font-size:12px;">\${log.shamsi} <br> \${new Date(log.time).toLocaleTimeString('fa-IR')}</td>
                            <td style="font-family:monospace; color:#60a5fa">\${log.uid}</td>
                            <td>\${log.msg}</td>
                            <td><span class="action-badge \${badgeClass}">\${log.action}</span></td>
                        </tr>\`;
                    });
                });
        }
        setInterval(fetchLogs, 2000);
        fetchLogs(); 
    </script>
    </body></html>`;
    res.send(html);
});

app.post('/api/test-mode', (req, res) => {
    testMode.active = true;
    testMode.action = req.body.action;
    testMode.message = req.body.message;
    res.json({ success: true });
});

app.get('/api/live-logs', (req, res) => {
    res.json(liveLogs);
});

// ==========================================
// 📡 مسیر اصلی کارت‌خوان (NFC Endpoint)
// ==========================================
app.get('/nfc.php', authMiddleware, (req, res) => {
    const uid = req.query.uid || "UNKNOWN";
    const now = new Date();

    const formatter = new Intl.DateTimeFormat('fa-IR', { calendar: 'persian', year: 'numeric', month: '2-digit', day: '2-digit', numberingSystem: 'latn' });
    let shamsiDate = formatter.format(now).replace(/-/g, '/');

    let actionCode = "0000";
    let lcdMessage = "Ghost Mode";

    // ۱. بررسی حالت تست
    if (testMode.active) {
        actionCode = testMode.action;
        lcdMessage = testMode.message;
        testMode.active = false; 
    } 
    // ۲. بررسی عادی کارت
    else {
        if (allowedCards[uid]) {
            const lastScan = recentScans[uid];
            if (lastScan && (now - lastScan < 60000)) { 
                actionCode = "0100"; // تکراری زیر ۱ دقیقه
                lcdMessage = "Already Scanned";
            } else {
                recentScans[uid] = now;
                actionCode = "1101"; // مجاز (رله+سبز+بوق)
                lcdMessage = allowedCards[uid];
            }
        } else {
            actionCode = "0000"; // ناشناس / مسدود (Ghosting)
            lcdMessage = "Unknown Card"; 
        }
    }

    // ثبت لاگ در سرور (فایل متنی)
    const logLine = `${now.toISOString()} | Shamsi: ${shamsiDate} | UID: ${uid} | Action: ${actionCode} | Msg: ${lcdMessage}\n`;
    fs.appendFileSync(path.join(logDir, "nfc.log"), logLine);

    // ثبت لاگ در مموری برای نمایش زنده در پنل وب
    liveLogs.unshift({
        time: now.toISOString(),
        shamsi: shamsiDate,
        uid: uid,
        action: actionCode,
        msg: lcdMessage
    });
    
    // نگه داشتن فقط 50 لاگ آخر در رم
    if (liveLogs.length > 50) liveLogs.pop();

    console.log(`[NFC SCAN] Card: ${uid} | Action: ${actionCode} | Msg: ${lcdMessage}`);

    // ارسال پاسخ به ESP32
    res.json({ 
        status: "OK", 
        uid: uid, 
        message: lcdMessage,
        action: actionCode, 
        date: shamsiDate, 
        time: now.toISOString() 
    });
});

// ==========================================
// ⏱️ همگام‌سازی زمان (Time Sync Endpoint)
// ==========================================
app.get('/time', (req, res) => {
    res.json({ time: new Date().toISOString() });
});

// ==========================================
// 🚀 استارت سرور
// ==========================================
app.listen(PORT, '0.0.0.0', () => {
    console.log(`==========================================`);
    console.log(`🚀 SAS Backend & Test Server is running!`);
    console.log(`📡 Port: ${PORT} | Token Security: SHA256 (HMAC)`);
    console.log(`🎛️  Test Panel: http://localhost:${PORT}/panel`);
    console.log(`==========================================`);
});