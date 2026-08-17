import os
import json
import time
import hmac
import hashlib
from datetime import datetime
from flask import Flask, request, jsonify, send_from_directory
import jdatetime

# پیکربندی پوشه استاتیک برای دسترسی به فایل‌هایی مثل لوگو در روت (/)
app = Flask(__name__, static_folder='public', static_url_path='/')
PORT = 4000

# ==========================================
# ⚙️ تنظیمات اصلی سرور
# ==========================================
ADMIN_API_KEY = "admin123"
SERVER_URL = f"http://192.168.1.100:{PORT}/"

BASE_DIR = os.path.dirname(os.path.abspath(__file__))
public_dir = os.path.join(BASE_DIR, 'public')
log_dir = os.path.join(BASE_DIR, 'logs')

os.makedirs(log_dir, exist_ok=True)
os.makedirs(public_dir, exist_ok=True)

# ==========================================
# 🛡️ دیتابیس و مموری‌های موقت
# ==========================================
allowed_cards = {
    "47:35:35:02": "Welcome Boss!",
    "12:34:56:78": "Hello User 1",
    "34:DE:E6:A3": "Hello User 2"
}

recent_scans = {}
live_logs = []
test_mode = {"active": False, "action": "0000", "message": "Test Mode"}

# ==========================================
# 🔒 میدلور امنیتی (SHA256 Auth)
# ==========================================
def authenticate(req):
    device_id = req.headers.get('X-Device-Id') or req.args.get('device')
    client_token = req.headers.get('X-Auth-Token')

    if not device_id or not client_token:
        return False, {"error": "Unauthorized: Missing Headers"}, 401

    payload = (SERVER_URL + device_id).encode('utf-8')
    expected_token = hmac.new(ADMIN_API_KEY.encode('utf-8'), payload, hashlib.sha256).hexdigest()

    if client_token != expected_token:
        print(f"[AUTH FAILED] Expected: {expected_token} | Got: {client_token}")
        return False, {"error": "Forbidden: Invalid Token"}, 403

    return True, None, 200

# ==========================================
# 🎛️ پنل وب و مانیتورینگ زنده (UI)
# ==========================================
@app.route('/panel')
def panel():
    return send_from_directory(public_dir, 'panel.html')

@app.route('/docs')
def docs():
    # خواندن فایل index.html از مسیر ریشه (کنار app.py)
    return send_from_directory(BASE_DIR, 'index.html')

@app.route('/api/test-mode', methods=['POST'])
def set_test_mode():
    data = request.json
    test_mode['active'] = True
    test_mode['action'] = data.get('action', '0000')
    test_mode['message'] = data.get('message', 'Test Mode OK')
    return jsonify({"success": True})

@app.route('/api/live-logs')
def get_live_logs():
    return jsonify(live_logs)

# ==========================================
# 📡 مسیر اصلی کارت‌خوان (NFC Endpoint)
# ==========================================
@app.route('/nfc.php')
def nfc():
    is_auth, err_resp, status_code = authenticate(request)
    if not is_auth:
        return jsonify(err_resp), status_code

    uid = request.args.get('uid', 'UNKNOWN')
    now = datetime.now()
    shamsi_date = jdatetime.datetime.fromgregorian(datetime=now).strftime('%Y/%m/%d')
    
    action_code = "0000"
    lcd_message = "Ghost Mode"

    # ۱. بررسی حالت تست
    if test_mode['active']:
        action_code = test_mode['action']
        lcd_message = test_mode['message']
        test_mode['active'] = False
    # ۲. بررسی عادی کارت
    else:
        if uid in allowed_cards:
            last_scan = recent_scans.get(uid, 0)
            if time.time() - last_scan < 60:
                action_code = "0100"
                lcd_message = "Already Scanned"
            else:
                recent_scans[uid] = time.time()
                action_code = "1101"
                lcd_message = allowed_cards[uid]
        else:
            action_code = "0000"
            lcd_message = "Unknown Card"

    # ثبت لاگ
    iso_time = now.isoformat() + "Z"
    log_line = f"{iso_time} | Shamsi: {shamsi_date} | UID: {uid} | Action: {action_code} | Msg: {lcd_message}\n"
    
    with open(os.path.join(log_dir, 'nfc.log'), 'a', encoding='utf-8') as f:
        f.write(log_line)

    live_logs.insert(0, {
        "time": iso_time,
        "shamsi": shamsi_date,
        "uid": uid,
        "action": action_code,
        "msg": lcd_message
    })
    
    if len(live_logs) > 50:
        live_logs.pop()

    print(f"[NFC SCAN] Card: {uid} | Action: {action_code} | Msg: {lcd_message}")

    return jsonify({
        "status": "OK",
        "uid": uid,
        "message": lcd_message,
        "action": action_code,
        "date": shamsi_date,
        "time": iso_time
    })

# ==========================================
# ⏱️ همگام‌سازی زمان (Time Sync Endpoint)
# ==========================================
@app.route('/time')
def get_time():
    return jsonify({"time": datetime.utcnow().isoformat() + "Z"})

if __name__ == '__main__':
    print("==========================================")
    print(f"🚀 SAS Backend (Python Flask) running!")
    print(f"📡 Port: {PORT} | Token Security: SHA256 (HMAC)")
    print("==========================================")
    app.run(host='0.0.0.0', port=PORT)