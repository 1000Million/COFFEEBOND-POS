"""Generate and verify the candidate and journal-compatible Staff recovery bundles."""
import hashlib
import io
import json
import re
import runpy
import shutil
import subprocess
import sys
import struct
import zlib
import argparse
from collections import ChainMap
from collections.abc import Mapping
from contextlib import ExitStack
from pathlib import Path
from tempfile import TemporaryDirectory
from zipfile import ZIP_DEFLATED, ZipFile, ZipInfo

ROOT = Path(__file__).resolve().parents[1]
B = ROOT.parent / "store-till-20261124"
FROZEN = B / "release/B/staff"
OUT = ROOT / "release/staff"
B_VERSION = "sites/coffee-bond-pos/versions/89ca55f5b3db8e46"
B_PINS = {
    "staff-publication": ("6dea7c7b7a3cb5e71f0478ba1b23f610b1a70029310ab970d1a9a76ba20270fd", "807ee71144dc138c4b6e2205dcff703000e6a4c6f69e6c09ac2136c625d009e5"),
    "staff-recovery": ("1f076a563e4c26cbd7f1ce24be7e4f6abf6645c0cce8218b4680ee7cd0569936", "642db84832f1c7e099633e0df02b8da4ea48e7124dd684dc9e88074a2efbaf3f"),
}
# Reuse the predecessor's production-binding and worker shell/manifest closure checks.
guards = runpy.run_path(str(B / "release-qualification/evidence/package-staff.py"))
check_closure = guards["check_closure"]
verify_production_bindings = guards["verify_production_bindings"]
config_hashes = guards["CONFIG_HASHES"]
shells = {"index.html", "sw.js"}


def require(ok, message):
    if not ok:
        raise ValueError(message)


def hash_stream(stream):
    with stream:
        return hashlib.file_digest(stream, "sha256").hexdigest()


def sha(data):
    return hashlib.sha256(data).hexdigest()


def formatted(data):
    return (json.dumps(data, indent=2, sort_keys=True, ensure_ascii=False) + "\n").encode()


class ArchivedFiles(Mapping):
    """Read an owned asset on demand without expanding historic Hosting releases."""
    def __init__(self, archive, hashes):
        self.archive = archive
        self.hashes = hashes

    def __len__(self):
        return len(self.hashes)

    def __iter__(self):
        return iter(self.hashes)

    def __getitem__(self, name):
        if name not in self.hashes:
            raise KeyError(name)
        return self.archive.read("staff-public/" + name)


def verify_zip(archive, hashes, manifest):
    names = {"staff-public/" + name for name in hashes} | set(config_hashes) | {"PUBLICATION_MANIFEST.json"}
    require(len(archive.infolist()) == len(names) and set(archive.namelist()) == names, "Unrecognized/duplicate ZIP member")
    require(archive.read("PUBLICATION_MANIFEST.json") == manifest, "Manifest differs from packed copy")
    for name, expected in config_hashes.items():
        require(sha(archive.read(name)) == expected, "Staff-only Hosting target/config hash mismatch")
    for name, expected in hashes.items():
        require(hash_stream(archive.open("staff-public/" + name)) == expected, f"Member bytes differ: {name}")


def source_worker(data):
    data = re.sub(rb"const CACHE_VERSION = '[^']+';", b"const CACHE_VERSION = '<version>';", data)
    return re.sub(rb"const APP_SHELL\s*=\s*\[.*?\]\s*;", b"const APP_SHELL = [<paths>];", data, count=1, flags=re.S)


def write_member(archive, name, source, padding=0):
    info = ZipInfo(name, date_time=(1980, 1, 1, 0, 0, 0))
    info.create_system = 3
    info.external_attr = 0o100644 << 16
    info.compress_type = ZIP_DEFLATED
    info._compresslevel = 9
    if padding:
        require(6 <= padding <= 65535, "Invalid ZIP alignment field")
        # ZIP alignment extra field. Minimum alignment is one byte.
        info.extra = struct.pack("<HHH", 0xa11e, padding-4, 1) + bytes(padding-6)
    with source, archive.open(info, "w") as destination:
        shutil.copyfileobj(source, destination, length=512 * 1024)


