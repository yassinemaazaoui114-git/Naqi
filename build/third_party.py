"""Writes THIRD-PARTY-NOTICES.txt into the app folder (ROADMAP T12.2, SPEC 2c): the hand-written part
(THIRD-PARTY-NOTICES.txt at the project root: models, ffmpeg, Deno, Electron, yt-dlp) followed by every Python
package PyInstaller packed into the engine, with its version and licence as its own metadata states it.
Run by make-installer.mjs: py -3.12 build/third_party.py <engine folder> <out file>
"""
import importlib.metadata as md
import os
import sys

ROOT = os.path.join(os.path.dirname(os.path.abspath(__file__)), "..")
# pure-Python packages the engine imports: frozen inside the engine's archive, so no folder of theirs shows
ALWAYS = ["einops", "beartype", "rotary-embedding-torch", "PyYAML", "packaging"]


def licence(dist):
    m = dist.metadata
    text = m.get("License-Expression") or ""
    if not text:
        classes = [c.split("::")[-1].strip() for c in m.get_all("Classifier") or [] if c.startswith("License ::")]
        text = "; ".join(c for c in classes if c != "OSI Approved")
    if not text:
        lic = (m.get("License") or "").strip()
        text = lic.splitlines()[0][:80] if lic else ""
    return text or "see the package"


def packed(engine):
    """Distributions whose files are inside the packed engine."""
    inside = os.path.join(engine, "_internal")
    names = set(os.listdir(inside)) if os.path.isdir(inside) else set()
    owners = md.packages_distributions()
    found = set(ALWAYS)
    for n in names:
        if n.endswith(".dist-info"):
            found.add(n[:-len(".dist-info")].rsplit("-", 1)[0])
        top = n.split(".")[0]
        found.update(owners.get(top, []))
    out = {}
    for name in found:
        try:
            d = md.distribution(name)
        except md.PackageNotFoundError:
            continue
        out[d.metadata["Name"].lower()] = d
    return [out[k] for k in sorted(out)]


def main(engine, dst):
    with open(os.path.join(ROOT, "THIRD-PARTY-NOTICES.txt"), encoding="utf-8") as f:
        head = f.read().rstrip() + "\n"
    rows = [f"  {d.metadata['Name']} {d.version}: {licence(d)}" for d in packed(engine)]
    text = (head + "\n\nPYTHON PACKAGES INSIDE THE ENGINE (generated when the installer was built; each package's "
            "own licence file is in resources\\engine\\_internal\\<package>.dist-info where it ships one)\n\n"
            + "\n".join(rows) + "\n")
    with open(dst, "w", encoding="utf-8", newline="\r\n") as f:
        f.write(text)
    print(f"{dst}: {len(rows)} Python packages")


if __name__ == "__main__":
    main(sys.argv[1], sys.argv[2])
