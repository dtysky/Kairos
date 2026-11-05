import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { join } from 'node:path';
import { expect, it } from 'vitest';
const exec = promisify(execFile);
it('initializes only empty projects, rejects settings/input drift, and never injects a Clip LUT under RCM', async () => {
  const script = `
import importlib.util, json, sys
s=importlib.util.spec_from_file_location('h',sys.argv[1]);h=importlib.util.module_from_spec(s);s.loader.exec_module(h)
class Project:
 def __init__(self,count=0):self.settings={};self.count=count
 def GetSetting(self,k):return self.settings.get(k,'')
 def SetSetting(self,k,v):self.settings[k]=v;return True
 def GetTimelineCount(self):return self.count
class PoolItem:
 def __init__(self,accept=True):self.space='Project';self.accept=accept
 def GetClipProperty(self,k):return self.space if k=='Input Color Space' else ''
 def SetClipProperty(self,k,v):
  if self.accept:self.space=v
  return self.accept
def blocked(fn):
 try:fn();return None
 except h.HostError as e:return e.code
p=Project();h.ensure_project_rcm(p,True);h.verify_timeline_rcm(p)
old=blocked(lambda:h.ensure_project_rcm(Project(1),True))
p.settings['colorSpaceOutput']='Rec.709 (Scene)';drift=blocked(lambda:h.ensure_project_rcm(p));timeline=blocked(lambda:h.verify_timeline_rcm(p))
req={'rawRelativePath':'C001.MP4','colorManagementPolicy':'rcm-dwg-v1','inputColorSpace':'S-Gamut3.Cine/S-Log3'}
pool=PoolItem();rejected=blocked(lambda:h.apply_rcm_input(PoolItem(False),req,True));h.apply_rcm_input(pool,req,True);h.apply_rcm_input(pool,req)
class Item:
 def GetMediaPoolItem(self):return pool
 def GetNodeGraph(self):return None
h.clip_like_has_canonical_repair_layout=lambda i:True
status=h.apply_scene_clip_transform(Item(),req,False)
pool.space='Rec.709 (Scene)';input_drift=blocked(lambda:h.apply_rcm_input(pool,req))
print(json.dumps({'old':old,'drift':drift,'timeline':timeline,'rejected':rejected,'status':status,'inputDrift':input_drift,'dlog':h.normalize_log_profile('dlog'),'dlogm':h.normalize_log_profile('dlog-m')}))
`;
  const { stdout } = await exec('python3', ['-c', script, join(process.cwd(), 'vendor/resolve-color-host/resolve-color-host.py')]);
  expect(JSON.parse(stdout)).toEqual({ old: 'resolve_rcm_migration_required', drift: 'resolve_rcm_migration_required', timeline: 'resolve_rcm_timeline_mismatch', rejected: 'resolve_rcm_input_rejected', status: 'rcm-input-managed', inputDrift: 'resolve_rcm_input_mismatch', dlog: 'dlog', dlogm: 'dlog-m' });
});
