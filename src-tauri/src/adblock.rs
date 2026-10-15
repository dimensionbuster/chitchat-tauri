//! YouTube/Google 광고 요청 차단 (Electron의 session.webRequest.onBeforeRequest 대응).
//! WebView2의 WebResourceRequested 필터에 광고 URL 패턴을 등록하고, 일치하면 403으로 응답한다.

#[cfg(windows)]
const BLOCK_PATTERNS: &[&str] = &[
    // YouTube 광고 API
    "*://www.youtube.com/youtubei/v1/player/ad_break*",
    "*://www.youtube.com/api/stats/ads*",
    "*://www.youtube.com/pagead/*",
    "*://www.youtube.com/ptracking*",
    // Google 광고 네트워크
    "*://pagead2.googlesyndication.com/*",
    "*://www.googleadservices.com/*",
    "*://googleads.g.doubleclick.net/*",
    "*://*.googlesyndication.com/*",
    "*://ad.doubleclick.net/*",
    // 광고 추적 스크립트
    "*://www.google.com/pagead/*",
    "*://www.gstatic.com/adsense/*",
    // IMA SDK (광고 플레이어)
    "*://imasdk.googleapis.com/*",
];

/// `*`만 지원하는 단순 와일드카드 매칭 (대소문자 무시).
#[cfg(windows)]
fn wildcard_match(pattern: &str, text: &str) -> bool {
    let p: Vec<char> = pattern.to_ascii_lowercase().chars().collect();
    let t: Vec<char> = text.to_ascii_lowercase().chars().collect();
    let (mut pi, mut ti, mut star, mut mark) = (0usize, 0usize, None::<usize>, 0usize);
    while ti < t.len() {
        if pi < p.len() && p[pi] == '*' {
            star = Some(pi);
            mark = ti;
            pi += 1;
        } else if pi < p.len() && p[pi] == t[ti] {
            pi += 1;
            ti += 1;
        } else if let Some(s) = star {
            pi = s + 1;
            mark += 1;
            ti = mark;
        } else {
            return false;
        }
    }
    while pi < p.len() && p[pi] == '*' {
        pi += 1;
    }
    pi == p.len()
}

/// WebView2의 요청 필터/핸들러는 웹뷰 전체에서 공유된다. wry가 등록한 ipc/asset 같은 내부 요청도
/// 이 핸들러를 거치므로, 차단 대상 URL일 때만 응답을 덮어써야 한다.
#[cfg(windows)]
fn is_blocked(url: &str) -> bool {
    BLOCK_PATTERNS.iter().any(|pattern| wildcard_match(pattern, url))
}

#[cfg(windows)]
pub fn install(window: &tauri::WebviewWindow) {
    use webview2_com::Microsoft::Web::WebView2::Win32::{
        COREWEBVIEW2_WEB_RESOURCE_CONTEXT_ALL, ICoreWebView2_2,
    };
    use webview2_com::WebResourceRequestedEventHandler;
    use windows::core::{HSTRING, Interface, w};

    let label = window.label().to_string();
    let result = window.with_webview(move |webview| unsafe {
        let Ok(core) = webview.controller().CoreWebView2() else {
            return;
        };
        let Ok(core2) = core.cast::<ICoreWebView2_2>() else {
            return;
        };
        let Ok(env) = core2.Environment() else {
            return;
        };

        for pattern in BLOCK_PATTERNS {
            let _ = core.AddWebResourceRequestedFilter(
                &HSTRING::from(*pattern),
                COREWEBVIEW2_WEB_RESOURCE_CONTEXT_ALL,
            );
        }

        let handler = WebResourceRequestedEventHandler::create(Box::new(move |_sender, args| {
            let Some(args) = args else { return Ok(()) };
            let request = args.Request()?;
            let mut uri = windows::core::PWSTR::null();
            request.Uri(&mut uri)?;
            let url = webview2_com::take_pwstr(uri);
            if is_blocked(&url) {
                let response = env.CreateWebResourceResponse(None, 403, w!("Blocked"), w!(""))?;
                args.SetResponse(&response)?;
            }
            Ok(())
        }));
        let mut token = Default::default();
        let _ = core.add_WebResourceRequested(&handler, &mut token);
    });
    if let Err(e) = result {
        log::warn!("[adblock] failed to install for {label}: {e}");
    }
}

#[cfg(not(windows))]
pub fn install(_window: &tauri::WebviewWindow) {}
