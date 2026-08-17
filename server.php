<?php
header('Content-Type: application/json; charset=utf-8');

// ==========================================
// ⚙️ تنظیمات اصلی سرور
// ==========================================
$ADMIN_API_KEY = "admin123";
$SERVER_URL    = "http://192.168.1.100:4000/";

// فایل‌های دیتابیس مبتنی بر JSON
$cards_file = __DIR__ . '/cards.json';
$state_file = __DIR__ . '/state.json';
$log_file   = __DIR__ . '/logs/nfc.log';

if (!is_dir(__DIR__ . '/logs')) mkdir(__DIR__ . '/logs');

// ==========================================
// 🛡️ لود و مدیریت State (چون PHP State-less است)
// ==========================================
function get_state() {
    global $state_file;
    if (file_exists($state_file)) {
        return json_decode(file_get_contents($state_file), true);
    }
    return [
        "testMode" => ["active" => false, "action" => "0000", "message" => "Test Mode"],
        "recentScans" => [],
        "liveLogs" => []
    ];
}

function save_state($state) {
    global $state_file;
    file_put_contents($state_file, json_encode($state, JSON_PRETTY_PRINT));
}

function get_cards() {
    global $cards_file;
    if (file_exists($cards_file)) {
        return json_decode(file_get_contents($cards_file), true);
    }
    $defaults = [
        "47:35:35:02" => ["status" => "allowed", "action" => "1101", "msg" => "Welcome Boss!"],
        "AA:BB:CC:DD" => ["status" => "rejected", "action" => "0110", "msg" => "Card Blocked"]
    ];
    file_put_contents($cards_file, json_encode($defaults, JSON_PRETTY_PRINT));
    return $defaults;
}

// ==========================================
// 🔒 اعتبارسنجی توکن (Auth Middleware)
// ==========================================
$headers = apache_request_headers();
// تبدیل نام هدرها برای سازگاری در سرورهای مختلف
$headers = array_change_key_case($headers, CASE_UPPER);

$device_id    = isset($headers['X-DEVICE-ID']) ? $headers['X-DEVICE-ID'] : (isset($_GET['device']) ? $_GET['device'] : null);
$client_token = isset($headers['X-AUTH-TOKEN']) ? $headers['X-AUTH-TOKEN'] : null;

// مستثنی کردن API های پنل از هدر توکن سخت‌افزاری (در صورت نیاز به جداسازی لاگین)
$op = isset($_GET['op']) ? $_GET['op'] : '';

if (in_array($op, ['nfc', 'time'])) {
    if (!$device_id || !$client_token) {
        http_response_code(401);
        echo json_encode(["error" => "Unauthorized: Missing Headers"]);
        exit;
    }

    $payload_to_hash = $SERVER_URL . $device_id;
    $expected_token  = hash_hmac('sha256', $payload_to_hash, $ADMIN_API_KEY);

    if (!hash_equals($expected_token, $client_token)) {
        http_response_code(403);
        echo json_encode(["error" => "Forbidden: Invalid Token"]);
        exit;
    }
}

// ==========================================
// 📡 مسیر اصلی یکپارچه
// ==========================================
if ($op === 'nfc') {
    // گرفتن Body برای متد POST یا کوئری برای GET
    $inputJSON = file_get_contents('php://input');
    $input     = json_decode($inputJSON, true);
    $uid       = isset($input['uid']) ? $input['uid'] : (isset($_GET['uid']) ? $_GET['uid'] : "UNKNOWN");

    $cards = get_cards();
    $state = get_state();

    $now = new DateTime('now', new DateTimeZone('UTC'));
    $iso_time = $now->format('Y-m-d\TH:i:s.v\Z');
    
    // تقویم شمسی در PHP با کلاس IntlDateFormatter
    $fmt = new IntlDateFormatter('fa_IR@calendar=persian', IntlDateFormatter::FULL, IntlDateFormatter::FULL, 'Asia/Tehran', IntlDateFormatter::TRADITIONAL);
    $fmt->setPattern('yyyy/MM/dd');
    $shamsi_date = $fmt->format($now);
    // تبدیل اعداد فارسی به انگلیسی
    $persian = ['۰', '۱', '۲', '۳', '۴', '۵', '۶', '۷', '۸', '۹'];
    $english = ['0', '1', '2', '3', '4', '5', '6', '7', '8', '9'];
    $shamsi_date = str_replace($persian, $english, $shamsi_date);

    $action_code = "0000";
    $lcd_message = "Ghost Mode";
    $scan_type   = "unknown";

    if ($state['testMode']['active']) {
        $action_code = $state['testMode']['action'];
        $lcd_message = $state['testMode']['message'];
        $scan_type   = "test";
        $state['testMode']['active'] = false; // غیرفعال شدن تست
    } else {
        if (isset($cards[$uid])) {
            if ($cards[$uid]['status'] === 'allowed') {
                $last_scan = isset($state['recentScans'][$uid]) ? $state['recentScans'][$uid] : 0;
                if (time() - $last_scan < 60) {
                    $action_code = "0100";
                    $lcd_message = "Already Scanned";
                    $scan_type   = "antipassback";
                } else {
                    $state['recentScans'][$uid] = time();
                    $action_code = $cards[$uid]['action'];
                    $lcd_message = $cards[$uid]['msg'];
                    $scan_type   = "allowed";
                }
            } elseif ($cards[$uid]['status'] === 'rejected') {
                $action_code = $cards[$uid]['action'];
                $lcd_message = $cards[$uid]['msg'];
                $scan_type   = "rejected";
            }
        } else {
            $action_code = "0000";
            $lcd_message = "Unknown Card";
            $scan_type   = "unknown";
        }
    }

    $log_line = "{$iso_time} | Shamsi: {$shamsi_date} | UID: {$uid} | Type: {$scan_type} | Action: {$action_code} | Msg: {$lcd_message}\n";
    file_put_contents($log_file, $log_line, FILE_APPEND);

    array_unshift($state['liveLogs'], [
        "time"       => $iso_time,
        "shamsi"     => $shamsi_date,
        "uid"        => $uid,
        "action"     => $action_code,
        "type"       => $scan_type,
        "msg"        => $lcd_message,
        "registered" => isset($cards[$uid])
    ]);

    if (count($state['liveLogs']) > 100) {
        array_pop($state['liveLogs']);
    }

    save_state($state);

    echo json_encode([
        "status"  => "OK",
        "uid"     => $uid,
        "message" => $lcd_message,
        "action"  => $action_code,
        "date"    => $shamsi_date,
        "time"    => $iso_time
    ]);

} elseif ($op === 'time') {
    $now = new DateTime('now', new DateTimeZone('UTC'));
    echo json_encode(["time" => $now->format('Y-m-d\TH:i:s.v\Z')]);

} elseif ($op === 'live-logs') {
    $state = get_state();
    echo json_encode($state['liveLogs']);

} elseif ($op === 'test-mode') {
    $input = json_decode(file_get_contents('php://input'), true);
    $state = get_state();
    $state['testMode'] = [
        "active"  => true,
        "action"  => isset($input['action']) ? $input['action'] : "0000",
        "message" => isset($input['message']) ? $input['message'] : "Test Mode"
    ];
    save_state($state);
    echo json_encode(["success" => true]);

} else {
    http_response_code(400);
    echo json_encode(["error" => "Invalid Operation (op query missing or unknown)"]);
}