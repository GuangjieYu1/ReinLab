import os, json, tempfile, subprocess, pathlib, shutil, uuid
scanner=str(pathlib.Path(__file__).resolve().with_name('scan-mcp-credentials.py'))
base=pathlib.Path(tempfile.mkdtemp(prefix='reinlab-review-final-')).resolve(); checks={}
try:
 root=base/'repo'; root.mkdir(); (root/'evidence').mkdir(); home=base/'home'; codex=home/'.codex'
 for name in ['sessions','shell_snapshots']:(codex/name).mkdir(parents=True)
 env={'PATH':'/usr/bin:/bin:/usr/local/bin','HOME':str(home),'CODEX_HOME':str(codex)}
 def command(args):return subprocess.run(args,env=env,stdout=subprocess.PIPE,stderr=subprocess.PIPE,text=True)
 subprocess.run(['git','init',str(root)],env=env,stdout=subprocess.DEVNULL,stderr=subprocess.DEVNULL,check=True)
 source=base/'source';source.mkdir(mode=0o700)
 values={'model':'synthetic_model_value_00001','signing':'synthetic_signing_value_00001','fixture':'synthetic_fixture_value_00001','database':'synthetic_database_value_00001','discovery':'synthetic_discovery_value_00001','hatchet':'synthetic_hatchet_value_00001','runtime':'synthetic_runtime_value_00001'}
 files={'model.env':'DEEPSEEK_API_KEY='+values['model'], 'signing.pem':values['signing'],'capability.json':json.dumps({'token':values['fixture']}),'hatchet.env':'DATABASE_PASSWORD='+values['database']+'\nDISCOVERY_PASSWORD='+values['discovery']+'\nTOKEN='+values['hatchet'],'runtime.env':'CAPABILITY_TOKEN='+values['runtime']}
 for name,data in files.items():(source/name).write_text(data);(source/name).chmod(0o600)
 (root/'plain.txt').write_text('fixture only')
 for args in [['git','-C',str(root),'add','.'],['git','-C',str(root),'-c','user.name=Fixture','-c','user.email=fixture@invalid','commit','-m','fixture']]:subprocess.run(args,env=env,stdout=subprocess.DEVNULL,stderr=subprocess.DEVNULL,check=True)
 args=['/usr/bin/python3',scanner,'--root',str(root),'--deepseek-file',str(source/'model.env'),'--signing-key-file',str(source/'signing.pem'),'--capability-fixture-file',str(source/'capability.json'),'--hatchet-setup-file',str(source/'hatchet.env'),'--runtime-capability-env-file',str(source/'runtime.env'),'--task-prefix',base.name,'--output',str(base/'report.json')]
 result=command(args);report=json.loads((base/'report.json').read_text());checks['clean_seven_selected']=result.returncode==0 and report['selectedValues']==7 and report['status']=='passed'
 (codex/'sessions'/'fixture.jsonl').write_text(values['database']+' '+values['runtime'])
 result=command(args);report=json.loads((base/'report.json').read_text());hits=report['scopes']['codex_sessions']['occurrences'];checks['optional_exact_values_detected']=report['status']=='legacy_hits' and hits['runtime_mcp_token']>0 and hits['hatchet_database_password']>0
 (source/'hatchet.env').chmod(0o644);result=command(args);checks['public_optional_rejected']=result.returncode==1 and result.stdout.strip()=='{"code": "CREDENTIAL_SCAN_FAILED"}';(source/'hatchet.env').chmod(0o600)
 os.link(source/'runtime.env',source/'alias');result=command(args);checks['hardlink_optional_rejected']=result.returncode==1;os.unlink(source/'alias')
 original=source/'runtime.env';original.rename(source/'runtime-original.env');original.symlink_to(source/'runtime-original.env');result=command(args);checks['symlink_optional_rejected']=result.returncode==1
 assert all(checks.values())
 print(json.dumps({'checks':checks,'passed':len(checks),'realCredentialReads':0}))
finally:shutil.rmtree(base)
