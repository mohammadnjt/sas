from flask import Flask, request, jsonify, send_from_directory
import hmac
import hashlib
import json
import os
import time
from datetime import datetime
import jdatetime

app = Flask(__name__, static_folder='public')
PORT = 4000

# ==========================================
# ⚙️ تنظیمات اصلی سرور
# ==========================================
ADMIN_API_KEY = "admin123"
SERVER_URL = f"http://192.168.1.100:{PORT}/"

BASE_DIR = os.path.dirname(os.path.abspath(__file__))
public_dir = os.path.join(BASE_DIR, 'public')
log_dir = os.path.join(BASE_DIR, 'logs')
cards_file = os.path.join(BASE_DIR, 'cards.json')

os.makedirs(log_dir, exist_ok=True)
os.makedirs(public_dir, exist_ok=True)

# ==========================================
# 🛡️ لود دیتابیس کارت‌ها
# ==========================================
def load_cards():
    if os.path.exists(cards_file):
        with open(cards_file, 'r', encoding='utf-8') as f:
            return json.load(f)
    default_cards = {
        "47:35:35:02": {"status": "allowed", "action": "1101", "msg": "Welcome Boss!"},
        "AA:BB:CC:DD": {"status": "rejected", "action": "0110", "msg": "Card Blocked"}
    }
    with open(cards_file, 'w', encoding='utf-8') as f:
        json.dump(default_cards, f, indent=4)
    return default_cards

cards_db = load_cards()
recent_scans = {}
live_logs = []
test_mode = {"active": False, "action": "0000", "message": "Test Mode"}

# ==========================================
# 🔒 میدلور امنیتی
# ==========================================
def authenticate(req):
    device_id = req.headers.get('X-Device-ID') or req.args.get('device')
    client_token = req.headers.get('X-Auth-Token')

    if not device_id or not client_token:
        return False, {"error": "Unauthorized: Missing Headers"}, 401

    payload_to_hash = (SERVER_URL + device_id).encode('utf-8')
    expected_token = hmac.new(ADMIN_API_KEY.encode('utf-8'), payload_to_hash, hashlib.sha256).hexdigest()

    if client_token != expected_token:
        print(f"[AUTH FAILED] Expected: {expected_token} | Got: {client_token}")
        return False, {"error": "Forbidden: Invalid Token"}, 403

    return True, None, 200

# ==========================================
# 🎛️ APIهای پنل و مانیتورینگ
# ==========================================
@app.route('/panel', methods=['GET'])
def panel():
    return send_from_directory(public_dir, 'panel.html')

@app.route('/api/test-mode', methods=['POST'])
def set_test_mode():
    data = request.json
    test_mode['active'] = True
    test_mode['action'] = data.get('action', '0000')
    test_mode['message'] = data.get('message', 'Test Mode')
    return jsonify({"success": True})

@app.route('/api/live-logs', methods=['GET'])
def get_live_logs():
    return jsonify(live_logs)

@app.route('/api/cards', methods=['GET', 'POST'])
def manage_cards():
    global cards_db
    if request.method == 'GET':
        return jsonify(cards_db)
    
    data = request.json
    uid = data.get('uid')
    if not uid or not data.get('status') or not data.get('action'):
        return jsonify({"error": "Invalid Data"}), 400
        
    cards_db[uid] = {"status": data['status'], "action": data['action'], "msg": data.get('msg', '')}
    with open(cards_file, 'w', encoding='utf-8') as f:
        json.dump(cards_db, f, indent=4)
    return jsonify({"success": True})

# ==========================================
# 📡 مسیر اصلی یکپارچه برای ESP32
# ==========================================
@app.route('/', methods=['GET', 'POST'])
def single_endpoint():
    is_auth, err_resp, status_code = authenticate(request)
    if not is_auth:
        return jsonify(err_resp), status_code

    op = request.args.get('op')

    # ----- بررسی کارت NFC -----
    if op == 'nfc':
        uid = request.args.get('uid', 'UNKNOWN')
        if request.is_json and 'uid' in request.json:
            uid = request.json['uid']

        now = datetime.now()
        shamsi_date = jdatetime.datetime.fromgregorian(datetime=now).strftime('%Y/%m/%d')
        
        action_code = "0000"
        lcd_message = "Ghost Mode"
        scan_type = "unknown"

        if test_mode['active']:
            action_code = test_mode['action']
            lcd_message = test_mode['message']
            scan_type = "test"
            test_mode['active'] = False
        else:
            card_info = cards_db.get(uid)
            if card_info:
                if card_info['status'] == 'allowed':
                    last_scan = recent_scans.get(uid, 0)
                    if time.time() - last_scan < 60:
                        action_code = "0100"
                        lcd_message = "Already Scanned"
                        scan_type = "antipassback"
                    else:
                        recent_scans[uid] = time.time()
                        action_code = card_info['action']
                        lcd_message = card_info['msg']
                        scan_type = "allowed"
                elif card_info['status'] == 'rejected':
                    action_code = card_info['action']
                    lcd_message = card_info['msg']
                    scan_type = "rejected"
            else:
                action_code = "0000"
                lcd_message = "Unknown Card"
                scan_type = "unknown"

        iso_time = now.isoformat() + "Z"
        log_line = f"{iso_time} | Shamsi: {shamsi_date} | UID: {uid} | Type: {scan_type} | Action: {action_code} | Msg: {lcd_message}\n"
        
        with open(os.path.join(log_dir, 'nfc.log'), 'a', encoding='utf-8') as f:
            f.write(log_line)

        live_logs.insert(0, {
            "time": iso_time,
            "shamsi": shamsi_date,
            "uid": uid,
            "action": action_code,
            "type": scan_type,
            "msg": lcd_message,
            "registered": uid in cards_db
        })

        if len(live_logs) > 100:
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

    # ----- درخواست ساعت -----
    elif op == 'time':
        return jsonify({"time": datetime.utcnow().isoformat() + "Z"})

    return jsonify({"error": "Invalid Operation (op query missing or unknown)"}), 400

if __name__ == '__main__':
    print("==========================================")
    print(f"🚀 BLH Access Backend (Python Flask) running!")
    print(f"📡 Port: {PORT}")
    print("==========================================")
    app.run(host='0.0.0.0', port=PORT)