//! 시스템 절전 방지 (Electron powerSaveBlocker 'prevent-app-suspension' 대응).

#[cfg(windows)]
pub fn prevent_system_sleep() {
    use windows::Win32::System::Power::{ES_CONTINUOUS, ES_SYSTEM_REQUIRED, SetThreadExecutionState};
    // ES_CONTINUOUS 상태는 호출한 스레드가 살아 있는 동안만 유지되므로 전용 스레드에서 대기한다.
    std::thread::spawn(|| {
        unsafe {
            SetThreadExecutionState(ES_CONTINUOUS | ES_SYSTEM_REQUIRED);
        }
        loop {
            std::thread::park();
        }
    });
}

#[cfg(not(windows))]
pub fn prevent_system_sleep() {}
