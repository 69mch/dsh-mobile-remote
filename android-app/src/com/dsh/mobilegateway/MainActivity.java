package com.dsh.mobilegateway;

import android.annotation.SuppressLint;
import android.app.Activity;
import android.content.Context;
import android.content.SharedPreferences;
import android.graphics.Bitmap;
import android.graphics.Color;
import android.graphics.Typeface;
import android.net.ConnectivityManager;
import android.net.NetworkInfo;
import android.os.Build;
import android.os.Bundle;
import android.provider.Settings;
import android.telephony.TelephonyManager;
import android.view.Gravity;
import android.view.KeyEvent;
import android.view.View;
import android.view.ViewGroup;
import android.webkit.CookieManager;
import android.webkit.WebChromeClient;
import android.webkit.WebResourceRequest;
import android.webkit.WebSettings;
import android.webkit.WebView;
import android.webkit.WebViewClient;
import android.widget.EditText;
import android.widget.FrameLayout;
import android.widget.LinearLayout;
import android.widget.ProgressBar;
import android.widget.TextView;
import android.widget.Toast;

import java.io.BufferedReader;
import java.io.InputStreamReader;
import java.io.OutputStream;
import java.net.HttpURLConnection;
import java.net.URL;

/**
 * DSH 远程 — 连接码配对 + Harness GUI
 *
 * 认证流程（无账号密码）：
 *   1. 启动 → GET /__gw/auth-check
 *      - 200（已有有效会话 Cookie）→ 直接进 WebView 加载 GUI
 *      - 401 → 显示「输入连接码」页
 *   2. 用户输入连接码 → POST /__gw/pair {code, deviceId, model, imei}
 *      - 成功：把 Set-Cookie 写入 CookieManager → 进 WebView
 *      - 失败：提示（码错 / 此码已绑定其他设备）
 */
public class MainActivity extends Activity {
    private static final String PREFS = "dsh_gw";
    private static final String KEY_URL = "target_url";
    private static final String DEFAULT_URL = "http://127.0.0.1:9443/";

    private WebView webView;
    private ProgressBar progressBar;
    private LinearLayout pairView;
    private EditText addrInput;
    private EditText codeInput;
    private TextView statusText;
    private String targetUrl;

