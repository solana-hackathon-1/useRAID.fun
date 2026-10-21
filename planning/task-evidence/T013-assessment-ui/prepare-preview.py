import tempfile,shutil,hashlib,json
from pathlib import Path
root=Path.cwd();e=root/'planning/task-evidence/T013-assessment-ui'
source=Path(Path('/tmp/raid-t013-assessment-ui-build-path').read_text());target=Path(tempfile.mkdtemp(prefix='raid-t013-assessment-ui-preview-'))
shutil.copytree(source,target,dirs_exist_ok=True,symlinks=True,ignore=shutil.ignore_patterns('.next','node_modules','__pycache__','*.tsbuildinfo'))
(target/'node_modules').symlink_to(root/'node_modules',target_is_directory=True)
if (root/'public').exists():shutil.copytree(root/'public',target/'public',dirs_exist_ok=True)
hashes={}
for folder in ['src','prisma','tests','examples']:
 for p in (root/folder).rglob('*'):
  if not p.is_file() or 'node_modules' in p.parts or '__pycache__' in p.parts:continue
  relative=p.relative_to(root);assert (target/relative).is_file() and p.read_bytes()==(target/relative).read_bytes(),str(relative)
  hashes[str(relative)]=hashlib.sha256(p.read_bytes()).hexdigest()
Path('/tmp/raid-t013-assessment-ui-preview-source-path').write_text(str(target))
(e/'preview-source-proof.json').write_text(json.dumps({'source':str(target),'productionSource':str(source),'separateDevelopmentCache':True,'matchingFiles':len(hashes),'sha256':hashes},indent=2)+'\n')
print('PREVIEW SOURCE',target,flush=True)
