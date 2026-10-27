<?php
/**
 * api.php — HTTPS → HTTP relay for the Fleet dashboard on cPanel.
 *
 * The browser only ever talks HTTPS to THIS domain (…/api/...). This script
 * forwards each request to the AWS fleet-server over plain HTTP and streams
 * the answer back, so there is no mixed-content block, no CORS, and the
 * login cookie is set on this domain.
 *
 * Handles: every HTTP method, JSON bodies, Authorization + Cookie headers,
 * Set-Cookie on the way back, and the live Server-Sent-Events stream
 * (/api/.../stream), which is flushed to the browser chunk by chunk.
 *
 * Routed here by .htaccess:  /api/<path>  →  api.php?__path=<path>
 */

// ── Config ──────────────────────────────────────────────────────────────────
// The AWS fleet-server (same target the dev proxy in vite.config.js uses).
const UPSTREAM        = 'http://13.247.178.217';
const REQUEST_TIMEOUT = 60;   // seconds, for ordinary API calls
const CONNECT_TIMEOUT = 10;   // seconds

// ── Build the upstream URL (fixed host — nothing from the client picks it) ───
$path = isset($_GET['__path']) ? $_GET['__path'] : '';
$path = '/' . ltrim($path, '/');
if (strpos($path, '..') !== false) {
    fail(400, 'Bad path');
}
$query = $_GET;
unset($query['__path']);
$url = UPSTREAM . '/api' . $path . (count($query) ? '?' . http_build_query($query) : '');

$method = $_SERVER['REQUEST_METHOD'];
$isStreamRequest = stripos($_SERVER['HTTP_ACCEPT'] ?? '', 'text/event-stream') !== false
                || preg_match('#/stream(/|$)#', $path);

// ── Output: no buffering, no compression (both break the live stream) ───────
@ini_set('zlib.output_compression', '0');
@ini_set('output_buffering', '0');
@ini_set('implicit_flush', '1');
if (function_exists('apache_setenv')) { @apache_setenv('no-gzip', '1'); }
while (ob_get_level() > 0) { ob_end_flush(); }
ob_implicit_flush(true);
ignore_user_abort(false);
if ($isStreamRequest) { @set_time_limit(0); }

// ── Request headers to forward ──────────────────────────────────────────────
$skip = ['host', 'content-length', 'connection', 'keep-alive', 'accept-encoding',
         'transfer-encoding', 'upgrade', 'te', 'trailer', 'proxy-authorization'];
$forward = [];
foreach (request_headers() as $name => $value) {
    if (in_array(strtolower($name), $skip, true)) continue;
    $forward[] = $name . ': ' . $value;
}
$clientIp  = $_SERVER['REMOTE_ADDR'] ?? '';
$prevFwd   = $_SERVER['HTTP_X_FORWARDED_FOR'] ?? '';
$forward[] = 'X-Forwarded-For: ' . ($prevFwd ? $prevFwd . ', ' : '') . $clientIp;
$forward[] = 'X-Forwarded-Proto: https';
$forward[] = 'X-Forwarded-Host: ' . ($_SERVER['HTTP_HOST'] ?? '');
$forward[] = 'Accept-Encoding: identity';   // keep the stream readable as it passes through

// ── cURL ────────────────────────────────────────────────────────────────────
$ch = curl_init($url);
curl_setopt_array($ch, [
    CURLOPT_CUSTOMREQUEST  => $method,
    CURLOPT_HTTPHEADER     => $forward,
    CURLOPT_RETURNTRANSFER => false,
    CURLOPT_FOLLOWLOCATION => false,
    CURLOPT_CONNECTTIMEOUT => CONNECT_TIMEOUT,
    CURLOPT_TIMEOUT        => $isStreamRequest ? 0 : REQUEST_TIMEOUT,
    CURLOPT_HEADERFUNCTION => 'on_header',
    CURLOPT_WRITEFUNCTION  => 'on_body',
    CURLOPT_BUFFERSIZE     => 1024,
]);
if (!in_array($method, ['GET', 'HEAD', 'OPTIONS'], true)) {
    curl_setopt($ch, CURLOPT_POSTFIELDS, file_get_contents('php://input'));
}
if ($method === 'HEAD') {
    curl_setopt($ch, CURLOPT_NOBODY, true);
}

