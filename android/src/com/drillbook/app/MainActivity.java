package com.drillbook.app;

import android.app.Activity;
import android.content.ActivityNotFoundException;
import android.content.Intent;
import android.content.pm.PackageInfo;
import android.net.Uri;
import android.os.Build;
import android.os.Bundle;
import android.os.Handler;
import android.os.Looper;
import android.view.ViewGroup;
import android.view.WindowInsets;
import android.webkit.JavascriptInterface;
import android.webkit.WebResourceRequest;
import android.webkit.WebResourceResponse;
import android.webkit.WebSettings;
import android.webkit.WebView;
import android.webkit.WebViewClient;
import android.widget.FrameLayout;

import org.json.JSONObject;

import java.io.ByteArrayInputStream;
import java.io.ByteArrayOutputStream;
import java.io.IOException;
import java.io.InputStream;
import java.io.OutputStream;
import java.net.HttpURLConnection;
import java.net.InetAddress;
import java.net.URL;
import java.nio.charset.StandardCharsets;
import java.util.Collections;
import java.util.Iterator;
import java.util.Locale;
import java.util.Map;
import java.util.concurrent.ConcurrentHashMap;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.regex.Pattern;

/**
 * Drillbook for phones: a shell with nothing but a WebView.
 *
 * <ul>
 *   <li>The site code (web/) is packed into assets/web/ and served to the WebView as https://appassets.androidplatform.net/, so it works offline</li>
 *   <li>Topics, answer records and notes are stored in the WebView's IndexedDB (the app's own storage, cleared only when the app is uninstalled)</li>
 *   <li>Through window.DrillbookNative the page has this class send its HTTP requests to the computer; only LAN addresses are allowed</li>
 * </ul>
 */
public class MainActivity extends Activity {
    private static final String HOST = "appassets.androidplatform.net";
    private static final String HOME = "https://" + HOST + "/index.html";
    private static final int BG = 0xFF0D1524;
    private static final Pattern IPV4 = Pattern.compile("^\\d{1,3}(\\.\\d{1,3}){3}$");

    private final ExecutorService pool = Executors.newFixedThreadPool(3);
    private final Map<String, String> results = new ConcurrentHashMap<>();
    private final Handler main = new Handler(Looper.getMainLooper());
    private WebView web;

    @Override
    protected void onCreate(Bundle state) {
        super.onCreate(state);
        FrameLayout root = new FrameLayout(this);
        root.setBackgroundColor(BG);
        web = new WebView(this);
        web.setBackgroundColor(BG);
        root.addView(web, new FrameLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT));

        if (Build.VERSION.SDK_INT >= 30) {
            // Keep clear of the status bar, navigation bar and keyboard ourselves (from Android 15 on, apps fill the whole screen by default)
            getWindow().setDecorFitsSystemWindows(false);
            root.setOnApplyWindowInsetsListener((v, insets) -> {
                android.graphics.Insets i = insets.getInsets(
                        WindowInsets.Type.systemBars() | WindowInsets.Type.displayCutout() | WindowInsets.Type.ime());
                v.setPadding(i.left, i.top, i.right, i.bottom);
                return WindowInsets.CONSUMED;
            });
        }

        WebSettings s = web.getSettings();
        s.setJavaScriptEnabled(true);
        s.setDomStorageEnabled(true);
        s.setAllowFileAccess(false);
        s.setAllowContentAccess(false);
        s.setMediaPlaybackRequiresUserGesture(true);
        WebView.setWebContentsDebuggingEnabled(true); // with a USB cable to a computer, chrome://inspect can be used to debug
        web.addJavascriptInterface(new Bridge(), "DrillbookNative");
        web.setWebViewClient(new Client());
        setContentView(root);

