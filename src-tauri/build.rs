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
//       icon/version resources,
//     2. embed our own manifest — byte-identical to tauri's default — for
//       EVERY target via `rustc-link-arg` (bins, lib test harness, bin test
//       harness).
//   Production exe and both test binaries then carry exactly the same
//   manifest, so `cargo test` exercises the same loader behaviour as the app.
//
// Sidecar strategy — the build never depends on a hand-run step:
//
//   `tauri.conf.json` declares `bundle.externalBin: ["binaries/host"]`, and
//   tauri-build 2.6 copies `binaries/host-<target-triple>[.exe]` into the
//   output dir on EVERY build (including `cargo check`/`cargo test`), failing
//   the build script when the file is absent. That artifact is git-ignored and
//   only `scripts/build-host.ts` produces it, so a fresh clone used to fail
//   with `resource path ... doesn't exist`.
//
//   We therefore build it here on demand: if the artifact for the target
//   triple is missing we invoke the same script the npm task uses
//   (`bun run scripts/build-host.ts --target-triple <triple>`), so
//   `cargo check`, `cargo test`, `cargo tauri dev` and `cargo tauri build` all
//   work from a clean checkout with no manual step. When the artifact already
//   exists (the normal case after the first build, and always during
//   `cargo tauri build` because `beforeBuildCommand` builds it first) this is
//   a single `fs::metadata` call.

use std::ffi::OsString;
use std::path::{Path, PathBuf};
use std::process::Command;

fn main() {
    // Android: the host sidecar is skipped, but NOT because bun lacks an Android
    // target — it does not. Verified 2026-09-11: bun 1.4.2 cross-compiles
    // `--target=bun-linux-arm64-android` and `bun-linux-x64-android` successfully,
    // producing valid ELF binaries (AArch64 e_machine 0xb7 / x86-64 0x3e). Note
    // the spelling: android only exists combined with linux, never as plain
    // `bun-android-*`.
    //
    // The real reason is that this repo has not wired that target up:
    // `scripts/build-host.ts` RUST_TO_BUN_TARGET has no android row, so
    // `bunTargetForTriple` would fail-fast for a TARGET like
    // aarch64-linux-android and `tauri android build` would die inside
    // ensure_host_sidecar. Two further unknowns gate turning it on: whether a
    // bun-compiled host can actually EXECUTE on Android (W^X / data-directory
    // exec restrictions — unverified), and whether the host's runtime deps
    // (chokidar fs-watch, a `ws` localhost listener) behave there.
    //
    // Until that is settled the sidecar stays desktop-only and Android CI
    // validates the shell + face, as its job comment says.
    if !is_android_target() {
        ensure_host_sidecar();
    }

    #[cfg(all(windows, target_env = "msvc"))]
    {
        let attributes = tauri_build::Attributes::new()
            .windows_attributes(tauri_build::WindowsAttributes::new_without_app_manifest());
        tauri_build::try_build(attributes).expect("failed to run tauri-build");

        let manifest = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("tests-manifest.xml");
        println!("cargo:rerun-if-changed={}", manifest.display());
        println!("cargo::rustc-link-arg=/MANIFEST:EMBED");
        println!(
            "cargo::rustc-link-arg=/MANIFESTINPUT:{}",
            manifest
                .to_str()
                .expect("manifest path must be valid UTF-8")
        );
    }

    #[cfg(not(all(windows, target_env = "msvc")))]
    {
        tauri_build::build();
    }
}

/// Absolute path of the sidecar artifact Tauri's `externalBin` expects for the
/// compile target (`binaries/host-<target-triple>[.exe]`).
fn sidecar_path() -> PathBuf {
    let triple = std::env::var("TARGET").expect("cargo always sets TARGET for build scripts");
    let name = if triple.contains("windows") {
        format!("host-{triple}.exe")
    } else {
        format!("host-{triple}")
    };
    Path::new(env!("CARGO_MANIFEST_DIR"))
        .join("binaries")
        .join(name)
}

/// True when compiling for an Android target (`*-linux-android*`).
fn is_android_target() -> bool {
    std::env::var("TARGET")
        .map(|triple| triple.contains("linux-android"))
        .unwrap_or(false)
}

