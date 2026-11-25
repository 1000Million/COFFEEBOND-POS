"""Check public source deltas against frozen B and construct byte-verifiable patches."""
import hashlib
import json
import os
from pathlib import Path
import re
import subprocess
from tempfile import TemporaryDirectory
from zipfile import ZipFile

ROOT = Path(__file__).resolve().parents[1]
BASE = ROOT.parent / "store-till-20261124"
OUT = ROOT / "release"
PUBLIC_TABLE = ROOT.parent / "store-gst-composition-release-20261104/evidence/packages/tableService.zip"
SOURCE_ROOTS = ("staff", "backend", "continuity", "tools", "tests")
SUFFIXES = {".ts", ".tsx", ".js", ".mjs", ".cjs", ".jsx", ".css", ".html", ".json", ".rules", ".md", ".py", ".sh",
            ".m", ".h", ".plist", ".xml", ".cs", ".csproj", ".yml", ".yaml", ".ps1", ".iss", ".webmanifest",
            ".svg", ".cmd", ".config", ".entitlements", ".mm", ".swift", ".mobileconfig"}
DENY_DIRS = {"node_modules", "__pycache__", "release", "build", "release-qualification", "artifacts", "evidence",
             "cache", "dist", "obj", "bin", "coverage", "tmp", "temp", "scratch", "target", "vendor"}
PUBLIC_SPECIAL = {"continuity/.gitignore", "staff/.firebaserc"}
SOURCE_NOTE = ("Source roots are staff, backend, continuity, tools and tests. The prior Staff build input hash and "
               "production source ZIPs are independently pinned. Only changed publicly distributable source and tests "
               "enter the patches. QA results and build/clock/Hosting binaries are separate release artifacts.")

def require(ok, message):
    if not ok:
        raise ValueError(message)

def sha(data):
    return hashlib.sha256(data).hexdigest()

def disk_sha(path):
    with path.open("rb") as stream:
        return hashlib.file_digest(stream, "sha256").hexdigest()

def json_bytes(data):
    return (json.dumps(data, indent=2, sort_keys=True, ensure_ascii=False) + "\n").encode()

def stat_info(data, mode):
    return {"sha256":sha(data), "size":len(data), "mode":mode}

def check_public(data, path):
    # No embedded private-key material or credential artifacts should enter a release patch.
    header = rb"-----BEGIN " + rb"(?:RSA |EC |OPENSSH |ENCRYPTED |DSA )?PRIVATE KEY-----[\r\n]+[A-Za-z0-9+/=]{20,}"
    require(b"\x00" not in data and not re.search(header, data), "Non-source or private content: " + path)
    require(not re.search(rb'"type"\s*:\s*"service_account"\s*,\s*"project_id"', data), "Service account credential: " + path)
    data.decode("utf-8")

def source_files(root):
    found = {}
    for scope in SOURCE_ROOTS:
        for parent, dirs, files in os.walk(root / scope, followlinks=False):
            base = Path(parent)
            dirs[:] = sorted(d for d in dirs if not d.startswith(".") and d.lower() not in DENY_DIRS and not (base/d).is_symlink())
            for name in sorted(files):
                p = base / name
                rel = p.relative_to(root).as_posix()
                if p.is_symlink():
                    continue
                if (name.startswith(".") or p.suffix.lower() not in SUFFIXES and name != "Makefile") and rel not in PUBLIC_SPECIAL:
                    continue
                require(not re.search(r"(?:^|[-_.])(?:service.?account|credential|secret|private.?key)(?:[-_.]|$)", name, re.I), "Credential-like source name: " + rel)
                data = p.read_bytes()
                found[rel] = stat_info(data, "100755" if p.stat().st_mode & 0o111 else "100644")
    return found

def make_patch(changes, name):
    # The sparse trees contain only changed, already reviewed distributable files.
    # git diff emits original end-of-file and executable-mode metadata.
    with TemporaryDirectory() as tmp:
        workspace = Path(tmp)
        for dirname in ["a", "b"]:
            (workspace / dirname).mkdir()
        for rel, (before, after) in changes.items():
            for dirname, source in [("a", before), ("b", after)]:
                if source is None:
                    continue
                data, mode = source
                check_public(data, rel)
                file = workspace / dirname / rel
                file.parent.mkdir(exist_ok=True, parents=True)
                file.write_bytes(data)
                file.chmod(0o755 if mode == "100755" else 0o644)
        result = subprocess.run(["git", "-c", "core.autocrlf=false", "diff", "--no-ext-diff", "--no-index",
                                 "--no-prefix", "--binary", "--", "a", "b"], cwd=workspace, capture_output=True)
        require(result.returncode == 1, "Expected a nonempty source delta")
        patch = result.stdout
        path = workspace / name
        path.write_bytes(patch)
        for opts in (["--check"], []):
            subprocess.run(["git","-c","core.autocrlf=false","apply","--binary","--whitespace=nowarn", *opts, str(path)],
                           cwd=workspace/"a", check=True, capture_output=True)
        for rel, (_, expected) in changes.items():
            actual = workspace / "a" / rel
            if expected is None:
                require(not actual.exists(), "Patch did not remove file: " + rel)
            else:
                data, mode = expected
                require(actual.read_bytes() == data, "Reapplied patch bytes differ: " + rel)
                require(bool(actual.stat().st_mode & 0o111) == (mode == "100755"), "Reapplied file mode differs: " + rel)
        (OUT / name).write_bytes(patch)
        return {"path":name, "sha256":sha(patch), "bytes":len(patch), "changedFiles":len(changes),
                "gitApplyCheck":True, "allReappliedBytesAndModesChecked":True}