    @SuppressLint("SetJavaScriptEnabled")
    @Override
    protected void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);
        // 安全：生产安装禁止 WebView 远程调试（否则本机任意 adb/DevTools 客户端可读取 DOM/Cookie 并注入 JS）
        WebView.setWebContentsDebuggingEnabled(false);

        SharedPreferences sp = getSharedPreferences(PREFS, MODE_PRIVATE);
        targetUrl = sp.getString(KEY_URL, DEFAULT_URL);

        // 根布局
        FrameLayout root = new FrameLayout(this);

        // ---- WebView ----
        webView = new WebView(this);
        WebSettings s = webView.getSettings();
        s.setJavaScriptEnabled(true);
        s.setDomStorageEnabled(true);
        s.setDatabaseEnabled(true);
        s.setLoadWithOverviewMode(true);
        s.setUseWideViewPort(true);
        s.setSupportZoom(true);
        s.setBuiltInZoomControls(true);
        s.setDisplayZoomControls(false);
        s.setMediaPlaybackRequiresUserGesture(true);
        s.setCacheMode(WebSettings.LOAD_DEFAULT);
        // 安全：禁止 HTTPS 页面内混入明文 HTTP 子资源（杜绝中间人/指纹注入）
        s.setMixedContentMode(WebSettings.MIXED_CONTENT_NEVER_ALLOW);
        webView.setBackgroundColor(Color.rgb(11, 13, 16));

        webView.setWebViewClient(new WebViewClient() {
            @Override
            public boolean shouldOverrideUrlLoading(WebView view, WebResourceRequest request) {
                // 安全：只允许导航到网关同源（targetUrl 的 scheme+host+port），防止在可信壳内打开任意恶意源。
                // 外部链接（文档/模型等）交给系统浏览器，而非在持会话 Cookie 的 WebView 内加载。
                String url = request.getUrl().toString();
                if (isAllowedNavigation(url)) return false;
                try {
                    startActivity(new android.content.Intent(android.content.Intent.ACTION_VIEW, request.getUrl()));
                } catch (Exception e) { /* 无外部浏览器则忽略 */ }
                return true; // 阻止 WebView 加载外部源
            }
            @Override
            public void onPageStarted(WebView view, String url, Bitmap favicon) {
                if (progressBar != null) { progressBar.setVisibility(View.VISIBLE); progressBar.setProgress(5); }
            }
            @Override
            public void onPageFinished(WebView view, String url) {
                if (progressBar != null) progressBar.setVisibility(View.GONE);
            }
        });
        webView.setWebChromeClient(new WebChromeClient() {
            @Override
            public void onProgressChanged(WebView view, int newProgress) {
                if (progressBar != null) progressBar.setProgress(newProgress);
            }
        });

        // ---- 配对视图（连接码输入）----
        pairView = buildPairView();
        pairView.setVisibility(View.GONE);

        progressBar = new ProgressBar(this, null, android.R.attr.progressBarStyleHorizontal);
        progressBar.setMax(100);
        progressBar.setVisibility(View.GONE);

        root.addView(webView, new FrameLayout.LayoutParams(
                FrameLayout.LayoutParams.MATCH_PARENT, FrameLayout.LayoutParams.MATCH_PARENT));
        root.addView(pairView, new FrameLayout.LayoutParams(
                FrameLayout.LayoutParams.MATCH_PARENT, FrameLayout.LayoutParams.MATCH_PARENT));
        root.addView(progressBar, new FrameLayout.LayoutParams(
                FrameLayout.LayoutParams.MATCH_PARENT, 8));
        setContentView(root);

        // 启动：先探测会话
        checkAuthThenLoad();
    }

    // ================= 配对视图 =================
    private LinearLayout buildPairView() {
        LinearLayout ll = new LinearLayout(this);
        ll.setOrientation(LinearLayout.VERTICAL);
        ll.setGravity(Gravity.CENTER);
        ll.setBackgroundColor(Color.rgb(11, 13, 16));
        ll.setPadding(dp(28), dp(20), dp(28), dp(20));

        TextView title = new TextView(this);
        title.setText("🔐 DSH 远程访问");
        title.setTextColor(Color.WHITE);
        title.setTextSize(20);
        title.setTypeface(Typeface.DEFAULT_BOLD);
        ll.addView(title, lpWrap());

        TextView sub = new TextView(this);
        sub.setText("输入电脑 Harness 上显示的连接码");
        sub.setTextColor(Color.rgb(154, 163, 175));
        sub.setTextSize(13);
        sub.setGravity(Gravity.CENTER);
        ll.addView(sub, lpWrapMargin(0, 8, 0, 20));

        // 服务器地址（可改）：真机/外网请设为 https://<电脑名>.ts.net；模拟器/USB 直连可保持本机。
        addrInput = new EditText(this);
        addrInput.setSingleLine(true);
        addrInput.setGravity(Gravity.CENTER);
        addrInput.setTextSize(15);
        addrInput.setTypeface(Typeface.MONOSPACE);
        addrInput.setText(targetUrl);
        addrInput.setHint("服务器地址（如 https://您的电脑名.ts.net）");
        addrInput.setTextColor(Color.WHITE);
        addrInput.setHintTextColor(Color.rgb(90, 98, 110));
        addrInput.setBackgroundColor(Color.rgb(20, 24, 30));
        addrInput.setPadding(dp(12), dp(12), dp(12), dp(12));
        ll.addView(addrInput, lpMatchWrapMargin(0, 0, 0, 10));

        codeInput = new EditText(this);
        codeInput.setSingleLine(true);
        codeInput.setGravity(Gravity.CENTER);
        codeInput.setTextSize(22);
        codeInput.setTypeface(Typeface.MONOSPACE, Typeface.BOLD);
        codeInput.setHint("XXXX-XXXX");
        codeInput.setTextColor(Color.WHITE);
        codeInput.setHintTextColor(Color.rgb(90, 98, 110));
        codeInput.setBackgroundColor(Color.rgb(20, 24, 30));
        codeInput.setPadding(dp(12), dp(12), dp(12), dp(12));
        ll.addView(codeInput, lpMatchWrap());

        statusText = new TextView(this);
        statusText.setTextColor(Color.rgb(248, 113, 113));
        statusText.setTextSize(13);
        statusText.setGravity(Gravity.CENTER);
        statusText.setVisibility(View.GONE);
        ll.addView(statusText, lpWrapMargin(0, 12, 0, 0));

        android.widget.Button pairBtn = new android.widget.Button(this);
        pairBtn.setText("连 接");
        pairBtn.setTextColor(Color.WHITE);
        pairBtn.setTextSize(16);
        pairBtn.setTypeface(Typeface.DEFAULT_BOLD);
        pairBtn.setBackgroundColor(Color.rgb(59, 130, 246));
        pairBtn.setAllCaps(false);
        pairBtn.setOnClickListener(new View.OnClickListener() { public void onClick(View v) { doPair(); } });
        ll.addView(pairBtn, lpMatchWrapMargin(0, 20, 0, 0));

        TextView hint = new TextView(this);
        hint.setText("连接码在电脑 Harness 首次启动时显示；\n如需新码运行 gen-code.ps1。\n此连接码仅供一台设备绑定。");
        hint.setTextColor(Color.rgb(120, 130, 145));
        hint.setTextSize(12);
        hint.setGravity(Gravity.CENTER);
        ll.addView(hint, lpWrapMargin(0, 20, 0, 0));

        return ll;
    }

    private LinearLayout.LayoutParams lpWrap() {
        return new LinearLayout.LayoutParams(ViewGroup.LayoutParams.WRAP_CONTENT, ViewGroup.LayoutParams.WRAP_CONTENT);
    }
    private LinearLayout.LayoutParams lpWrapMargin(int l, int t, int r, int b) {
        LinearLayout.LayoutParams p = new LinearLayout.LayoutParams(ViewGroup.LayoutParams.WRAP_CONTENT, ViewGroup.LayoutParams.WRAP_CONTENT);
        p.setMargins(dp(l), dp(t), dp(r), dp(b));
        return p;
    }
    private LinearLayout.LayoutParams lpMatchWrap() {
        return new LinearLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.WRAP_CONTENT);
    }
    private LinearLayout.LayoutParams lpMatchWrapMargin(int l, int t, int r, int b) {
        LinearLayout.LayoutParams p = new LinearLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.WRAP_CONTENT);
        p.setMargins(dp(l), dp(t), dp(r), dp(b));
        return p;
    }

    private int dp(int v) { return Math.round(getResources().getDisplayMetrics().density * v); }

    // ================= 安全辅助 =================
    /** 解析目标网关 URL；失败返回 null */
    private java.net.URI targetUri() {
        try { return new java.net.URI(targetUrl); } catch (Exception e) { return null; }
    }

    /** 仅本机/模拟器宿主可走明文（adb reverse / 模拟器）；真机/外网必须 HTTPS */
    private boolean isLoopbackHost(String h) {
        if (h == null) return false;
        return h.equals("127.0.0.1") || h.equalsIgnoreCase("localhost") || h.equals("10.0.2.2");
    }

    /** 对给定 URL 做安全校验：非本机地址若为 http（明文）则拒绝，返回错误文案或 null（通过） */
    private String validateTargetUrl(String url) {
        java.net.URI u = null;
        try { u = new java.net.URI(url); } catch (Exception e) { return "目标地址无效 (" + url + ")"; }
        if (u.getScheme() == null || u.getHost() == null) return "目标地址无效 (" + url + ")";
        if (u.getScheme().equalsIgnoreCase("http") && !isLoopbackHost(u.getHost())) {
            return "安全限制：非本机地址必须使用 HTTPS（如 https://<电脑名>.ts.net），避免连接码与 Cookie 明文泄露。";
        }
        return null;
    }

    /** 当前 targetUrl 的安全校验 */
    private String assertSecureTarget() { return validateTargetUrl(targetUrl); }

    /** 读取地址字段，校验 + 持久化 + 更新 targetUrl；返回错误文案或 null（成功） */
    private String resolveAndSaveAddress() {
        String url = addrInput.getText().toString().trim();
        if (url.isEmpty()) return "请输入服务器地址";
        String err = validateTargetUrl(url);
        if (err != null) return err;
        targetUrl = url.endsWith("/") ? url : url + "/";
        getSharedPreferences(PREFS, MODE_PRIVATE).edit().putString(KEY_URL, targetUrl).apply();
        return null;
    }

    /** 仅允许导航到网关同源（scheme+host+port 完全一致） */
    private boolean isAllowedNavigation(String url) {
        java.net.URI base = targetUri();
        if (base == null) return false;
        try {
            java.net.URI nav = new java.net.URI(url);
            String bScheme = base.getScheme(), nScheme = nav.getScheme();
            String bHost = base.getHost(), nHost = nav.getHost();
            if (bScheme == null || nScheme == null || bHost == null || nHost == null) return false;
            if (!nScheme.equalsIgnoreCase(bScheme)) return false;
            if (!nHost.equalsIgnoreCase(bHost)) return false;
            int bp = base.getPort(), np = nav.getPort();
            if (bp == -1) bp = bScheme.equalsIgnoreCase("https") ? 443 : 80;
            if (np == -1) np = nScheme.equalsIgnoreCase("https") ? 443 : 80;
            return bp == np;
        } catch (Exception e) { return false; }
    }

    // ================= 认证流程 =================
    private String deviceId() {
        return Settings.Secure.getString(getContentResolver(), Settings.Secure.ANDROID_ID);
    }

    private String deviceModel() {
        return Build.MANUFACTURER + " " + Build.MODEL;
    }

    private String imei() {
        try {
            if (Build.VERSION.SDK_INT >= 29) return ""; // Android 10+ 普通应用不可读 IMEI
            TelephonyManager tm = (TelephonyManager) getSystemService(Context.TELEPHONY_SERVICE);
            if (tm == null) return "";
            @SuppressWarnings("deprecation")
            String im = tm.getDeviceId();
            return im == null ? "" : im;
        } catch (Exception e) { return ""; }
    }

    private void checkAuthThenLoad() {
        new Thread(new Runnable() { public void run() {
            final String sec = assertSecureTarget();
            if (sec != null) {
                // 地址不安全/无效：转到配对页让用户改地址，而非死胡同
                runOnUiThread(new Runnable() { public void run() { showPairView(); setStatus(sec); } });
                return;
            }
            try {
                HttpURLConnection c = openConn(targetUrl + "__gw/auth-check", "GET");
                int code = c.getResponseCode();
                c.disconnect();
                if (code == 200) {
                    runOnUiThread(new Runnable() { public void run() { loadGui(); } });
                } else {
                    runOnUiThread(new Runnable() { public void run() { showPairView(); } });
                }
            } catch (Exception e) {
                final String msg = e.getMessage() == null ? "unknown" : e.getMessage();
                runOnUiThread(new Runnable() { public void run() {
                    showPairView();
                    setStatus("无法连接服务器: " + msg + "\n请在“服务器地址”填入 https://<电脑名>.ts.net（Tailscale）");
                } });
            }
        } }).start();
    }

    private void showPairView() {
        webView.setVisibility(View.GONE);
        pairView.setVisibility(View.VISIBLE);
        statusText.setVisibility(View.GONE);
        codeInput.setText("");
        if (addrInput != null) addrInput.setText(targetUrl);
    }

    private void loadGui() {
        pairView.setVisibility(View.GONE);
        webView.setVisibility(View.VISIBLE);
        webView.loadUrl(targetUrl);
    }

    private void showFatal(String msg) {
        webView.setVisibility(View.VISIBLE);
        pairView.setVisibility(View.GONE);
        String html = "<html><body style='background:#0b0d10;color:#e8eaed;font-family:sans-serif;"
                + "display:flex;align-items:center;justify-content:center;height:100vh;margin:0;text-align:center'>"
                + "<div style='max-width:90%'><h2>⚠️</h2><p style='font-size:16px;word-break:break-all'>"
                + msg.replace("\n", "<br>").replace("&", "&amp;").replace("<", "&lt;") + "</p></div></body></html>";
        webView.loadDataWithBaseURL(null, html, "text/html", "utf-8", null);
    }

    private void doPair() {
        String addrErr = resolveAndSaveAddress();
        if (addrErr != null) { setStatus(addrErr); return; }
        String code = codeInput.getText().toString().trim();
        if (code.isEmpty()) { setStatus("请输入连接码"); return; }
        setStatus(null);
        statusText.setVisibility(View.VISIBLE);
        statusText.setTextColor(Color.rgb(154, 163, 175));
        statusText.setText("连接中…");

        String body = "{\"code\":\"" + esc(code) + "\",\"deviceId\":\"" + esc(deviceId())
                + "\",\"model\":\"" + esc(deviceModel()) + "\",\"imei\":\"" + esc(imei()) + "\"}";

        new Thread(new Runnable() { public void run() {
            try {
                HttpURLConnection c = openConn(targetUrl + "__gw/pair", "POST");
                c.setRequestProperty("Content-Type", "application/json");
                c.setDoOutput(true);
                OutputStream os = c.getOutputStream();
                os.write(body.getBytes("UTF-8"));
                os.close();
                int rc = c.getResponseCode();
                StringBuilder sb = new StringBuilder();
                BufferedReader br = new BufferedReader(new InputStreamReader(
                        rc >= 400 ? c.getErrorStream() : c.getInputStream(), "UTF-8"));
                String line;
                while ((line = br.readLine()) != null) sb.append(line);
                br.close();
                String resp = sb.toString();

                // 捕获 Set-Cookie 写入 CookieManager
                String setCookie = c.getHeaderField("Set-Cookie");
                c.disconnect();

                if (rc == 200) {
                    if (setCookie != null) {
                        String cookieVal = setCookie.split(";")[0];
                        CookieManager.getInstance().setCookie(targetUrl, cookieVal);
                        CookieManager.getInstance().flush();
                    }
                    runOnUiThread(new Runnable() { public void run() { loadGui(); } });
                } else {
                    final String reason = parseReason(resp);
                    runOnUiThread(new Runnable() { public void run() { setStatus(reason); } });
                }
            } catch (Exception e) {
                final String em = e.getMessage() == null ? "unknown" : e.getMessage();
                runOnUiThread(new Runnable() { public void run() { setStatus("连接失败: " + em); } });
            }
        } }).start();
    }

    private String parseReason(String resp) {
        try {
            org.json.JSONObject o = new org.json.JSONObject(resp);
            String r = o.optString("reason", "");
            if ("bound_other".equals(r)) return "此连接码已绑定其他设备，无法使用";
            if ("invalid_code".equals(r)) return "连接码错误";
            if ("rate_limited".equals(r)) return "尝试过于频繁，请稍后再试";
            return o.optString("error", resp);
        } catch (Exception e) { return resp; }
    }

    private void setStatus(String msg) {
        statusText.setVisibility(msg == null ? View.GONE : View.VISIBLE);
        if (msg != null) { statusText.setTextColor(Color.rgb(248, 113, 113)); statusText.setText(msg); }
    }

    private String esc(String s) {
        return s == null ? "" : s.replace("\\", "\\\\").replace("\"", "\\\"");
    }

    private HttpURLConnection openConn(String urlStr, String method) throws Exception {
        URL u = new URL(urlStr);
        HttpURLConnection c = (HttpURLConnection) u.openConnection();
        c.setRequestMethod(method);
        c.setConnectTimeout(8000);
        c.setReadTimeout(8000);
        c.setInstanceFollowRedirects(true);
        // HttpURLConnection 与 WebView CookieManager 相互独立：手动带上已存 cookie
        String cookie = CookieManager.getInstance().getCookie(targetUrl);
        if (cookie != null && !cookie.isEmpty()) {
            c.setRequestProperty("Cookie", cookie);
        }
        return c;
    }

    private boolean isNetworkAvailable() {
        ConnectivityManager cm = (ConnectivityManager) getSystemService(Context.CONNECTIVITY_SERVICE);
        NetworkInfo ni = cm == null ? null : cm.getActiveNetworkInfo();
        return ni != null && ni.isConnected();
    }

    @Override
    public boolean onKeyDown(int keyCode, KeyEvent event) {
        if (keyCode == KeyEvent.KEYCODE_BACK) {
            if (pairView.getVisibility() == View.VISIBLE) { finish(); return true; }
            if (webView.canGoBack()) { webView.goBack(); return true; }
        }
        return super.onKeyDown(keyCode, event);
    }

    @Override
    protected void onResume() { super.onResume(); if (webView != null) webView.onResume(); }
    @Override
    protected void onPause() { if (webView != null) webView.onPause(); super.onPause(); }
    @Override
    protected void onDestroy() { if (webView != null) webView.destroy(); super.onDestroy(); }
}