$GLOBALS['__status']       = 0;
$GLOBALS['__headers']      = [];
$GLOBALS['__headers_sent'] = false;

$ok = curl_exec($ch);
if ($ok === false && !$GLOBALS['__headers_sent']) {
    $err = curl_error($ch);
    curl_close($ch);
    fail(502, 'Fleet server unreachable: ' . $err);
}
if (!$GLOBALS['__headers_sent']) { send_headers(); }   // empty-body responses
curl_close($ch);
exit;

// ── Callbacks ───────────────────────────────────────────────────────────────

/** Collect upstream headers; send them the moment the header block ends. */
function on_header($ch, $line) {
    $len  = strlen($line);
    $trim = trim($line);

    if (preg_match('#^HTTP/\S+\s+(\d{3})#', $trim, $m)) {
        // A new status line (e.g. after "100 Continue") resets what we have.
        $GLOBALS['__status']  = (int) $m[1];
        $GLOBALS['__headers'] = [];
        return $len;
    }
    if ($trim === '') {
        if ($GLOBALS['__status'] >= 200) send_headers();
        return $len;
    }
    $GLOBALS['__headers'][] = $trim;
    return $len;
}

/** Stream each body chunk straight to the browser. */
function on_body($ch, $chunk) {
    if (!$GLOBALS['__headers_sent']) send_headers();
    echo $chunk;
    @flush();
    // Browser went away (tab closed) → stop pulling from upstream.
    if (connection_aborted()) return -1;
    return strlen($chunk);
}

function send_headers() {
    if ($GLOBALS['__headers_sent']) return;
    $GLOBALS['__headers_sent'] = true;

    http_response_code($GLOBALS['__status'] ?: 502);
    $hop = ['transfer-encoding', 'connection', 'keep-alive', 'content-length',
            'content-encoding', 'server', 'x-powered-by'];
    $isStream = false;

    foreach ($GLOBALS['__headers'] as $h) {
        $pos = strpos($h, ':');
        if ($pos === false) continue;
        $name  = trim(substr($h, 0, $pos));
        $value = trim(substr($h, $pos + 1));
        $lower = strtolower($name);
        if (in_array($lower, $hop, true)) continue;

        if ($lower === 'content-type' && stripos($value, 'text/event-stream') !== false) {
            $isStream = true;
        }
        if ($lower === 'set-cookie') {
            // The cookie now belongs to THIS domain: drop any Domain= the
            // server set for itself. Path and HttpOnly are kept as-is.
            $value = preg_replace('/;\s*Domain=[^;]*/i', '', $value);
            header('Set-Cookie: ' . $value, false);
            continue;
        }
        header($name . ': ' . $value, false);
    }

    if ($isStream) {
        @set_time_limit(0);
        header('Cache-Control: no-cache, no-transform');
        header('X-Accel-Buffering: no');   // nginx-fronted hosts: don't buffer
    }
    @flush();
}

/** All incoming request headers, including Authorization on CGI/FPM hosts. */
function request_headers() {
    $out = [];
    if (function_exists('getallheaders')) {
        foreach (getallheaders() as $k => $v) $out[$k] = $v;
    } else {
        foreach ($_SERVER as $k => $v) {
            if (strpos($k, 'HTTP_') === 0) {
                $name = str_replace(' ', '-', ucwords(strtolower(str_replace('_', ' ', substr($k, 5)))));
                $out[$name] = $v;
            }
        }
        if (isset($_SERVER['CONTENT_TYPE'])) $out['Content-Type'] = $_SERVER['CONTENT_TYPE'];
    }
    // Apache under CGI/FPM strips Authorization; .htaccess passes it through here.
    $hasAuth = false;
    foreach ($out as $k => $_) { if (strtolower($k) === 'authorization') { $hasAuth = true; break; } }
    if (!$hasAuth) {
        $auth = $_SERVER['HTTP_AUTHORIZATION'] ?? $_SERVER['REDIRECT_HTTP_AUTHORIZATION'] ?? null;
        if ($auth) $out['Authorization'] = $auth;
    }
    return $out;
}

function fail($code, $message) {
    http_response_code($code);
    header('Content-Type: application/json');
    echo json_encode(['message' => $message]);
    exit;
}
