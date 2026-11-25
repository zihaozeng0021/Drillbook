#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
Build the Drillbook Android app (phone version): a WebView shell with all of web/ packed into the APK, running offline.

Usage: python android/build.py
Output: android/build/drillbook.apk. Run Drillbook on the computer and turn on "Allow phone connections" under
        "Connect phone"; the address for downloading the package to the phone is shown there.

Requires:
  · JDK 11 or later (javac, keytool; the ones in JAVA_HOME are preferred)
  · platforms;android-35 and build-tools (35 or later) from the Android SDK. The SDK location comes from the
    ANDROID_HOME / ANDROID_SDK_ROOT environment variables, else the default location (Windows: %LOCALAPPDATA%\\Android\\Sdk)
  · Python standard library only, no Gradle

Signing: the first build creates a signing key and a password file in .local/ (not in git). The same key is used from then on,
so the phone can install over the old app and keep the app's data. If the key is lost, the app has to be uninstalled and
reinstalled, and any phone data not yet merged back into the computer is lost with it.
"""
from __future__ import annotations

import os
import re
import secrets
import shutil
import subprocess
import sys
import time
import zipfile
from pathlib import Path

HERE = Path(__file__).resolve().parent
ROOT = HERE.parent
WEB = ROOT / "web"
OUT = HERE / "build"
LOCAL = ROOT / ".local"
KEYSTORE = LOCAL / "android-signing.jks"
KEYPASS = LOCAL / "android-signing.pass"
ALIAS = "drillbook"
MIN_SDK = 24      # Android 7.0
TARGET_SDK = 35   # Android 15

try:  # Windows console: replace characters it can't encode (e.g. in tool output or paths) instead of crashing
    sys.stdout.reconfigure(errors="replace")
    sys.stderr.reconfigure(errors="replace")
except Exception:
    pass


def fail(msg: str):
    sys.exit(f"Build failed: {msg}")


def run(*cmd) -> str:
    r = subprocess.run([str(c) for c in cmd], capture_output=True, encoding="utf-8", errors="replace")
    if r.returncode != 0:
        sys.stderr.write(r.stdout + r.stderr)
        fail(f"{Path(str(cmd[0])).name} failed (exit code {r.returncode})")
    return r.stdout


def sdk_root() -> Path:
    for key in ("ANDROID_HOME", "ANDROID_SDK_ROOT"):
        v = os.environ.get(key)
        if v and Path(v).is_dir():
            return Path(v)
    if os.name == "nt":
        cand = Path(os.environ.get("LOCALAPPDATA", "")) / "Android" / "Sdk"
    elif sys.platform == "darwin":
        cand = Path.home() / "Library" / "Android" / "sdk"
    else:
        cand = Path.home() / "Android" / "Sdk"
    if cand.is_dir():
        return cand
    fail("Android SDK not found: set the ANDROID_HOME environment variable, or install the SDK in the default location")


def build_tools(sdk: Path) -> Path:
    def key(d: Path):
        return tuple(int(x) for x in re.findall(r"\d+", d.name))

    bt = sdk / "build-tools"
    found = [d for d in bt.iterdir() if d.is_dir() and re.fullmatch(r"\d+(\.\d+)*", d.name)] if bt.is_dir() else []
    found = [d for d in found if key(d) >= (35,)]
    if not found:
        fail('The SDK has no build-tools 35 or later: run sdkmanager "build-tools;35.0.1"')
    return max(found, key=key)


def tool(folder: Path, name: str) -> str:
    for ext in ("", ".exe", ".bat"):
        p = folder / (name + ext)
        if p.is_file():
            return str(p)
    fail(f"{name} not found in {folder}")


def java_tool(name: str) -> str:
    home = os.environ.get("JAVA_HOME")
    if home:
        for ext in ("", ".exe"):
            p = Path(home) / "bin" / (name + ext)
            if p.is_file():
                return str(p)
    found = shutil.which(name)
    if not found:
        fail(f"{name} not found: install JDK 11 or later and set JAVA_HOME")
    return found


def ensure_keystore(keytool: str) -> None:
    if KEYSTORE.is_file() and KEYPASS.is_file():
        return
    if KEYSTORE.exists() or KEYPASS.exists():
        fail(f"Only one of {KEYSTORE.name} and {KEYPASS.name} is left in .local/: recover the other one, "
             "or delete both to generate new ones (the phone then has to uninstall the old app before installing)")
    LOCAL.mkdir(parents=True, exist_ok=True)
    KEYPASS.write_bytes(secrets.token_urlsafe(24).encode("ascii") + b"\n")
    run(keytool, "-genkeypair", "-keystore", KEYSTORE, "-storetype", "PKCS12", "-alias", ALIAS,
        "-keyalg", "RSA", "-keysize", "3072", "-validity", "10000", "-dname", "CN=Drillbook",
        "-storepass:file", KEYPASS, "-keypass:file", KEYPASS)
    print(f"Created the signing key {KEYSTORE.relative_to(ROOT).as_posix()} (not in git; keep a backup)")


def main() -> None:
    sdk = sdk_root()
    bt = build_tools(sdk)
    jar = sdk / "platforms" / f"android-{TARGET_SDK}" / "android.jar"
    if not jar.is_file():
        fail(f'The SDK has no platforms;android-{TARGET_SDK}: run sdkmanager "platforms;android-{TARGET_SDK}"')
    aapt2, d8, zipalign, apksigner = (tool(bt, n) for n in ("aapt2", "d8", "zipalign", "apksigner"))
    javac, keytool = java_tool("javac"), java_tool("keytool")

    if OUT.exists():
        shutil.rmtree(OUT)
    (OUT / "classes").mkdir(parents=True)
    (OUT / "dex").mkdir()

    # 1. The site code goes into assets/web/ (files and folders starting with _ or . are left out, e.g. temporary test pages)
    shutil.copytree(WEB, OUT / "assets" / "web", ignore=lambda d, names: [n for n in names if n.startswith(("_", "."))])

    # 2. Resources and manifest
    run(aapt2, "compile", "--dir", HERE / "res", "-o", OUT / "res.zip")
    version_code = int(time.time() // 60)  # grows with every build, so the phone can install over the old app
    version_name = time.strftime("%Y.%m.%d-%H%M")
    unsigned = OUT / "unsigned.apk"
    run(aapt2, "link", "-o", unsigned, "-I", jar, "--manifest", HERE / "AndroidManifest.xml",
        "-A", OUT / "assets", "--min-sdk-version", MIN_SDK, "--target-sdk-version", TARGET_SDK,
        "--version-code", version_code, "--version-name", version_name, OUT / "res.zip")

    # 3. Java source → class → dex
    sources = sorted(str(p) for p in (HERE / "src").rglob("*.java"))
    run(javac, "--release", "8", "-Xlint:-options", "-encoding", "UTF-8", "-classpath", jar, "-d", OUT / "classes", *sources)
    classes = sorted(str(p) for p in (OUT / "classes").rglob("*.class"))
    run(d8, "--release", "--min-api", MIN_SDK, "--lib", jar, "--output", OUT / "dex", *classes)

    # 4. Add classes.dex, align, sign
    with zipfile.ZipFile(unsigned, "a", compression=zipfile.ZIP_DEFLATED) as z:
        z.write(OUT / "dex" / "classes.dex", "classes.dex")
    aligned = OUT / "aligned.apk"
    run(zipalign, "-p", "-f", "4", unsigned, aligned)
    ensure_keystore(keytool)
    apk = OUT / "drillbook.apk"
    # In a PKCS12 keystore the key password equals the store password, so --ks-pass is enough
    run(apksigner, "sign", "--ks", KEYSTORE, "--ks-key-alias", ALIAS, "--ks-pass", f"file:{KEYPASS}",
        "--v4-signing-enabled", "false", "--out", apk, aligned)
    run(apksigner, "verify", apk)

    for p in ("unsigned.apk", "aligned.apk", "res.zip", "classes", "dex", "assets"):
        target = OUT / p
        shutil.rmtree(target) if target.is_dir() else target.unlink()
    print(f"Built: {apk.relative_to(ROOT).as_posix()} ({apk.stat().st_size / 1048576:.1f} MB, version {version_name})")
    print("To install: run Drillbook on the computer, click \"Connect phone\" at the top right of the topic list, turn on "
          "\"Allow phone connections\", then open the package address shown there in the phone's browser.")


if __name__ == "__main__":
    main()
