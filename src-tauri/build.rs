// Build script for the Tauri shell.
//
// Windows manifest strategy — production and tests share the SAME manifest:
//
//   tauri-build's default `WindowsAttributes::new()` embeds the Common
//   Controls v6 manifest (its windows-app-manifest.xml) into the app via a
//   generated .rc resource (`resource.lib`). That resource is only linked
//   into the *main binary*; the lib test harness never sees it, so `cargo
//   test` on Windows crashed at startup with STATUS_ENTRYPOINT_NOT_FOUND
//   (0xc0000139) — the loader resolved TaskDialogIndirect & co. against
//   comctl32 v5 (console default) instead of v6.
//
//   Instead of papering over the difference (embedding a manifest only into
//   tests), we make behaviour uniform:
//     1. disable tauri's .rc manifest (`new_without_app_manifest`), keeping
//        icon/version resources,
//     2. embed our own manifest — byte-identical to tauri's default — for
//        EVERY target via `rustc-link-arg` (bins, lib test harness, bin test
//        harness).
//   Production exe and both test binaries then carry exactly the same
//   manifest, so `cargo test` exercises the same loader behaviour as the app.
fn main() {
    #[cfg(all(windows, target_env = "msvc"))]
    {
        let attributes = tauri_build::Attributes::new().windows_attributes(
            tauri_build::WindowsAttributes::new_without_app_manifest(),
        );
        tauri_build::try_build(attributes).expect("failed to run tauri-build");

        let manifest = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("tests-manifest.xml");
        println!("cargo:rerun-if-changed={}", manifest.display());
        println!("cargo::rustc-link-arg=/MANIFEST:EMBED");
        println!(
            "cargo::rustc-link-arg=/MANIFESTINPUT:{}",
            manifest.to_str().expect("manifest path must be valid UTF-8")
        );
    }

    #[cfg(not(all(windows, target_env = "msvc")))]
    {
        tauri_build::build();
    }
}
