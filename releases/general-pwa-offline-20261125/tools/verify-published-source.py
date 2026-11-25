#!/usr/bin/env python3
"""Verify the published November source snapshot; optionally regenerate source ZIPs."""
import argparse, hashlib, io, json, zipfile
from pathlib import Path
ROOT=Path(__file__).resolve().parents[1]
PIN=json.loads((ROOT/"provenance.json").read_text())
sha=lambda data:hashlib.sha256(data).hexdigest()
parser=argparse.ArgumentParser()
parser.add_argument("--package",action="store_true",help="write verified source ZIPs to ignored artifacts/source-packages")
args=parser.parse_args()
for name,item in PIN["sourceFiles"].items():
    file=ROOT/name
    assert file.is_file() and not file.is_symlink(),"Missing or symlinked source: "+name
    assert sha(file.read_bytes())==item["sha256"],"Source hash differs: "+name
    assert bool(file.stat().st_mode&0o111)==bool(int(item["mode"],8)&0o111),"Source mode differs: "+name
staff=PIN["staff"]
inputs={name:sha((ROOT/staff["sourceDirectory"]/name).read_bytes()) for name in staff["buildInputOrder"]}
assert inputs==staff["buildInputSha256"],"Staff input set differs"
digest=sha(json.dumps(inputs,separators=(",",":"),ensure_ascii=False).encode())
assert digest==staff["buildInputHash"],"Staff aggregate hash differs"
packages={}
for name,item in PIN["backendMapping"]["functions"].items():
    directory=ROOT/item["sourceDirectory"]
    names=sorted(p.relative_to(directory).as_posix() for p in directory.rglob("*")
                 if p.is_file() and "node_modules" not in p.relative_to(directory).parts)
    assert names==sorted(item["memberSha256"]),"Backend file set differs: "+name
    output=io.BytesIO()
    with zipfile.ZipFile(output,"w") as archive:
        for member in names:
            data=(directory/member).read_bytes()
            assert sha(data)==item["memberSha256"][member],"Backend source differs: "+member
            entry=zipfile.ZipInfo(member,date_time=(1980,1,1,0,0,0))
            entry.external_attr=0o100644<<16
            archive.writestr(entry,data,compress_type=zipfile.ZIP_DEFLATED,compresslevel=9)
    data=output.getvalue()
    archive_hash=sha(data)
    assert archive_hash==item["sourceZipSha256"],"Archive bytes differ; inspect Python/zlib compatibility: "+name
    packages[name]={"members":len(names),"sourceZipSha256":archive_hash,"revision":item["revision"]}
    if args.package:
        target=ROOT/"artifacts/source-packages"
        target.mkdir(parents=True,exist_ok=True)
        (target/(name+".zip")).write_bytes(data)
print(json.dumps({"status":"PASS","sourceFilesVerified":len(PIN["sourceFiles"]),
                  "staffBuildInputCount":len(inputs),"staffBuildInputHash":digest,
                  "functions":packages,"productionWrites":0},indent=2))
