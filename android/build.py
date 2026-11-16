#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
打包 Drillbook 安卓 App（手机版）：一个 WebView 外壳，把 web/ 整个打进 APK，离线运行。

用法：python android/build.py
输出：android/build/drillbook.apk。电脑上运行 Drillbook，在「连接手机」里打开「允许手机连接」后，
      那里会显示手机下载安装包的地址。

需要：
  · JDK 11 或更高（javac、keytool；优先用 JAVA_HOME 里的）
  · Android SDK 里的 platforms;android-35 和 build-tools（35 或更高）。SDK 位置取环境变量
    ANDROID_HOME / ANDROID_SDK_ROOT，没有就用默认位置（Windows：%LOCALAPPDATA%\\Android\\Sdk）
  · 只用 Python 标准库，不需要 Gradle

签名：第一次打包时在 .local/ 生成签名密钥和密码文件（不进 git）。之后一直用同一个密钥，
手机上才能覆盖安装、保留 App 里的数据。密钥丢了只能卸载重装，手机上还没合并回电脑的数据会跟着丢。
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

try:  # Windows 控制台输出中文时避免编码报错
    sys.stdout.reconfigure(errors="replace")
    sys.stderr.reconfigure(errors="replace")
except Exception:
    pass


def fail(msg: str):
    sys.exit(f"打包失败：{msg}")


def run(*cmd) -> str:
    r = subprocess.run([str(c) for c in cmd], capture_output=True, encoding="utf-8", errors="replace")
    if r.returncode != 0:
        sys.stderr.write(r.stdout + r.stderr)
        fail(f"{Path(str(cmd[0])).name} 出错（退出码 {r.returncode}）")
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
    fail("找不到 Android SDK：设置环境变量 ANDROID_HOME，或把 SDK 装在默认位置")


def build_tools(sdk: Path) -> Path:
    def key(d: Path):
        return tuple(int(x) for x in re.findall(r"\d+", d.name))

    bt = sdk / "build-tools"
    found = [d for d in bt.iterdir() if d.is_dir() and re.fullmatch(r"\d+(\.\d+)*", d.name)] if bt.is_dir() else []
    found = [d for d in found if key(d) >= (35,)]
    if not found:
        fail('SDK 里没有 35 或更高版本的 build-tools：运行 sdkmanager "build-tools;35.0.1"')
    return max(found, key=key)


def tool(folder: Path, name: str) -> str:
    for ext in ("", ".exe", ".bat"):
        p = folder / (name + ext)
        if p.is_file():
            return str(p)
    fail(f"{folder} 里没有 {name}")


def java_tool(name: str) -> str:
    home = os.environ.get("JAVA_HOME")
    if home:
        for ext in ("", ".exe"):
            p = Path(home) / "bin" / (name + ext)
            if p.is_file():
                return str(p)
    found = shutil.which(name)
    if not found:
        fail(f"找不到 {name}：安装 JDK 11 或更高版本，并设置 JAVA_HOME")
    return found


def ensure_keystore(keytool: str) -> None:
    if KEYSTORE.is_file() and KEYPASS.is_file():
        return
    if KEYSTORE.exists() or KEYPASS.exists():
        fail(f".local/ 里的 {KEYSTORE.name} 和 {KEYPASS.name} 只剩一个：找回另一个；"
             "或者两个都删掉重新生成，但手机上就得先卸载旧 App 才能安装")
    LOCAL.mkdir(parents=True, exist_ok=True)
    KEYPASS.write_bytes(secrets.token_urlsafe(24).encode("ascii") + b"\n")
    run(keytool, "-genkeypair", "-keystore", KEYSTORE, "-storetype", "PKCS12", "-alias", ALIAS,
        "-keyalg", "RSA", "-keysize", "3072", "-validity", "10000", "-dname", "CN=Drillbook",
        "-storepass:file", KEYPASS, "-keypass:file", KEYPASS)
    print(f"已生成签名密钥 {KEYSTORE.relative_to(ROOT).as_posix()}（不进 git，建议备份）")


def main() -> None:
    sdk = sdk_root()
    bt = build_tools(sdk)
    jar = sdk / "platforms" / f"android-{TARGET_SDK}" / "android.jar"
    if not jar.is_file():
        fail(f'SDK 里没有 platforms;android-{TARGET_SDK}：运行 sdkmanager "platforms;android-{TARGET_SDK}"')
    aapt2, d8, zipalign, apksigner = (tool(bt, n) for n in ("aapt2", "d8", "zipalign", "apksigner"))
    javac, keytool = java_tool("javac"), java_tool("keytool")

    if OUT.exists():
        shutil.rmtree(OUT)
    (OUT / "classes").mkdir(parents=True)
    (OUT / "dex").mkdir()

    # 1. 网站代码放进 assets/web/（以 _ 或 . 开头的文件和文件夹不打包，比如临时测试页）
    shutil.copytree(WEB, OUT / "assets" / "web", ignore=lambda d, names: [n for n in names if n.startswith(("_", "."))])

    # 2. 资源和清单
    run(aapt2, "compile", "--dir", HERE / "res", "-o", OUT / "res.zip")
    version_code = int(time.time() // 60)  # 每次打包都变大，手机上才能覆盖安装
    version_name = time.strftime("%Y.%m.%d-%H%M")
    unsigned = OUT / "unsigned.apk"
    run(aapt2, "link", "-o", unsigned, "-I", jar, "--manifest", HERE / "AndroidManifest.xml",
        "-A", OUT / "assets", "--min-sdk-version", MIN_SDK, "--target-sdk-version", TARGET_SDK,
        "--version-code", version_code, "--version-name", version_name, OUT / "res.zip")

    # 3. Java 源码 → class → dex
    sources = sorted(str(p) for p in (HERE / "src").rglob("*.java"))
    run(javac, "--release", "8", "-Xlint:-options", "-encoding", "UTF-8", "-classpath", jar, "-d", OUT / "classes", *sources)
    classes = sorted(str(p) for p in (OUT / "classes").rglob("*.class"))
    run(d8, "--release", "--min-api", MIN_SDK, "--lib", jar, "--output", OUT / "dex", *classes)

    # 4. 放进 classes.dex，对齐，签名
    with zipfile.ZipFile(unsigned, "a", compression=zipfile.ZIP_DEFLATED) as z:
        z.write(OUT / "dex" / "classes.dex", "classes.dex")
    aligned = OUT / "aligned.apk"
    run(zipalign, "-p", "-f", "4", unsigned, aligned)
    ensure_keystore(keytool)
    apk = OUT / "drillbook.apk"
    # PKCS12 密钥库里密钥的密码与库密码相同，只给 --ks-pass 即可
    run(apksigner, "sign", "--ks", KEYSTORE, "--ks-key-alias", ALIAS, "--ks-pass", f"file:{KEYPASS}",
        "--v4-signing-enabled", "false", "--out", apk, aligned)
    run(apksigner, "verify", apk)

    for p in ("unsigned.apk", "aligned.apk", "res.zip", "classes", "dex", "assets"):
        target = OUT / p
        shutil.rmtree(target) if target.is_dir() else target.unlink()
    print(f"已打包：{apk.relative_to(ROOT).as_posix()}（{apk.stat().st_size / 1048576:.1f} MB，版本 {version_name}）")
    print("安装：电脑上运行 Drillbook，点专题列表右上角的「连接手机」，打开「允许手机连接」，用手机浏览器打开那里显示的安装包地址。")


if __name__ == "__main__":
    main()
