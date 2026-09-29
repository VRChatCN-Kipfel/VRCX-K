; VRCX-K NSIS installer hooks.
;
; ⚠ TWO MACROS LIVE HERE NOW: `NSIS_HOOK_PREINSTALL` (the write side) and
; `NSIS_HOOK_POSTUNINSTALL` (the delete side). Tauri includes this file into its own template,
; so each macro is inserted at a fixed point — the preinstall one at the very TOP of
; `Section Install` (before anything is written), the postuninstall one at the end of
; `Section Uninstall`. See the per-macro comments for why each exists.
;
; # Why the delete hook exists, when Tauri's template already deletes the deep-link key
;
; The upstream template's uninstall section already has a guarded delete:
;
;     ReadRegStr $R7 SHCTX "Software\Classes\<scheme>\shell\open\command" ""
;     ${If} $R7 == "<our exe> "%1""
;       DeleteRegKey SHCTX "Software\Classes\<scheme>"
;     ${EndIf}
;
; That guard is exact-command-string equality, so four real cases slip past it and leave the
; key behind — all four are recorded in `docs/deep-link-decisions.md` §4.1:
;
;   1. the app was once installed to a DIFFERENT directory (upgrade, user-chosen path), so
;      `$INSTDIR` no longer matches the stored command;
;   2. the key was written by the app's own runtime `register` rather than by the installer;
;   3. a user or a security tool edited `shell\open\command`;
;   4. the declared scheme name changed, so nothing declares the old one any more.
;
; # ⚠ Why that is a bare DeleteRegKey on ONE name, and not a scan
;
; The bound is the point. `vrcxk` is the ONLY scheme this build declares
; (`tauri.conf.json` → `plugins.deep-link.desktop.schemes`, pinned by
; `the_uninstaller_cleans_up_every_declared_scheme` in `src-tauri/src/lib.rs`), so a key under
; that exact name is ours to remove: our installer wrote it, or our app's runtime registration
; did.
;
; What this deliberately does NOT do:
;   - it does not enumerate or pattern-match class keys ("vrcxk*" and friends): a class key
;     that is not exactly a declared name is not ours to delete, and deleting a foreign
;     handler is strictly worse than leaving a stale one of ours (an existing class key
;     cannot be restored — §4.2 of the decision record);
;   - it does not try to restore an overwritten value. That is impossible by construction
;     (`unregister` is a `remove_tree`).
;
; ⚠ MSI IS NOT COVERED HERE. The WiX template registers the scheme under `Root="HKLM"`
; (machine-wide, per-machine installs) while this NSIS hook — like the rest of the NSIS
; template — uses `SHCTX` (per-user installs ⇒ HKCU). Both installers ship
; (`bundle.targets = "all"`, the owner's decision), so MSI uninstall cleanliness is a separate
; question that must be verified on a real machine; see `docs/deep-link-decisions.md` §7.2.

; ── the WRITE side: refuse to take over somebody else's class key ────────────────────────────
;
; ⚠ WHY THIS EXISTS (issue #41 §4.2 + PR #49 review ③ — a real hole, not a formality):
; upstream's `Section Install` writes the deep-link class key with FOUR BARE `WriteRegStr`
; calls and **no ownership check whatsoever**, while its own UNINSTALL section *does* compare
; the command before deleting (write unchecked, delete checked — exactly backwards). So the
; invariant "claiming an existing class key is refused" used to hold only on the **runtime**
; path, which normal users never take; the installer path is the one they do take, on every
; install. And an overwritten class key cannot be restored.
;
; Placement: `NSIS_HOOK_PREINSTALL` sits at the very top of `Section Install`, i.e. before the
; template writes anything. The expected value is computed exactly the way the template
; computes the value it is about to write: `"$INSTDIR\${MAINBINARYNAME}.exe" "%1"`
; (`${MAINBINARYNAME}` is defined later in the template, which is fine: `!define` substitution
; happens when this macro is *inserted*, not when it is defined here).
;
; On a collision we ABORT the section and force a non-zero exit code:
;   - `Abort` skips the rest of the section, so none of our files or keys are written;
;   - `SetErrorLevel 1` makes a **silent** (`/S`) install report failure — silent runs show no
;     dialog, so without it a refusal would look exactly like a success (measured: an aborted
;     silent install exits 1, a successful one 0);
;   - `/SD IDOK` keeps the message box from hanging an unattended run.
;
; An existing key whose command value is EMPTY is treated as free — same rule as the runtime
; gate's "Absent ⇒ nothing to collide with".
!macro NSIS_HOOK_PREINSTALL
  ; Keep the name in lockstep with plugins.deep-link.desktop.schemes in tauri.conf.json — the
  ; packaging test asserts every declared scheme appears here.
  ReadRegStr $R8 SHCTX "Software\Classes\vrcxk\shell\open\command" ""
  ${If} $R8 != ""
    ${If} $R8 != '"$INSTDIR\${MAINBINARYNAME}.exe" "%1"'
      SetErrorLevel 1
      MessageBox MB_ICONSTOP|MB_OK "VRCX-K cannot continue.$\r$\n$\r$\nSoftware\Classes\vrcxk is already handled by another program:$\r$\n$R8$\r$\n$\r$\nOverwriting it cannot be undone (an existing class key cannot be restored), so the installation stops here." /SD IDOK
      Abort
    ${EndIf}
  ${EndIf}
!macroend

!macro NSIS_HOOK_POSTUNINSTALL
  ; Keep this in lockstep with plugins.deep-link.desktop.schemes in tauri.conf.json — the
  ; packaging test asserts every declared scheme appears here as a DeleteRegKey.
  DeleteRegKey HKCU "Software\Classes\vrcxk"
!macroend
