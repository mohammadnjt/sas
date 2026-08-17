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
    res.sendFile(path.join(publicDir, 'panel.html'));
});

app.get('/docs', (req, res) => {
    res.sendFile(path.join(__dirname, 'index.html'));
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