fn ensure_host_sidecar() {
    let artifact = sidecar_path();
    let repo_root = Path::new(env!("CARGO_MANIFEST_DIR"))
        .parent()
        .expect("src-tauri always lives inside the repo root")
        .to_path_buf();
    let script = repo_root.join("scripts").join("build-host.ts");

    // Watch every host input so a source edit re-runs this script, and treat a
    // stale artifact (older than any input) exactly like a missing one — a
    // `cargo build` that skipped `build:host` must not keep using an old sidecar.
    let inputs = host_inputs(&repo_root);
    for input in &inputs {
        println!("cargo:rerun-if-changed={}", input.display());
    }
    println!("cargo:rerun-if-changed={}", artifact.display());

    let reason = if !artifact.is_file() {
        Some("missing")
    } else if is_stale(&artifact, &inputs) {
        Some("stale (host sources changed)")
    } else {
        None
    };
    let Some(reason) = reason else {
        return;
    };

    let triple = std::env::var("TARGET").expect("cargo always sets TARGET for build scripts");
    println!(
        "cargo:warning=host sidecar {reason} at {} — building it now via `bun run scripts/build-host.ts`",
        artifact.display()
    );

    let args: Vec<OsString> = vec![
        "run".into(),
        script.clone().into_os_string(),
        "--target-triple".into(),
        triple.into(),
    ];

    // The build step is idempotent, so a transient failure is worth retrying
    // before giving up. On Windows `bun build --compile` reads the `.bun`
    // virtual store (node_modules/.bun/...) and can hit EPERM while another
    // process (AV scan, an install handle not yet released) briefly holds a
    // file — a race that shows up sporadically on CI, never deterministically.
    // Retry with a short backoff; a real configuration error still fails
    // hard after the budget is exhausted (never silently downgraded).
    const ATTEMPTS: u32 = 3;
    let mut last_failure = String::new();
    let mut sidecar_ok = false;
    for attempt in 1..=ATTEMPTS {
        if attempt > 1 {
            std::thread::sleep(std::time::Duration::from_millis(
                1500 * u64::from(attempt - 1),
            ));
            println!(
                "cargo:warning=host sidecar build attempt {attempt}/{ATTEMPTS} (previous: {last_failure})"
            );
        }
        match spawn_bun(&args, &repo_root) {
            Ok(status) if status.success() && artifact.is_file() => {
                sidecar_ok = true;
                break;
            }
            Ok(status) => {
                last_failure = format!("`bun run build-host.ts` exited with {status}");
            }
            Err(error) => {
                last_failure = format!("failed to spawn bun: {error}");
            }
        }
    }
    if !sidecar_ok {
        panic!(
            "failed to build the host sidecar after {ATTEMPTS} attempts: {last_failure}. \
             Run `bun run build:host` manually to see the full output (or set VRCXK_BUN \
             to the bun executable)"
        );
    }
}

/// Every file that feeds the compiled sidecar: the host sources, the build
/// script, and the contracts/lockfiles the host reads or bundles.
fn host_inputs(repo_root: &Path) -> Vec<PathBuf> {
    let mut files = Vec::new();
    for dir in ["host/src", "host/plugins", "scripts", "contracts"] {
        collect_files(&repo_root.join(dir), 0, &mut files);
    }
    for file in [
        "host/cordis.yml",
        "host/package.json",
        "package.json",
        "bun.lock",
    ] {
        let path = repo_root.join(file);
        if path.is_file() {
            files.push(path);
        }
    }
    files
}

fn collect_files(root: &Path, depth: usize, out: &mut Vec<PathBuf>) {
    const MAX_DEPTH: usize = 8;
    if depth > MAX_DEPTH {
        return;
    }
    let Ok(entries) = std::fs::read_dir(root) else {
        return;
    };
    for entry in entries.flatten() {
        let name = entry.file_name();
        let name = name.to_string_lossy();
        if matches!(
            name.as_ref(),
            "node_modules" | "dist" | ".git" | "target" | ".temp"
        ) {
            continue;
        }
        let path = entry.path();
        match entry.file_type() {
            Ok(kind) if kind.is_dir() => collect_files(&path, depth + 1, out),
            Ok(kind) if kind.is_file() => out.push(path),
            _ => {}
        }
    }
}

/// True when any input is newer than the artifact.
fn is_stale(artifact: &Path, inputs: &[PathBuf]) -> bool {
    let Ok(artifact_time) = artifact.metadata().and_then(|meta| meta.modified()) else {
        return true;
    };
    inputs.iter().any(|input| {
        input
            .metadata()
            .and_then(|meta| meta.modified())
            .map(|time| time > artifact_time)
            .unwrap_or(false)
    })
}

/// Run bun, tolerating the Windows npm-shim layout.
///
/// On Windows `PATH` may only expose the npm shim (`bun.cmd`/`bun.ps1`), which
/// `CreateProcess` cannot execute — a direct `Command::new("bun")` then fails
/// with `program not found`. We therefore fall back to `cmd /C bun`, which
/// resolves every shim form.
///
/// `VRCXK_BUN` overrides the executable outright and is fail-fast: an explicit
/// path that cannot be spawned is a configuration error, not a reason to fall
/// back to whatever `bun` happens to be on PATH.
fn spawn_bun(args: &[OsString], cwd: &Path) -> std::io::Result<std::process::ExitStatus> {
    let explicit = std::env::var_os("VRCXK_BUN");
    let mut direct = match &explicit {
        Some(path) => Command::new(path),
        None => Command::new("bun"),
    };
    direct.args(args).current_dir(cwd);
    match direct.status() {
        Ok(status) => Ok(status),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound && explicit.is_none() => {
            #[cfg(windows)]
            {
                let mut via_cmd = Command::new("cmd");
                via_cmd.arg("/C").arg("bun").args(args).current_dir(cwd);
                via_cmd.status()
            }
            #[cfg(not(windows))]
            {
                Err(error)
            }
        }
        Err(error) => Err(error),
    }
}