def clone(source, destination):
    if sys.platform == "darwin" and source.stat().st_dev == destination.parent.stat().st_dev:
        result = subprocess.run(["/bin/cp", "-c", str(source), str(destination)], capture_output=True)
        if not result.returncode:
            return
    shutil.copyfile(source, destination)


def local_spans(archive):
    entries = sorted(archive.infolist(), key=lambda i:i.header_offset)
    ends = [i.header_offset for i in entries[1:]] + [archive.start_dir]
    spans = {}
    for entry, end in zip(entries, ends):
        archive.fp.seek(entry.header_offset)
        header = archive.fp.read(30)
        require(header[:4] == b"PK\x03\x04" and not entry.flag_bits & 8, "Unexpected independent ZIP record")
        name_len, extra_len = struct.unpack_from("<HH", header, 26)
        require(entry.header_offset+30+name_len+extra_len+entry.compress_size == end, "ZIP contains an obsolete record or gap")
        spans[entry.filename] = (entry.header_offset, end)
    return spans


def common_archives(temp, baseline, union):
    # Clone B and retain the original compressed extents. Replace its three
    # superseded records with immutable files, padding their local headers to fit.
    first = temp / "staff-publication.zip"
    second = temp / "staff-recovery.zip"
    clone(FROZEN / "staff-publication.zip", first)
    removed = {"PUBLICATION_MANIFEST.json", *("staff-public/"+n for n in shells)}
    remaining = set(union)
    sizes = {}
    for rel, data in union.items():
        compress = zlib.compressobj(9, zlib.DEFLATED, -15)
        compressed = compress.compress(data) + compress.flush()
        sizes[rel] = 30 + len(("staff-public/" + rel).encode()) + len(compressed)
    with ZipFile(first, "a", compression=ZIP_DEFLATED, compresslevel=9) as archive:
        spans = local_spans(archive)
        old_directory = archive.start_dir
        archive.filelist = [info for info in archive.filelist if info.filename not in removed]
        for name in removed:
            del archive.NameToInfo[name]
        slots = sorted((spans[name] for name in removed), key=lambda slot:slot[1]-slot[0])
        for start, end in slots:
            length = end - start
            records = max(1, (length + 59999) // 60000)
            chosen = sorted(remaining, key=lambda n:(sizes[n], n))[:records]
            room = length - sum(sizes[n] for n in chosen)
            require(len(chosen)==records and room >= 6*records, "No safe immutable placement for B records")
            archive.start_dir = start
            for index, rel in enumerate(chosen):
                padding = room // (records-index)
                write_member(archive, "staff-public/"+rel, io.BytesIO(union[rel]), padding)
                room -= padding
                remaining.remove(rel)
            require(archive.start_dir == end, "Immutable record offset changed")
        archive.start_dir = old_directory
        for rel in sorted(remaining):
            write_member(archive, "staff-public/"+rel, io.BytesIO(union[rel]))
        archive.filelist.sort(key=lambda i:i.header_offset)
    clone(first, second)


def append_shell(path, manifest, hashes, current):
    with ZipFile(path, "a", compression=ZIP_DEFLATED, compresslevel=9) as archive:
        for rel in sorted(shells):
            write_member(archive, "staff-public/" + rel, io.BytesIO(current[rel]))
        write_member(archive, "PUBLICATION_MANIFEST.json", io.BytesIO(manifest))
    with ZipFile(path) as archive:
        local_spans(archive)
        verify_zip(archive, hashes, manifest)


def package(builds_path, output_path):
    global OUT
    OUT = output_path
    OUT.mkdir(parents=True, exist_ok=True)
    with ExitStack() as stack:
        histories = {}
        for name, (zip_pin, manifest_pin) in B_PINS.items():
            path = FROZEN / (name + ".zip")
            manifest = (FROZEN / (name + "-manifest.json")).read_bytes()
            require(hash_stream(path.open("rb")) == zip_pin and sha(manifest) == manifest_pin, f"Release B pin changed: {name}")
            archive = stack.enter_context(ZipFile(path))
            hashes = json.loads(manifest)
            verify_zip(archive, hashes, manifest)
            require(len(hashes) == 3114, "Release B file count")
            histories[name] = ArchivedFiles(archive, hashes)
        baseline, old_recovery = histories.values()
        require(set(baseline) == set(old_recovery), "B path inventory differs")
        require({n for n in baseline if baseline.hashes[n] != old_recovery.hashes[n]} == shells, "B immutable delta")
        builds = {}
        built_reports = {}
        for target, mode, directory in [("staff-publication", "candidate", "production-build"), ("staff-recovery", "recovery", "recovery-build")]:
            current = guards["local_files"](builds_path / directory)
            metadata = json.loads((ROOT / f"evidence/{mode}-build.json").read_bytes())
            require(metadata["status"] == "PASS" and sha(current[metadata["entry"]]) == metadata["entrySha256"], "Build bytes differ from qualified entry")
            marker = b'VITE_TILL_RECOVERY_ONLY:"' + (b"true" if mode == "recovery" else b"false") + b'"'
            require(marker in current[metadata["entry"]], f"Missing {mode} build guard")
            verify_production_bindings(current[metadata["entry"]])
            builds[target] = current
            built_reports[mode] = metadata
        require(built_reports["candidate"]["sourceHash"] == built_reports["recovery"]["sourceHash"], "Source changed between mode builds")
        template = (ROOT / "staff/public/sw.js").read_bytes().replace(b"/* OFFLINE_BUILD_ASSETS */", b"")
        require(all(source_worker(current["sw.js"]) == source_worker(template) for current in builds.values()), "Worker behavior differs from reviewed journal guard")
        union = {}
        for current in builds.values():
            require({n for n in set(current) & set(baseline) if sha(current[n]) != baseline.hashes[n]} == shells, "Unexpected replacement of B static content")
            for name, data in current.items():
                if name in shells:
                    continue
                if name in baseline:
                    require(sha(data) == baseline.hashes[name], f"Historical asset collision: {name}")
                elif name in union:
                    require(union[name] == data, f"New immutable asset collision: {name}")
                else:
                    require(re.fullmatch(r"assets/[^/]+-[A-Za-z0-9_-]{8}\.[A-Za-z0-9]+", name), "New asset lacks immutable name")
                    union[name] = data
        report = {"status":"PASS", "baseVersion":B_VERSION, "basePins":B_PINS, "historicalPaths":len(baseline),
                  "historicalStaticFilesRetained":len(baseline)-len(shells),"newImmutableAssets":len(union),"replacedPaths":sorted(shells),
                  "buildSourceHash":built_reports["candidate"]["sourceHash"],"configSha256":config_hashes,"packages":{},
                  "productionWrites":0,"deployment":"local archive generation only"}
        manifests = {}
        # Complete both bundles in a staging directory before exposing either result.
        with TemporaryDirectory(dir=OUT) as temporary:
            temp = Path(temporary)
            common_archives(temp, baseline, union)
            for target, current in builds.items():
                updated = {**union, **{n:current[n] for n in shells}}
                hashes = {**baseline.hashes, **{n:sha(v) for n,v in updated.items()}}
                publication = ChainMap(updated, baseline)
                closures = {n:check_closure(source, publication) for n,source in histories.items()}
                closures.update({n+"-new":check_closure(source, publication, source) for n,source in builds.items()})
                require(len({v["cacheVersion"] for v in closures.values()}) == len(closures), "Worker identities overlap")
                manifest = formatted(hashes)
                archive_path = temp / (target + ".zip")
                append_shell(archive_path, manifest, hashes, current)
                manifest_name = target + "-manifest.json"
                (temp / manifest_name).write_bytes(manifest)
                manifests[target] = hashes
                report["packages"][target] = {"archive":archive_path.name,"archiveSha256":hash_stream(archive_path.open("rb")),
                       "manifest":manifest_name,"manifestSha256":sha(manifest),"hostingFilesVerified":len(hashes),
                       "archiveEntriesVerified":len(hashes)+3,"shellClosure":closures,"buildFiles":len(current)}
            first, second = manifests.values()
            require(first.keys() == second.keys() and {n for n in first if first[n]!=second[n]} == shells, "Recovery loses a candidate asset")
            (temp / "manifest.json").write_bytes(formatted(report))
            for file in temp.iterdir():
                file.replace(OUT / file.name)
        print(json.dumps({name:package["archiveSha256"] for name,package in report["packages"].items()}))


if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    parser.add_argument("--builds", type=Path, default=ROOT/"release-qualification")
    parser.add_argument("--out", type=Path, default=OUT)
    options = parser.parse_args()
    package(options.builds, options.out)
