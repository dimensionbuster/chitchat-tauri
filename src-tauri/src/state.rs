use std::collections::{BTreeMap, HashMap};
use std::sync::Mutex;
use std::sync::atomic::AtomicBool;
use tokio::sync::oneshot;

/// 다이얼로그 하나의 대기 상태. 창이 닫히거나 close_dialog가 호출되면 결과를 보낸다.
pub struct DialogEntry {
    pub label: String,
    pub parent_label: String,
    pub tx: Option<oneshot::Sender<bool>>,
}

#[derive(Default)]
pub struct AppState {
    /// 트레이 "종료"처럼 진짜 종료할 때만 true. false면 창 닫기는 숨기기로 처리한다.
    pub quitting: AtomicBool,
    /// room_id -> 창 label (열려 있는 채팅방 창)
    pub chat_rooms: Mutex<BTreeMap<String, String>>,
    /// room_id -> 창 label (와치파티)
    pub watch_parties: Mutex<HashMap<String, String>>,
    pub dialogs: Mutex<HashMap<String, DialogEntry>>,
}

/// 창 label은 영문/숫자/-_:/ 만 허용되므로 임의의 방 이름(한글 등)은 hex로 인코딩한다.
pub fn label_for(prefix: &str, id: &str) -> String {
    let hex: String = id.bytes().map(|b| format!("{b:02x}")).collect();
    format!("{prefix}-{hex}")
}