        if (state != null) web.restoreState(state);
        if (web.getUrl() == null) web.loadUrl(HOME);
    }

    @Override
    public void onBackPressed() {
        if (web.canGoBack()) web.goBack();
        else super.onBackPressed();
    }

    @Override
    protected void onSaveInstanceState(Bundle out) {
        super.onSaveInstanceState(out);
        web.saveState(out);
    }

    @Override
    protected void onPause() {
        web.onPause();
        super.onPause();
    }

    @Override
    protected void onResume() {
        super.onResume();
        web.onResume();
    }

    @Override
    protected void onDestroy() {
        pool.shutdownNow();
        web.destroy();
        web = null;
        super.onDestroy();
    }

    private class Client extends WebViewClient {
        // Site files are read from the APK's assets/web/
        @Override
        public WebResourceResponse shouldInterceptRequest(WebView view, WebResourceRequest request) {
            Uri u = request.getUrl();
            if (!HOST.equals(u.getHost())) return null;
            String path = u.getPath();
            if (path == null || path.isEmpty() || path.equals("/")) path = "/index.html";
            if (path.contains("..")) return notFound();
            try {
                InputStream in = getAssets().open("web" + path);
                String mime = mimeOf(path);
                boolean text = mime.startsWith("text/") || mime.equals("application/json") || mime.equals("image/svg+xml");
                WebResourceResponse r = new WebResourceResponse(mime, text ? "utf-8" : null, in);
                r.setResponseHeaders(Collections.singletonMap("Cache-Control", "no-cache"));
                return r;
            } catch (IOException e) {
                return notFound();
            }
        }

        // External links open in the system browser, not inside the app
        @Override
        public boolean shouldOverrideUrlLoading(WebView view, WebResourceRequest request) {
            Uri u = request.getUrl();
            if (HOST.equals(u.getHost())) return false;
            try {
                startActivity(new Intent(Intent.ACTION_VIEW, u));
            } catch (ActivityNotFoundException ignored) {
                // no app can open it
            }
            return true;
        }
    }

    private class Bridge {
        @JavascriptInterface
        public String info() {
            JSONObject o = new JSONObject();
            try {
                PackageInfo p = getPackageManager().getPackageInfo(getPackageName(), 0);
                o.put("versionName", p.versionName);
                o.put("model", Build.MODEL);
                o.put("manufacturer", Build.MANUFACTURER);
                o.put("sdk", Build.VERSION.SDK_INT);
            } catch (Exception ignored) {
                // whatever can't be read is left out
            }
            return o.toString();
        }

        // Sends the request on a background thread, then calls window.__drillbookNative(id, status) in the page; the body is fetched with take(id)
        @JavascriptInterface
        public void request(final String id, final String method, final String url, final String headers,
                            final String body, final int timeout) {
            pool.execute(() -> {
                int status;
                String text;
                HttpURLConnection c = null;
                try {
                    URL target = new URL(url);
                    if (!allowed(target)) throw new IOException("Only computers on the local network are allowed");
                    c = (HttpURLConnection) target.openConnection();
                    int t = Math.max(1000, timeout);
                    c.setConnectTimeout(Math.min(t, 10000));
                    c.setReadTimeout(t);
                    c.setUseCaches(false);
                    c.setInstanceFollowRedirects(false);
                    c.setRequestMethod(method);
                    JSONObject h = new JSONObject(headers == null || headers.isEmpty() ? "{}" : headers);
                    Iterator<String> keys = h.keys();
                    while (keys.hasNext()) {
                        String k = keys.next();
                        c.setRequestProperty(k, h.optString(k));
                    }
                    if (body != null && !body.isEmpty() && !"GET".equals(method)) {
                        byte[] b = body.getBytes(StandardCharsets.UTF_8);
                        c.setDoOutput(true);
                        c.setFixedLengthStreamingMode(b.length);
                        try (OutputStream out = c.getOutputStream()) {
                            out.write(b);
                        }
                    }
                    status = c.getResponseCode();
                    InputStream in = status >= 400 ? c.getErrorStream() : c.getInputStream();
                    text = in == null ? "" : readAll(in);
                } catch (Exception e) {
                    status = 0;
                    text = e.getClass().getSimpleName() + ": " + e.getMessage();
                } finally {
                    if (c != null) c.disconnect();
                }
                results.put(id, text);
                final String js = "window.__drillbookNative&&window.__drillbookNative(" + JSONObject.quote(id) + "," + status + ")";
                main.post(() -> {
                    if (web != null) web.evaluateJavascript(js, null);
                });
            });
        }

        @JavascriptInterface
        public String take(String id) {
            String t = results.remove(id);
            return t == null ? "" : t;
        }
    }

    // Only http(s) to LAN IPv4 addresses (10.x, 172.16-31.x, 192.168.x) and this device
    private static boolean allowed(URL u) {
        String p = u.getProtocol();
        if (!"http".equals(p) && !"https".equals(p)) return false;
        String host = u.getHost();
        if ("localhost".equalsIgnoreCase(host)) return true;
        if (!IPV4.matcher(host).matches()) return false;
        try {
            InetAddress a = InetAddress.getByName(host);
            return a.isSiteLocalAddress() || a.isLoopbackAddress();
        } catch (Exception e) {
            return false;
        }
    }

    private static String readAll(InputStream in) throws IOException {
        try (InputStream s = in) {
            ByteArrayOutputStream out = new ByteArrayOutputStream();
            byte[] buf = new byte[16384];
            int n;
            while ((n = s.read(buf)) != -1) out.write(buf, 0, n);
            return new String(out.toByteArray(), StandardCharsets.UTF_8);
        }
    }

    private static WebResourceResponse notFound() {
        return new WebResourceResponse("text/plain", "utf-8", 404, "Not Found",
                Collections.<String, String>emptyMap(), new ByteArrayInputStream(new byte[0]));
    }

    private static String mimeOf(String path) {
        String p = path.toLowerCase(Locale.ROOT);
        if (p.endsWith(".html")) return "text/html";
        if (p.endsWith(".js") || p.endsWith(".mjs")) return "text/javascript";
        if (p.endsWith(".css")) return "text/css";
        if (p.endsWith(".json")) return "application/json";
        if (p.endsWith(".svg")) return "image/svg+xml";
        if (p.endsWith(".png")) return "image/png";
        if (p.endsWith(".jpg") || p.endsWith(".jpeg")) return "image/jpeg";
        if (p.endsWith(".woff2")) return "font/woff2";
        if (p.endsWith(".woff")) return "font/woff";
        if (p.endsWith(".ttf")) return "font/ttf";
        if (p.endsWith(".ico")) return "image/x-icon";
        return "application/octet-stream";
    }
}
