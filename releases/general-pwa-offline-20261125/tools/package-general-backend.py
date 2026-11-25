"""Seal the source-only, two-function release and pending-journal-compatible recovery."""
from hashlib import sha256
from pathlib import Path
from zipfile import ZipFile,ZipInfo,ZIP_DEFLATED
import json
root=Path(__file__).resolve().parents[1];workspace=root.parent
out=root/'release/backend';out.mkdir(parents=True,exist_ok=True)
source=root/'backend/offlineCash';baseline=workspace/'store-till-20261124'
sha=lambda b:sha256(b).hexdigest()
originals={'offlineCash':(baseline/'release/B/backend/offlineCash.zip','73ed0b556554bb2b433444b47488107c0f74ca4cc32f3ae759ebcfc254f6939b','offlinecash-00002-vix','1795583800952346'),
    'tableService':(workspace/'store-gst-composition-release-20261104/evidence/packages/tableService.zip','7e124173389c9d69be9263dbd47d79f07fff231274db208a8bcf0e18f805ae04','tableservice-00004-yiz','1793762422931947')}
changes={'offlineCash':{'offlineCash.js','offlinePilotPolicy.js','tillOperations.cjs','tillSnapshot.cjs','deployed-table/tableService.js'},'tableService':{'tableService.js'}}
report={'project':'coffee-bond-pos','region':'us-central1','runtime':'nodejs22','sourceOnly':True,'productionChanges':0,'functions':{}}
def seal(file,files):
    with ZipFile(out/file,'w') as z:
        for name,b in sorted(files.items()):
            info=ZipInfo(name,date_time=(1980,1,1,0,0,0));info.external_attr=0o100644<<16;z.writestr(info,b,compress_type=ZIP_DEFLATED,compresslevel=9)
    return {'file':file,'sha256':sha((out/file).read_bytes()),'members':len(files)}
for target,(path,hash_expected,revision,generation) in originals.items():
    assert sha(path.read_bytes())==hash_expected
    with ZipFile(path) as z:old={n:z.read(n) for n in z.namelist() if not n.endswith('/')}
    if target=='offlineCash':
        new={f:(source/f).read_bytes() for f in old}
    else:new={**old,'tableService.js':(source/'deployed-table/tableService.js').read_bytes()}
    changed={f for f in old if old[f]!=new[f]};assert changed==changes[target],changed
    recovery=dict(new)
    if target=='offlineCash':
        key='tillReleaseMode.cjs';a=b'allowNewTableSnapshots: true';b=b'allowNewTableSnapshots: false'
    else:
        key='index.js';a=b'createTableService({db:admin.firestore(),admin})';b=b'createTableService({db:admin.firestore(),admin,pauseNewScopedOrders:true})'
    assert recovery[key].count(a)==1;recovery[key]=recovery[key].replace(a,b)
    report['functions'][target]={'baselineRevision':revision,'baselineGeneration':generation,'baselineSha256':hash_expected,'changedFiles':{f:{'before':sha(old[f]),'after':sha(new[f])} for f in sorted(changed)},'recoveryDelta':key,'candidate':seal(target+'.zip',new),'recovery':seal(target+'-recovery.zip',recovery)}
(out/'manifest.json').write_text(json.dumps(report,indent=2)+'\n');print(json.dumps({k:{f:v[f]['sha256'] for f in ('candidate','recovery')} for k,v in report['functions'].items()}))
