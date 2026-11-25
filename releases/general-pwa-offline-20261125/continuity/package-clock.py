"""Seal the optional managed Mac clock. Supply the original restricted extension signing key."""
import base64
import hashlib
import io
import json
import os
from pathlib import Path
import shutil
import struct
import subprocess
import sys
import tempfile
import zipfile

root = Path(__file__).resolve().parent
public = root / "extension"
dst = root.parent / "release/clock"
dst.mkdir(parents=True, exist_ok=True)
key = Path(sys.argv[1]).resolve()
assert key.is_file() and not key.stat().st_mode & 0o077
digest = lambda data: hashlib.sha256(data).hexdigest()
manifest = json.loads((public / "manifest.json").read_bytes())
pub = subprocess.check_output(["/usr/bin/openssl","rsa","-in",str(key),"-pubout","-outform","DER"],stderr=subprocess.DEVNULL)
assert base64.b64encode(pub).decode() == manifest["key"]
extension_id = ''.join(chr(97+int(n,16)) for n in digest(pub)[:32])
assert extension_id in (root.parent / 'staff/frontend/lib/offline/desktopClock.ts').read_text()
assert extension_id in (root / 'macos/install.sh').read_text()
with tempfile.TemporaryDirectory(prefix="cb-clock-pkg-") as work:
    tmp = Path(work)
    shutil.copytree(public, tmp / "extension")
    pk8 = tmp / "key.pem"
    with os.fdopen(os.open(pk8, os.O_CREAT | os.O_EXCL | os.O_WRONLY, 0o600),'wb') as target:
        subprocess.run(["/usr/bin/openssl","pkcs8","-topk8","-nocrypt","-in",str(key)],stdout=target,check=True)
    chrome = "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"
    existing=dst/"coffee-bond-session-clock.crx"
    crx=existing.read_bytes() if existing.is_file() else b""
    matching=False
    if crx.startswith(b"Cr24") and len(crx)>12:
        with zipfile.ZipFile(io.BytesIO(crx[12+struct.unpack('<I',crx[8:12])[0]:])) as previous:
            matching=set(previous.namelist())=={p.name for p in public.iterdir() if p.is_file()} and all(
                previous.read(f)==(public/f).read_bytes() for f in previous.namelist())
    if not matching:
        subprocess.run([chrome,"--user-data-dir="+str(tmp/"profile"),"--no-first-run","--disable-background-networking",
                        "--no-default-browser-check","--pack-extension="+str(tmp/"extension"),"--pack-extension-key="+str(pk8)],check=True,timeout=30)
        crx=(tmp/"extension.crx").read_bytes()
    assert crx[:8] == b"Cr24\x03\0\0\0"
    header=crx[12:12+struct.unpack('<I',crx[8:12])[0]]
    zip_bytes=crx[12+len(header):]
    # CRX3 has a single RSA proof in this self-hosted package. Verify signed header and archive bytes.
    def fields(data):
        def varint(offset):
            value=0; shift=0
            while offset<len(data):
                byte=data[offset];offset+=1;value|=(byte&127)<<shift
                if byte<128:return value,offset
                shift+=7
            raise ValueError("bad field size")
        vals={}; i=0
        while i<len(data):
            key_tag,i=varint(i); assert key_tag&7==2
            size,i=varint(i); assert size<=len(data)-i
            vals.setdefault(key_tag>>3,[]).append(data[i:i+size]);i+=size
        return vals
    h=fields(header); signed=h[10000][0];proof=fields(h[2][0])
    assert proof[1]==[pub] and fields(signed)[1]==[hashlib.sha256(pub).digest()[:16]]
    (tmp/'signature.bin').write_bytes(proof[2][0])
    (tmp/'verify.pem').write_bytes(subprocess.check_output(['/usr/bin/openssl','rsa','-in',str(key),'-pubout'],stderr=subprocess.DEVNULL))
    subprocess.run(['/usr/bin/openssl','dgst','-sha256','-verify',str(tmp/'verify.pem'),'-signature',str(tmp/'signature.bin')],
                   input=b'CRX3 SignedData\0'+struct.pack('<I',len(signed))+signed+zip_bytes,check=True)
    with zipfile.ZipFile(io.BytesIO(zip_bytes)) as z:
        assert set(z.namelist())=={p.name for p in public.iterdir() if p.is_file()}
        for f in z.namelist(): assert z.read(f)==(public/f).read_bytes()
    (dst/"coffee-bond-session-clock.crx").write_bytes(crx)
    exe=tmp/"session-clock"
    subprocess.run(["clang","-fobjc-arc","-arch","arm64","-arch","x86_64","-mmacosx-version-min=12.0","-Wall","-Werror",
                    "-Wno-incompatible-pointer-types","-framework","AppKit","-framework","Foundation","-framework","Security",
                    "-framework","CoreGraphics",str(root/"macos/clock.m"),"-o",str(exe)],check=True)
    subprocess.run(["/usr/bin/codesign","--force","--sign","-",str(exe)],check=True,stderr=subprocess.DEVNULL)
    subprocess.run(["/usr/bin/codesign","--verify","--strict",str(exe)],check=True)
    archives=subprocess.check_output(["lipo","-archs",str(exe)],text=True).split()
    bins={"session-clock":exe.read_bytes(),"install.sh":(root/"macos/install.sh").read_bytes()}
    assert b'COFFEE_BOND_CLOCK_DIR' not in bins['session-clock']
    files={**bins,"SHA256SUMS":''.join(f'{digest(v)}  {k}\n' for k,v in bins.items()).encode()}
    zip_path=dst/"macos-session-clock.zip"
    with zipfile.ZipFile(zip_path,"w") as z:
        for k,v in files.items():
            zi=zipfile.ZipInfo(k,(2026,11,25,0,0,0));zi.external_attr=(0o100755 if k!='SHA256SUMS' else 0o100644)<<16
            z.writestr(zi,v,compress_type=zipfile.ZIP_DEFLATED)
    with zipfile.ZipFile(zip_path) as z:
        assert z.testzip() is None and all(z.read(k)==v for k,v in files.items())
    (dst/'manifest.json').write_text(json.dumps({'extensionId':extension_id,'extensionSha256':digest(crx),'nativeZipSha256':digest(zip_path.read_bytes()),
        'binarySha256':digest(bins['session-clock']),'binaryArchitectures':archives,'nativeSourceSha256':digest((root/'macos/clock.m').read_bytes()),
        'signing':'CRX3 RSA verified; native universal executable ad-hoc signed','nativeFinancialData':False,'productionInstalled':False},indent=2)+'\n')
    for p in dst.iterdir():
        if p.is_file():p.chmod(0o644)
    print('Verified CRX3 and native ZIP',extension_id,archives)