def archive_files(path, expected):
    require(disk_sha(path) == expected, "Function source pin changed: " + path.name)
    with ZipFile(path) as z:
        names = [n for n in z.namelist() if not n.endswith("/")]
        require(len(set(names)) == len(names), "Duplicate source ZIP member")
        return {n:z.read(n) for n in names}

def backend_inventory():
    root = OUT / "backend"
    sealed = json.loads((root/"manifest.json").read_bytes())["functions"]
    originals = {"offlineCash":BASE/"release/B/backend/offlineCash.zip", "tableService":PUBLIC_TABLE}
    func = {}
    public_delta = {}
    recovery_delta = {}
    for name, original in originals.items():
        item = sealed[name]
        old = archive_files(original, item["baselineSha256"])
        new = archive_files(root/item["candidate"]["file"], item["candidate"]["sha256"])
        recovery = archive_files(root/item["recovery"]["file"], item["recovery"]["sha256"])
        require(old.keys() == new.keys() == recovery.keys(), "Function member set changed")
        delta = {}
        switches = {}
        for n in sorted(old):
            if old[n] != new[n]:
                expected = item["changedFiles"].get(n)
                require(expected == {"before":sha(old[n]), "after":sha(new[n])}, "Sealed function change mismatch: " + n)
                rel = "backend/offlineCash/" + (n if name=="offlineCash" else "deployed-table/tableService.js")
                require((ROOT/rel).read_bytes()==new[n] and (BASE/rel).read_bytes()==old[n], "Workspace/archive mismatch: "+n)
                delta[n] = {**expected,"workspaceSource":rel}
                if name == "tableService":
                    public_delta[n] = ((old[n], "100644"),(new[n], "100644"))
            if new[n] != recovery[n]:
                switches[n] = {"before":sha(new[n]), "after":sha(recovery[n])}
                recovery_delta[name+"/"+n] = ((new[n], "100644"), (recovery[n], "100644"))
        require(set(delta)==set(item["changedFiles"]) and set(switches)=={item["recoveryDelta"]}, "Unexpected function change")
        func[name] = {"originalArchive":str(original.relative_to(ROOT.parent)),
           "originalArchiveSha256":item["baselineSha256"],"originalRevision":item["baselineRevision"],"originalGeneration":item["baselineGeneration"],
           "candidate":item["candidate"],"recovery":item["recovery"],"memberCount":len(old),"allMembersCompared":True,
           "originalToCandidate":delta,"candidateToRecovery":switches}
    return func, public_delta, recovery_delta

def inventory():
    before = source_files(BASE)
    after = source_files(ROOT)
    changes = {}
    index = {}
    for name in sorted(before.keys() | after.keys()):
        a, b = before.get(name), after.get(name)
        if a == b:
            continue
        changes[name] = (((BASE/name).read_bytes(), a["mode"]) if a else None, ((ROOT/name).read_bytes(), b["mode"]) if b else None)
        index[name] = {"status":("changed" if a and b else "added" if b else "deleted"),"before":a,"after":b}
    OUT.mkdir(exist_ok=True)
    func, public_delta, recovery_delta = backend_inventory()
    patches = {
        "workspaceAgainstFrozenB":make_patch(changes,"general-pwa-offline.patch"),
        "publicTableServiceAgainstDeployedSource":make_patch(public_delta,"public-tableService.patch"),
        "functionsForwardRecoveryAgainstCandidateArchives":make_patch(recovery_delta,"backend-forward-recovery.patch"),
    }
    anchor = json.loads((ROOT/"evidence/release-b-baseline.json").read_bytes())
    require(anchor["source"]["recomputedBuildSourceHash"] == anchor["source"]["expectedBuildSourceHash"] and
            anchor["archiveSha256"] == "6dea7c7b7a3cb5e71f0478ba1b23f610b1a70029310ab970d1a9a76ba20270fd",
            "Staff B evidence mismatch")
    report = {"status":"PASS","scope":SOURCE_NOTE, "baselineStaff":{"release":"B","version":anchor["liveVersion"],
             "hostingArchiveSha256":anchor["archiveSha256"], "buildInputHash":anchor["source"]["recomputedBuildSourceHash"]},
              "workspaceTrees":{"beforeFileCount":len(before),"afterFileCount":len(after),
                "beforeIndexSha256":sha(json_bytes(before)),"afterIndexSha256":sha(json_bytes(after))},
              "patches":patches,"workspaceChangedFiles":index,"functionArchives":func}
    (OUT/"source-change-inventory.json").write_bytes(json_bytes(report))
    print(json.dumps({k:v["changedFiles"] for k,v in patches.items()}))


if __name__ == "__main__":
    inventory()
