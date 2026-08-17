<?php
// سیستم مسیریابی مرکزی برای اجرای یکپارچه
$request_uri = parse_url($_SERVER['REQUEST_URI'], PHP_URL_PATH);

// اجازه به وب‌سرور برای خواندن مستقیم فایل‌های پوشه public (حل مشکل عکس‌ها)
if (file_exists(__DIR__ . '/public' . $request_uri) && !is_dir(__DIR__ . '/public' . $request_uri)) {
    return false; 
}

$ADMIN_API_KEY = "admin123";
$SERVER_URL    = "http://192.168.1.100:4000/";

$logDir = __DIR__ . '/logs';
if (!is_dir($logDir)) mkdir($logDir, 0777, true);

$allowedCards = [
    "47:35:35:02" => "Welcome Boss!",
    "12:34:56:78" => "Hello User 1",
    "34:DE:E6:A3" => "Hello User 2"
];

// PHP State-less است، حافظه موقت (Live Logs و تست) را در یک فایل جیسون نگه‌می‌داریم
$stateFile = __DIR__ . '/state.json';
function getState() {
    global $stateFile;
    if (file_exists($stateFile)) return json_decode(file_get_contents($stateFile), true);
    return [ "recentScans" => [], "liveLogs" => [], "testMode" => ["active" => false, "action" => "0000", "message" => "Test Mode"] ];
}
function saveState($state) {
    global $stateFile;
    file_put_contents($stateFile, json_encode($state, JSON_PRETTY_PRINT));
}

// ==========================================
// 🎛️ پنل وب و مانیتورینگ زنده (UI)
// ==========================================
if ($request_uri === '/panel') {
    readfile(__DIR__ . '/public/panel.html');
    exit;
}

if ($request_uri === '/docs') {
    readfile(__DIR__ . '/index.html');
    exit;
}

if ($request_uri === '/api/test-mode' && $_SERVER['REQUEST_METHOD'] === 'POST') {
    $input = json_decode(file_get_contents('php://input'), true);
    $state = getState();
    $state['testMode']['active'] = true;
    $state['testMode']['action'] = $input['action'] ?? "0000";
    $state['testMode']['message'] = $input['message'] ?? "Test Mode";
    saveState($state);
    
    header('Content-Type: application/json');
    echo json_encode(["success" => true]);
    exit;
}

if ($request_uri === '/api/live-logs') {
    $state = getState();
    header('Content-Type: application/json');
    echo json_encode($state['liveLogs']);
    exit;
}

// ==========================================
// 📡 مسیر اصلی کارت‌خوان (NFC Endpoint)
// ==========================================
if ($request_uri === '/nfc.php') {
    header('Content-Type: application/json');

    $deviceId    = $_SERVER['HTTP_X_DEVICE_ID'] ?? $_GET['device'] ?? null;
    $clientToken = $_SERVER['HTTP_X_AUTH_TOKEN'] ?? null;

    if (!$deviceId || !$clientToken) {
        http_response_code(401);
        echo json_encode(["error" => "Unauthorized: Missing Headers"]);
        exit;
    }

    $expectedToken = hash_hmac('sha256', $SERVER_URL . $deviceId, $ADMIN_API_KEY);
    if (!hash_equals($expectedToken, $clientToken)) {
        http_response_code(403);
        echo json_encode(["error" => "Forbidden: Invalid Token"]);
        exit;
    }

    $uid = $_GET['uid'] ?? "UNKNOWN";
    $now = new DateTime('now', new DateTimeZone('UTC'));
    $isoTime = $now->format('Y-m-d\TH:i:s.v\Z');

    // محاسبه تاریخ شمسی با اعداد انگلیسی
    $fmt = new IntlDateFormatter('fa_IR@calendar=persian', IntlDateFormatter::FULL, IntlDateFormatter::FULL, 'Asia/Tehran', IntlDateFormatter::TRADITIONAL);
    $fmt->setPattern('yyyy/MM/dd');
    $persianDigits = ['۰','۱','۲','۳','۴','۵','۶','۷','۸','۹'];
    $englishDigits = ['0','1','2','3','4','5','6','7','8','9'];
    $shamsiDate = str_replace($persianDigits, $englishDigits, $fmt->format($now));

    $state = getState();
    $actionCode = "0000";
    $lcdMessage = "Ghost Mode";

    // ۱. حالت تست
    if ($state['testMode']['active']) {
        $actionCode = $state['testMode']['action'];
        $lcdMessage = $state['testMode']['message'];
        $state['testMode']['active'] = false;
    } 
    // ۲. پردازش عادی کارت
    else {
        if (isset($allowedCards[$uid])) {
            $lastScan = $state['recentScans'][$uid] ?? 0;
            if (time() - $lastScan < 60) {
                $actionCode = "0100"; // تکراری
                $lcdMessage = "Already Scanned";
            } else {
                $state['recentScans'][$uid] = time();
                $actionCode = "1101";
                $lcdMessage = $allowedCards[$uid];
            }
        } else {
            $actionCode = "0000";
            $lcdMessage = "Unknown Card";
        }
    }

    $logLine = "$isoTime | Shamsi: $shamsiDate | UID: $uid | Action: $actionCode | Msg: $lcdMessage\n";
    file_put_contents($logDir . '/nfc.log', $logLine, FILE_APPEND);

    array_unshift($state['liveLogs'], [
        "time"   => $isoTime,
        "shamsi" => $shamsiDate,
        "uid"    => $uid,
        "action" => $actionCode,
        "msg"    => $lcdMessage
    ]);

    if (count($state['liveLogs']) > 50) {
        array_pop($state['liveLogs']);
    }
    
    saveState($state);

    echo json_encode([
        "status"  => "OK",
        "uid"     => $uid,
        "message" => $lcdMessage,
        "action"  => $actionCode,
        "date"    => $shamsiDate,
        "time"    => $isoTime
    ]);
    exit;
}

// ==========================================
// ⏱️ همگام‌سازی زمان (Time Sync Endpoint)
// ==========================================
if ($request_uri === '/time') {
    $now = new DateTime('now', new DateTimeZone('UTC'));
    header('Content-Type: application/json');
    echo json_encode(["time" => $now->format('Y-m-d\TH:i:s.v\Z')]);
    exit;
}

// اگر روت پیدا نشد
http_response_code(404);
echo "404 Not Found";