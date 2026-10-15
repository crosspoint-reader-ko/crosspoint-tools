// Link the WinDivert import library directly (the sidecar calls the raw FFI
// rather than the safe `windivert` crate, so it can control the WinDivert
// address bytes needed for cross-layer reply injection). WinDivert.dll must sit
// next to the built exe at runtime (the installer bundles it). `WINDIVERT_PATH`
// points at the SDK libs during CI; otherwise fall back to the vendored copy.
fn main() {
    if std::env::var("CARGO_CFG_TARGET_OS").as_deref() != Ok("windows") {
        return;
    }
    if let Ok(p) = std::env::var("WINDIVERT_PATH") {
        println!("cargo:rustc-link-search=native={p}");
    }
    let manifest = std::env::var("CARGO_MANIFEST_DIR").unwrap();
    println!("cargo:rustc-link-search=native={manifest}/../../vendor/windivert/x64");
    println!("cargo:rustc-link-lib=dylib=WinDivert");
    println!("cargo:rerun-if-env-changed=WINDIVERT_PATH");
}
