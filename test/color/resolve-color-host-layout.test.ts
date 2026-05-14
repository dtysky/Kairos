import { execFile } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { describe, expect, it } from 'vitest';

const exec = promisify(execFile);
const hostPath = join(process.cwd(), 'vendor', 'resolve-color-host', 'resolve-color-host.py');
const pythonPath = process.platform === 'win32'
  ? join(process.cwd(), 'vendor', 'resolve-color-host', '.venv', 'Scripts', 'python.exe')
  : join(process.cwd(), 'vendor', 'resolve-color-host', '.venv', 'bin', 'python');

function toPortableTestPath(value: unknown): string {
  return String(value ?? '').replace(/\\/g, '/');
}

async function inspectRenderExportHelper(payload: Record<string, unknown>) {
  const code = `
import importlib.util
import json
import sys
import tempfile
from pathlib import Path

host_path = sys.argv[1]
payload = json.loads(sys.argv[2])

spec = importlib.util.spec_from_file_location("resolve_color_host", host_path)
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)
if payload.get("platformOverride"):
    module.sys.platform = payload["platformOverride"]

mode = payload["mode"]

try:
    if mode == "day_specs":
        specs = module.build_day_render_specs(payload["clips"], Path(payload["outputRoot"]))
        result = [{
            "relativeDir": spec["relativeDir"],
            "targetDir": str(spec["targetDir"]),
            "clipKeys": [clip["rawRelativePath"] for clip in spec["clips"]],
        } for spec in specs]
    elif mode == "queue_settings":
        class FakeProject:
            def __init__(self):
                self.settings = None
                self.setting_calls = []
                self.jobs = []

            def SetRenderSettings(self, settings):
                self.setting_calls.append(dict(settings))
                rejected_keys = set(payload.get("rejectSettingsWithKeys", []))
                if rejected_keys.intersection(settings.keys()):
                    return False
                self.settings = dict(settings)
                return True

            def AddRenderJob(self):
                output = payload.get("queueOutputFilename")
                if output is None:
                    clips = payload["clips"]
                    output = clips[0]["normalizedOutputFilename"] if clips else ""
                    if len(clips) > 1:
                        output = f"{output} and more"
                self.jobs.append({"JobId": "job-1", "OutputFilename": output})
                return "job-1"

            def GetRenderJobList(self):
                return list(self.jobs)

            def DeleteRenderJob(self, job_id):
                self.jobs = [job for job in self.jobs if job.get("JobId") != job_id]
                return True

        project = FakeProject()
        job_id = module.queue_root_render_job(
            project,
            Path(payload["targetDir"]),
            payload["renderFormat"],
            payload["clips"],
        )
        result = {"jobId": job_id, "settings": project.settings, "settingCalls": project.setting_calls}
    elif mode == "patch_preset_bitrate":
        with tempfile.TemporaryDirectory() as tmpdir:
            preset_path = Path(tmpdir) / "preset.xml"
            encoder_map = module.encode_resolve_string_map({
                "rc": "quality",
                "quality": "4",
                "preset": "balanced",
                "icq_quality": "4",
                "bitrate": "80000",
            })
            preset_path.write_text(f"""<?xml version="1.0" encoding="UTF-8"?>
<SyRecordInfo>
 <ExtraInfoMap>
  <Element>
   <DbKey>h264_datarate</DbKey>
   <DbVal>0</DbVal>
  </Element>
  <Element>
   <DbKey>encoder_command_param_map</DbKey>
   <DbVal>{encoder_map}</DbVal>
  </Element>
 </ExtraInfoMap>
</SyRecordInfo>
""", encoding="utf-8")
            module.patch_render_preset_bitrate(preset_path, payload["bitrateKbps"], payload.get("renderFormat", {}))
            tree = module.parse_xml_file_preserving_comments(preset_path)
            root = tree.getroot()
            extra_info = root.find("ExtraInfoMap")
            result = {
              "subtype": root.findtext("RecordFormatSubType"),
              "prefix": root.findtext("RecordPrefix"),
              "suffix": root.findtext("RecordSuffix"),
              "usePrefixAndSuffixFromSrc": root.findtext("UsePrefixAndSuffixFromSrc"),
              "customClips": root.findtext("CustomClips"),
              "reelInFolder": root.findtext("ReelInFolder"),
              "clipInFolder": root.findtext("ClipInFolder"),
              "alternateInFolder": root.findtext("AlternateInFolder"),
              "useVersionNameForFolder": root.findtext("UseVersionNameForFolder"),
              "srcDirPreserveLevel": root.findtext("SrcDirPreserveLevel"),
              "srcDirLevelsMode": root.findtext("SrcDirLevelsMode"),
              "datarate": module.get_extra_info_value(extra_info, "h264_datarate"),
              "encoderMap": module.decode_resolve_string_map(
                module.get_extra_info_value(extra_info, "encoder_command_param_map"),
                ),
            }
    elif mode == "generate_preset_xml":
        with tempfile.TemporaryDirectory() as tmpdir:
            preset_path = Path(tmpdir) / "__kairos_generated_test__.xml"
            module.write_generated_render_preset_xml(
                preset_path,
                "__kairos_generated_test__",
                payload["bitrateKbps"],
                payload.get("renderFormat", {}),
            )
            tree = module.parse_xml_file_preserving_comments(preset_path)
            root = tree.getroot()
            extra_info = root.find("ExtraInfoMap")
            result = {
              "subtype": root.findtext("RecordFormatSubType"),
              "prefix": root.findtext("RecordPrefix"),
              "suffix": root.findtext("RecordSuffix"),
              "usePrefixAndSuffixFromSrc": root.findtext("UsePrefixAndSuffixFromSrc"),
              "customClips": root.findtext("CustomClips"),
              "reelInFolder": root.findtext("ReelInFolder"),
              "clipInFolder": root.findtext("ClipInFolder"),
              "alternateInFolder": root.findtext("AlternateInFolder"),
              "useVersionNameForFolder": root.findtext("UseVersionNameForFolder"),
              "srcDirPreserveLevel": root.findtext("SrcDirPreserveLevel"),
              "srcDirLevelsMode": root.findtext("SrcDirLevelsMode"),
              "datarate": module.get_extra_info_value(extra_info, "h264_datarate"),
              "encoderMap": module.decode_resolve_string_map(
                module.get_extra_info_value(extra_info, "encoder_command_param_map"),
                ),
            }
    elif mode == "collect_outputs":
        with tempfile.TemporaryDirectory() as tmpdir:
            render_dir = Path(tmpdir)
            for name in payload.get("files", []):
                path = render_dir / name
                path.parent.mkdir(parents=True, exist_ok=True)
                path.write_text("rendered", encoding="utf-8")
            result = module.collect_direct_outputs_for_clips(
                render_dir,
                payload["clips"],
                payload.get("extension", "mp4"),
                "job-1",
            )
    elif mode == "queue_empty":
        class FakeProject:
            def GetRenderJobList(self):
                return payload.get("jobs", [])

        module.ensure_render_queue_empty(FakeProject())
        result = {"ok": True}
    else:
        raise RuntimeError(f"unknown mode: {mode}")
    print(json.dumps({"ok": True, "result": result}, ensure_ascii=False))
except module.HostError as error:
    print(json.dumps({"ok": False, "code": error.code, "message": str(error), "details": error.details}, ensure_ascii=False))
`;
  const { stdout } = await exec(
    pythonPath,
    ['-c', code, hostPath, JSON.stringify(payload)],
    {
      encoding: 'utf8',
      windowsHide: true,
    },
  );
  return JSON.parse(stdout) as {
    ok: boolean;
    result?: unknown;
    code?: string;
    message?: string;
    details?: unknown;
  };
}

async function inspectLayout(payload: {
  nodeCount: number;
  gyroEligible: boolean;
  toolsByNode: Record<string, string[]>;
  lutByNode?: Record<string, string>;
  nodeEnabledByNode?: Record<string, boolean>;
  repairSeedState?: {
    forcedDisabledNodeIndices?: number[];
    repairTemplateKey?: string;
    repairTemplateStatus?: string;
    repairSeedSkippedReason?: string;
    copiedExistingGrade?: boolean;
    seededRepairDonorKind?: string;
    effectiveGyroEligible?: boolean;
    gyroDataAvailable?: boolean;
  };
  clipRequest?: Record<string, unknown>;
}) {
  const code = `
import importlib.util
import json
import sys

host_path = sys.argv[1]
payload = json.loads(sys.argv[2])

spec = importlib.util.spec_from_file_location("resolve_color_host", host_path)
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)

tools_by_node = {int(key): value for key, value in payload.get("toolsByNode", {}).items()}
lut_by_node = {int(key): value for key, value in payload.get("lutByNode", {}).items()}
node_enabled_by_node = {int(key): value for key, value in payload.get("nodeEnabledByNode", {}).items()}

result = module.inspect_clip_repair_layout(
    payload["nodeCount"],
    tools_by_node,
    lut_by_node,
    node_enabled_by_node,
    payload["gyroEligible"],
    payload.get("repairSeedState"),
)
result["clipRepairStatus"] = module.determine_clip_repair_status(
    payload["nodeCount"],
    payload["gyroEligible"],
    result["layoutStatus"],
    result["gyroflowStatus"],
    result["dehazeStatus"],
    result["nrStatus"],
    tools_by_node,
    list(lut_by_node.values()),
)
print(json.dumps(result, ensure_ascii=False))
`;
  const { stdout } = await exec(
    pythonPath,
    ['-c', code, hostPath, JSON.stringify(payload)],
    {
      encoding: 'utf8',
      windowsHide: true,
    },
  );
  return JSON.parse(stdout) as {
    gyroflowStatus: string;
    dehazeStatus: string;
    nrStatus: string;
    layoutStatus: string;
    clipRepairStatus: string;
    reservedNodeIndices: Record<string, number>;
  };
}

async function getRepairTemplateAsset(payload: {
  repairDrtPath?: string;
  repairDrxPath?: string;
}) {
  const code = `
import importlib.util
import json
import sys

host_path = sys.argv[1]
payload = json.loads(sys.argv[2])

spec = importlib.util.spec_from_file_location("resolve_color_host", host_path)
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)

result = module.get_repair_template_assets(payload)["default"]
if result.get("path") is not None:
    result["path"] = str(result["path"])
print(json.dumps(result, ensure_ascii=False))
`;
  const { stdout } = await exec(
    pythonPath,
    ['-c', code, hostPath, JSON.stringify(payload)],
    {
      encoding: 'utf8',
      windowsHide: true,
    },
  );
  return JSON.parse(stdout) as {
    kind: string;
    status: string;
    path: string | null;
    drtPath?: string;
    skippedReason?: string;
  };
}

async function buildRepairSnapshot(payload: {
  nodeCount: number;
  gyroEligible: boolean;
  toolsByNode: Record<string, string[]>;
  lutByNode?: Record<string, string>;
  nodeEnabledByNode?: Record<string, boolean>;
  repairSeedState?: {
    forcedDisabledNodeIndices?: number[];
    repairTemplateKey?: string;
    repairTemplateStatus?: string;
    repairSeedSkippedReason?: string;
    copiedExistingGrade?: boolean;
    seededRepairDonorKind?: string;
  };
}) {
  const code = `
import importlib.util
import json
import sys

host_path = sys.argv[1]
payload = json.loads(sys.argv[2])

spec = importlib.util.spec_from_file_location("resolve_color_host", host_path)
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)

class FakeGraph:
    def GetNumNodes(self):
        return payload["nodeCount"]

    def GetToolsInNode(self, node_index):
        return payload.get("toolsByNode", {}).get(str(node_index), [])

    def GetLUT(self, node_index):
        return payload.get("lutByNode", {}).get(str(node_index))

    def GetNodeEnabled(self, node_index):
        return payload.get("nodeEnabledByNode", {}).get(str(node_index))

class FakeItem:
    def __init__(self):
        self.graph = FakeGraph()

    def GetNodeGraph(self):
        return self.graph

result = module.build_clip_repair_snapshot(
    FakeItem(),
    {
        "rawRelativePath": "day1/A001.mov",
        "sourceStem": "A001",
        "gyroEligible": payload["gyroEligible"],
        **payload.get("clipRequest", {}),
    },
    payload.get("repairSeedState"),
)
print(json.dumps(result, ensure_ascii=False))
`;
  const { stdout } = await exec(
    pythonPath,
    ['-c', code, hostPath, JSON.stringify(payload)],
    {
      encoding: 'utf8',
      windowsHide: true,
    },
  );
  return JSON.parse(stdout) as {
    clipRepairStatus: string;
    layoutStatus: string;
    hostSummary: Record<string, unknown>;
  };
}

async function applyReservedDefaults(payload: {
  gyroEligible: boolean;
  resetTailReservedNodes: boolean;
}) {
  const code = `
import importlib.util
import json
import sys

host_path = sys.argv[1]
payload = json.loads(sys.argv[2])

spec = importlib.util.spec_from_file_location("resolve_color_host", host_path)
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)

class FakeGraph:
    def __init__(self):
        self.calls = []

    def SetNodeEnabled(self, node_index, enabled):
        self.calls.append([node_index, enabled])
        return True

class FakeItem:
    def __init__(self):
        self.graph = FakeGraph()

    def GetNodeGraph(self):
        return self.graph

item = FakeItem()
result = module.apply_reserved_node_defaults(
    item,
    {"gyroEligible": payload["gyroEligible"]},
    payload["resetTailReservedNodes"],
)
print(json.dumps({"result": result, "calls": item.graph.calls}, ensure_ascii=False))
`;
  const { stdout } = await exec(
    pythonPath,
    ['-c', code, hostPath, JSON.stringify(payload)],
    {
      encoding: 'utf8',
      windowsHide: true,
    },
  );
  return JSON.parse(stdout) as {
    result: { enabled: number[]; disabled: number[] };
    calls: Array<[number, boolean]>;
  };
}

async function applyTimelineTransform(payload: {
  transform: Record<string, unknown>;
}) {
  const code = `
import importlib.util
import json
import sys

host_path = sys.argv[1]
payload = json.loads(sys.argv[2])

spec = importlib.util.spec_from_file_location("resolve_color_host", host_path)
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)

class FakeItem:
    def __init__(self):
        self.calls = []

    def SetProperty(self, key, value):
        self.calls.append([key, value])
        return True

item = FakeItem()
module.apply_timeline_item_transform(item, payload["transform"], "day1/A001.mov")
print(json.dumps({"calls": item.calls}, ensure_ascii=False))
`;
  const { stdout } = await exec(
    pythonPath,
    ['-c', code, hostPath, JSON.stringify(payload)],
    {
      encoding: 'utf8',
      windowsHide: true,
    },
  );
  return JSON.parse(stdout) as {
    calls: Array<[string, unknown]>;
  };
}

async function shouldForceRepairTemplateReseed(payload: {
  repairTemplateKey?: string;
  previousRepairTemplateHash?: string;
  currentRepairTemplateHash?: string;
  hasTemplateSource?: boolean;
}) {
  const code = `
import importlib.util
import json
import sys

host_path = sys.argv[1]
payload = json.loads(sys.argv[2])

spec = importlib.util.spec_from_file_location("resolve_color_host", host_path)
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)

result = module.should_force_repair_template_reseed(
    {
        "repairTemplateKey": payload.get("repairTemplateKey"),
        "previousRepairTemplateHash": payload.get("previousRepairTemplateHash"),
    },
    {"hash": payload.get("currentRepairTemplateHash")},
    object() if payload.get("hasTemplateSource", True) else None,
)
print(json.dumps({"result": result}, ensure_ascii=False))
`;
  const { stdout } = await exec(
    pythonPath,
    ['-c', code, hostPath, JSON.stringify(payload)],
    {
      encoding: 'utf8',
      windowsHide: true,
    },
  );
  return JSON.parse(stdout) as { result: boolean };
}

async function seedForcedPortraitTemplateReseed() {
  const code = `
import importlib.util
import json
import sys

host_path = sys.argv[1]

spec = importlib.util.spec_from_file_location("resolve_color_host", host_path)
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)

calls = []

class FakeGraph:
    def ResetAllGrades(self):
        calls.append("target.ResetAllGrades")
        return True

    def GetNumNodes(self):
        return 5

    def GetToolsInNode(self, node_index):
        return {
            1: ["OFX: Gyroflow"],
            2: ["OFX: Dehaze"],
            5: ["OFX: Noise Reduction"],
        }.get(node_index, [])

    def GetLUT(self, node_index):
        return None

    def SetNodeEnabled(self, node_index, enabled):
        calls.append(f"target.SetNodeEnabled:{node_index}:{enabled}")
        return True

class FakeTargetItem:
    def __init__(self):
        self.graph = FakeGraph()

    def GetNodeGraph(self):
        return self.graph

class FakeTemplateItem:
    def CopyGrades(self, targets):
        calls.append("template.CopyGrades")
        return True

target_item = FakeTargetItem()
old_donor_item = object()
template_item = FakeTemplateItem()

def fake_build_timeline_item_map(timeline, raw_local_path):
    if timeline == "target-timeline":
        return {"day1/A001.mov": target_item}
    if timeline == "old-donor-timeline":
        return {"day1/A001.mov": old_donor_item}
    return {}

module.build_timeline_item_map = fake_build_timeline_item_map
module.find_first_timeline_video_item = lambda timeline: template_item if timeline == "template-timeline" else None
module.clip_like_has_grade_content = lambda item: item is old_donor_item
module.clip_like_has_canonical_repair_layout = lambda item: True

result = module.seed_clip_repairs(
    "target-timeline",
    "/raw",
    [{
        "rawRelativePath": "day1/A001.mov",
        "sourceStem": "A001",
        "gyroEligible": True,
        "repairTemplateKey": "portrait--90",
        "previousRepairTemplateHash": "hash-v1",
        "orientationStatus": "portrait",
    }],
    donor_timeline="old-donor-timeline",
    repair_templates={
        "portrait--90": {
            "kind": "orientation-drt",
            "status": "portrait--90-drt",
            "hash": "hash-v2",
            "path": "/tmp/portrait.drt",
        },
    },
    repair_template_timelines={"portrait--90": "template-timeline"},
)
print(json.dumps({"calls": calls, "state": result["day1/A001.mov"]}, ensure_ascii=False))
`;
  const { stdout } = await exec(
    pythonPath,
    ['-c', code, hostPath],
    {
      encoding: 'utf8',
      windowsHide: true,
    },
  );
  return JSON.parse(stdout) as {
    calls: string[];
    state: Record<string, unknown>;
  };
}

async function buildCreativeSummary(payload: Record<string, unknown>) {
  const code = `
import importlib.util
import json
import sys

host_path = sys.argv[1]
payload = json.loads(sys.argv[2])

spec = importlib.util.spec_from_file_location("resolve_color_host", host_path)
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)

print(json.dumps(module.build_clip_creative_summary(payload), ensure_ascii=False))
`;
  const { stdout } = await exec(
    pythonPath,
    ['-c', code, hostPath, JSON.stringify(payload)],
    {
      encoding: 'utf8',
      windowsHide: true,
    },
  );
  return JSON.parse(stdout) as {
    creativeTags: string[];
    displayName: string;
  };
}

async function summarizeGroupColorCast(clips: Array<Record<string, unknown>>) {
  const code = `
import importlib.util
import json
import sys

host_path = sys.argv[1]
clips = json.loads(sys.argv[2])

spec = importlib.util.spec_from_file_location("resolve_color_host", host_path)
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)

print(json.dumps({"colorCastClass": module.summarize_group_color_cast(clips)}, ensure_ascii=False))
`;
  const { stdout } = await exec(
    pythonPath,
    ['-c', code, hostPath, JSON.stringify(clips)],
    {
      encoding: 'utf8',
      windowsHide: true,
    },
  );
  return JSON.parse(stdout) as {
    colorCastClass: string;
  };
}

describe('resolve color host clip layout helpers', () => {
  it('builds day-level render specs with final target directories', async () => {
    const result = await inspectRenderExportHelper({
      mode: 'day_specs',
      outputRoot: '/Volumes/SSDMAX/zve1',
      clips: [
        { rawRelativePath: 'day7/C1610.MP4', sourceStem: 'C1610', normalizedOutputFilename: 'C1610.mp4' },
        { rawRelativePath: 'day7/C1611.MP4', sourceStem: 'C1611', normalizedOutputFilename: 'C1611.mp4' },
        { rawRelativePath: 'day9/C1610.MP4', sourceStem: 'C1610', normalizedOutputFilename: 'C1610.mp4' },
      ],
    });

    expect({
      ...result,
      result: (result.result as Array<Record<string, unknown>>).map(spec => ({
        ...spec,
        targetDir: toPortableTestPath(spec.targetDir),
      })),
    }).toMatchObject({
      ok: true,
      result: [
        {
          relativeDir: 'day7',
          targetDir: '/Volumes/SSDMAX/zve1/day7',
          clipKeys: ['day7/C1610.MP4', 'day7/C1611.MP4'],
        },
        {
          relativeDir: 'day9',
          targetDir: '/Volumes/SSDMAX/zve1/day9',
          clipKeys: ['day9/C1610.MP4'],
        },
      ],
    });
  });

  it('blocks day-level render specs when a day contains duplicate stems', async () => {
    const result = await inspectRenderExportHelper({
      mode: 'day_specs',
      outputRoot: '/Volumes/SSDMAX/zve1',
      clips: [
        { rawRelativePath: 'day7/C1610.MP4', sourceStem: 'C1610', normalizedOutputFilename: 'C1610.mp4' },
        { rawRelativePath: 'day7/C1610-copy.MP4', sourceStem: 'C1610', normalizedOutputFilename: 'C1610.mp4' },
      ],
    });

    expect(result.ok).toBe(false);
    expect(result.code).toBe('resolve_day_render_duplicate_source_stem');
  });

  it('queues Source Name render settings without custom names or filename prefixes', async () => {
    const result = await inspectRenderExportHelper({
      mode: 'queue_settings',
      targetDir: '/Volumes/SSDMAX/zve1/day7',
      renderFormat: {
        format: 'MP4',
        videoCodec: 'H265',
        extension: 'mp4',
        audioCodec: 'aac',
        bitrateKbps: 120000,
      },
      clips: [
        {
          rawRelativePath: 'day7/C1610.MP4',
          sourceStem: 'C1610',
          normalizedOutputFilename: 'C1610.mp4',
          width: 3840,
          height: 2160,
          fps: 30,
        },
      ],
    });

    expect(result.ok).toBe(true);
    const settings = (result.result as { settings: Record<string, unknown> }).settings;
    expect(toPortableTestPath(settings.TargetDir)).toBe('/Volumes/SSDMAX/zve1/day7');
    expect(settings.FrameRate).toBe('30');
    expect(settings.RateControl).toBeUndefined();
    expect(settings.VideoQuality).toBeUndefined();
    expect(settings.CustomName).toBeUndefined();
    expect(settings.UniqueFilenameStyle).toBeUndefined();
  });

  it('uses public VideoQuality bitrate outside the Windows H.265 workaround', async () => {
    const result = await inspectRenderExportHelper({
      mode: 'queue_settings',
      platformOverride: 'darwin',
      targetDir: '/Volumes/SSDMAX/zve1/day7',
      renderFormat: {
        format: 'MP4',
        videoCodec: 'H265',
        extension: 'mp4',
        audioCodec: 'aac',
        bitrateKbps: 30000,
      },
      clips: [
        {
          rawRelativePath: 'day7/C1610.MP4',
          sourceStem: 'C1610',
          normalizedOutputFilename: 'C1610.mp4',
          width: 3840,
          height: 2160,
          fps: 30,
        },
      ],
    });

    expect(result.ok).toBe(true);
    const settings = (result.result as { settings: Record<string, unknown> }).settings;
    expect(settings.VideoQuality).toBe(30000);
    expect(settings.CustomName).toBeUndefined();
    expect(settings.UniqueFilenameStyle).toBeUndefined();
  });

  it('rejects queued render jobs when Resolve is not using Source Name filenames', async () => {
    const result = await inspectRenderExportHelper({
      mode: 'queue_settings',
      targetDir: '/Volumes/SSDMAX/zve1/day7',
      queueOutputFilename: '00000000.mp4 and more',
      renderFormat: {
        format: 'MP4',
        videoCodec: 'H265',
        extension: 'mp4',
        audioCodec: 'aac',
        bitrateKbps: 30000,
      },
      clips: [
        {
          rawRelativePath: 'day7/C1610.MP4',
          sourceStem: 'C1610',
          normalizedOutputFilename: 'C1610.mp4',
          width: 3840,
          height: 2160,
          fps: 30,
        },
      ],
    });

    expect(result.ok).toBe(false);
    expect(result.code).toBe('resolve_render_job_filename_mode_failed');
    expect(result.details).toMatchObject({
      outputFilename: '00000000.mp4 and more',
    });
  });

  it('generates clean Resolve render preset XML from Kairos config', async () => {
    const result = await inspectRenderExportHelper({
      mode: 'generate_preset_xml',
      bitrateKbps: 30000,
      renderFormat: {
        format: 'MP4',
        videoCodec: 'H265',
      },
    });

    expect(result.ok).toBe(true);
    expect(result.result).toMatchObject({
      subtype: 'hvc1_qsv',
      prefix: '',
      suffix: '',
      usePrefixAndSuffixFromSrc: '1',
      customClips: '',
      reelInFolder: '0',
      clipInFolder: '0',
      alternateInFolder: '0',
      useVersionNameForFolder: '0',
      srcDirPreserveLevel: '0',
      srcDirLevelsMode: '0',
      datarate: '30000',
      encoderMap: {
        rc: 'CBR',
        quality: 'best',
        preset: 'balance',
        icq_quality: '2',
        bitrate: '30000',
      },
    });
  });

  it('accepts exact Source Name outputs and rejects Resolve prefix/suffix outputs', async () => {
    const exact = await inspectRenderExportHelper({
      mode: 'collect_outputs',
      files: ['C1611.mp4'],
      clips: [
        { rawRelativePath: 'day7/C1611.MP4', sourceStem: 'C1611', normalizedOutputFilename: 'C1611.mp4' },
      ],
    });
    expect(exact).toMatchObject({
      ok: true,
      result: [{
        rawRelativePath: 'day7/C1611.MP4',
        normalizedOutputFilename: 'C1611.mp4',
        renderJobId: 'job-1',
      }],
    });

    const prefixed = await inspectRenderExportHelper({
      mode: 'collect_outputs',
      files: ['C1611.mp4', 'V1-0001_C1611.mp4'],
      clips: [
        { rawRelativePath: 'day7/C1611.MP4', sourceStem: 'C1611', normalizedOutputFilename: 'C1611.mp4' },
      ],
    });
    expect(prefixed.ok).toBe(false);
    expect(prefixed.code).toBe('resolve_render_output_bad_source_name');

    const suffixed = await inspectRenderExportHelper({
      mode: 'collect_outputs',
      files: ['C1611_001.mp4'],
      clips: [
        { rawRelativePath: 'day7/C1611.MP4', sourceStem: 'C1611', normalizedOutputFilename: 'C1611.mp4' },
      ],
    });
    expect(suffixed.ok).toBe(false);
    expect(suffixed.code).toBe('resolve_render_output_bad_source_name');
  });

  it('promotes Resolve Event_Version nested outputs back to direct root paths', async () => {
    const nested = await inspectRenderExportHelper({
      mode: 'collect_outputs',
      files: ['Event_Version 1_0001_0001/C1611.mp4'],
      clips: [
        { rawRelativePath: 'day7/C1611.MP4', sourceStem: 'C1611', normalizedOutputFilename: 'C1611.mp4' },
      ],
    });

    expect(nested.ok).toBe(true);
    const [entry] = nested.result as Array<{ outputPath: string }>;
    expect(toPortableTestPath(entry.outputPath)).toMatch(/\/C1611\.mp4$/u);
    expect(toPortableTestPath(entry.outputPath)).not.toContain('Event_Version');
  });

  it('blocks when Resolve Render Queue is not empty', async () => {
    const result = await inspectRenderExportHelper({
      mode: 'queue_empty',
      jobs: [{ JobId: 'job-old', Status: 'Queued' }],
    });

    expect(result.ok).toBe(false);
    expect(result.code).toBe('resolve_render_queue_not_empty');
  });

  it('skips missing DRT instead of falling back to default.drx', async () => {
    const result = await getRepairTemplateAsset({
      repairDrtPath: join(tmpdir(), 'kairos-missing-default-drt-for-test.drt'),
      repairDrxPath: join(process.cwd(), 'config', 'default.drx'),
    });

    expect(result).toMatchObject({
      kind: 'missing-drt',
      status: 'skipped-missing-drt',
      path: null,
    });
    expect(result.skippedReason).toContain('default.drt');
  });

  it('marks skipped repair seed clips as pending-template', async () => {
    const result = await buildRepairSnapshot({
      nodeCount: 0,
      gyroEligible: true,
      toolsByNode: {},
      repairSeedState: {
        repairTemplateStatus: 'skipped-missing-drt',
        repairSeedSkippedReason: 'Missing config/default.drt; skipped automatic clip repair seed.',
      },
    });

    expect(result).toMatchObject({
      clipRepairStatus: 'pending-template',
      layoutStatus: 'legacy-layout',
      hostSummary: {
        repairTemplateStatus: 'skipped-missing-drt',
        repairSeedSkippedReason: 'Missing config/default.drt; skipped automatic clip repair seed.',
      },
    });
  });

  it('marks missing portrait DRT clips as pending-orientation-template and disables effective gyro', async () => {
    const result = await buildRepairSnapshot({
      nodeCount: 0,
      gyroEligible: true,
      toolsByNode: {},
      clipRequest: {
        gyroDataAvailable: true,
        encodedWidth: 3840,
        encodedHeight: 2160,
        displayWidth: 2160,
        displayHeight: 3840,
        rotationDegrees: 90,
        orientationStatus: 'portrait',
        repairTemplateKey: 'portrait--90',
        timelineTransform: {
          rotationAngle: -90,
          zoomGang: true,
          zoomX: 1.7778,
          zoomY: 1.7778,
          pan: 0,
          tilt: 0,
        },
      },
      repairSeedState: {
        repairTemplateKey: 'portrait--90',
        repairTemplateStatus: 'skipped-missing-orientation-drt',
        repairSeedSkippedReason: 'Missing gyroflow-portrait--90.drt; skipped automatic portrait Gyro seed.',
        effectiveGyroEligible: false,
        gyroDataAvailable: true,
      },
    });

    expect(result).toMatchObject({
      clipRepairStatus: 'pending-orientation-template',
      gyroDataAvailable: true,
      gyroEligible: false,
      orientationStatus: 'portrait',
      repairTemplateKey: 'portrait--90',
      timelineTransform: {
        rotationAngle: -90,
        zoomX: 1.7778,
      },
      hostSummary: {
        repairTemplateKey: 'portrait--90',
        repairTemplateStatus: 'skipped-missing-orientation-drt',
      },
    });
  });

  it('forces portrait template reseed when the recorded DRT hash is missing or stale', async () => {
    await expect(shouldForceRepairTemplateReseed({
      repairTemplateKey: 'portrait-90',
      currentRepairTemplateHash: 'hash-v2',
      hasTemplateSource: true,
    })).resolves.toEqual({ result: true });
    await expect(shouldForceRepairTemplateReseed({
      repairTemplateKey: 'portrait-90',
      previousRepairTemplateHash: 'hash-v1',
      currentRepairTemplateHash: 'hash-v2',
      hasTemplateSource: true,
    })).resolves.toEqual({ result: true });
    await expect(shouldForceRepairTemplateReseed({
      repairTemplateKey: 'portrait-90',
      previousRepairTemplateHash: 'hash-v2',
      currentRepairTemplateHash: 'hash-v2',
      hasTemplateSource: true,
    })).resolves.toEqual({ result: false });
    await expect(shouldForceRepairTemplateReseed({
      repairTemplateKey: 'default',
      currentRepairTemplateHash: 'hash-v2',
      hasTemplateSource: true,
    })).resolves.toEqual({ result: false });
  });

  it('resets stale portrait clip grades before reapplying the orientation DRT', async () => {
    const result = await seedForcedPortraitTemplateReseed();

    expect(result.calls.slice(0, 2)).toEqual([
      'target.ResetAllGrades',
      'template.CopyGrades',
    ]);
    expect(result.state).toMatchObject({
      seededRepairDonorKind: 'orientation-drt',
      resetExistingGradeBeforeTemplate: true,
      forcedRepairTemplateReseed: true,
      repairTemplateKey: 'portrait--90',
      previousRepairTemplateHash: 'hash-v1',
      repairTemplateHash: 'hash-v2',
    });
  });

  it('applies portrait timeline transform through Resolve TimelineItem properties', async () => {
    const result = await applyTimelineTransform({
      transform: {
        rotationAngle: -90,
        zoomGang: true,
        zoomX: 1.7778,
        zoomY: 1.7778,
        pan: 0,
        tilt: 0,
      },
    });

    expect(result.calls).toEqual([
      ['RotationAngle', -90],
      ['ZoomGang', true],
      ['ZoomX', 1.7778],
      ['ZoomY', 1.7778],
      ['Pan', 0],
      ['Tilt', 0],
    ]);
  });

  it('only adds color-cast classes to generated groups at high confidence', async () => {
    await expect(buildCreativeSummary({
      logProfile: 'slog3',
      lowlight: false,
      colorCastClass: 'cool-cyan',
      colorCastConfidence: 0.8,
    })).resolves.toEqual({
      creativeTags: ['slog3', 'cool-cyan'],
      displayName: 'slog3 + cool-cyan',
    });

    await expect(buildCreativeSummary({
      logProfile: 'slog3',
      lowlight: false,
      colorCastClass: 'green-cyan',
      colorCastConfidence: 0.8,
    })).resolves.toEqual({
      creativeTags: ['slog3', 'green-cyan'],
      displayName: 'slog3 + green-cyan',
    });

    await expect(buildCreativeSummary({
      logProfile: 'slog3',
      lowlight: false,
      colorCastClass: 'green-cyan',
      colorCastConfidence: 0.4,
    })).resolves.toEqual({
      creativeTags: ['slog3'],
      displayName: 'slog3',
    });

    await expect(buildCreativeSummary({
      logProfile: 'slog3',
      lowlight: false,
      colorCastClass: 'cool-cyan',
      colorCastConfidence: 0.4,
    })).resolves.toEqual({
      creativeTags: ['slog3'],
      displayName: 'slog3',
    });

    await expect(summarizeGroupColorCast([{
      colorCastClass: 'cool-cyan',
      colorCastConfidence: 0.4,
    }])).resolves.toEqual({
      colorCastClass: 'unknown',
    });

    await expect(summarizeGroupColorCast([{
      colorCastClass: 'cool-cyan',
      colorCastConfidence: 0.8,
    }])).resolves.toEqual({
      colorCastClass: 'cool-cyan',
    });

    await expect(summarizeGroupColorCast([{
      colorCastClass: 'green-cyan',
      colorCastConfidence: 0.8,
    }])).resolves.toEqual({
      colorCastClass: 'green-cyan',
    });
  });

  it('treats eligible five-node skeleton as canonical with Gyro enabled and Dehaze/NR disabled', async () => {
    const result = await inspectLayout({
      nodeCount: 5,
      gyroEligible: true,
      toolsByNode: {
        '1': ['OFX: Gyroflow'],
        '2': ['OFX: Dehaze'],
        '5': ['OFX: Noise Reduction'],
      },
      repairSeedState: {
        forcedDisabledNodeIndices: [2, 5],
      },
    });

    expect(result).toMatchObject({
      gyroflowStatus: 'ready-to-load',
      dehazeStatus: 'seeded-disabled',
      nrStatus: 'seeded-disabled',
      layoutStatus: 'canonical',
      clipRepairStatus: 'ready',
      reservedNodeIndices: {
        gyro: 1,
        dehaze: 2,
        userStart: 3,
        userEnd: 4,
        nr: 5,
      },
    });
  });

  it('treats non-eligible five-node skeleton as canonical with Gyro reserved disabled', async () => {
    const result = await inspectLayout({
      nodeCount: 5,
      gyroEligible: false,
      toolsByNode: {
        '1': ['OFX: Gyroflow'],
        '2': ['OFX: Dehaze'],
        '5': ['OFX: Noise Reduction'],
      },
      repairSeedState: {
        forcedDisabledNodeIndices: [1, 2, 5],
      },
    });

    expect(result).toMatchObject({
      gyroflowStatus: 'seeded-disabled',
      dehazeStatus: 'seeded-disabled',
      nrStatus: 'seeded-disabled',
      layoutStatus: 'canonical',
      clipRepairStatus: 'ready',
      reservedNodeIndices: {
        gyro: 1,
        dehaze: 2,
        userStart: 3,
        userEnd: 4,
        nr: 5,
      },
    });
  });

  it('keeps an expanded user zone canonical when Dehaze stays at node 2 and NR stays last', async () => {
    const result = await inspectLayout({
      nodeCount: 6,
      gyroEligible: true,
      toolsByNode: {
        '1': ['OFX: Gyroflow'],
        '2': ['OFX: Dehaze'],
        '6': ['OFX: Noise Reduction'],
      },
      repairSeedState: {
        forcedDisabledNodeIndices: [2, 6],
      },
    });

    expect(result).toMatchObject({
      gyroflowStatus: 'ready-to-load',
      dehazeStatus: 'seeded-disabled',
      nrStatus: 'seeded-disabled',
      layoutStatus: 'canonical',
      clipRepairStatus: 'ready',
      reservedNodeIndices: {
        gyro: 1,
        dehaze: 2,
        userStart: 3,
        userEnd: 5,
        nr: 6,
      },
    });
  });

  it('marks incomplete eligible gyro-only skeleton as legacy-layout', async () => {
    const result = await inspectLayout({
      nodeCount: 1,
      gyroEligible: true,
      toolsByNode: {
        '1': ['OFX: Gyroflow'],
      },
    });

    expect(result).toMatchObject({
      gyroflowStatus: 'ready-to-load',
      dehazeStatus: 'not-seeded',
      nrStatus: 'not-seeded',
      layoutStatus: 'legacy-layout',
      clipRepairStatus: 'partial',
      reservedNodeIndices: {
        gyro: 1,
      },
    });
  });

  it('marks a former nr-only skeleton as legacy-layout', async () => {
    const result = await inspectLayout({
      nodeCount: 2,
      gyroEligible: false,
      toolsByNode: {
        '2': ['OFX: Noise Reduction'],
      },
      repairSeedState: {
        forcedDisabledNodeIndices: [1, 2],
      },
    });

    expect(result).toMatchObject({
      gyroflowStatus: 'not-seeded',
      dehazeStatus: 'not-seeded',
      nrStatus: 'seeded-disabled',
      layoutStatus: 'legacy-layout',
      clipRepairStatus: 'partial',
      reservedNodeIndices: {
        nr: 2,
      },
    });
  });

  it('marks nodes appended after NR as legacy-layout', async () => {
    const result = await inspectLayout({
      nodeCount: 6,
      gyroEligible: true,
      toolsByNode: {
        '1': ['OFX: Gyroflow'],
        '2': ['OFX: Dehaze'],
        '5': ['OFX: Noise Reduction'],
      },
      repairSeedState: {
        forcedDisabledNodeIndices: [2, 5],
      },
    });

    expect(result).toMatchObject({
      gyroflowStatus: 'ready-to-load',
      dehazeStatus: 'seeded-disabled',
      nrStatus: 'seeded-disabled',
      layoutStatus: 'legacy-layout',
      clipRepairStatus: 'partial',
      reservedNodeIndices: {
        gyro: 1,
        dehaze: 2,
        userStart: 3,
        userEnd: 4,
        nr: 5,
      },
    });
  });

  it('reasserts only Gyro on canonical reruns so user tail-node toggles are preserved', async () => {
    const eligible = await applyReservedDefaults({
      gyroEligible: true,
      resetTailReservedNodes: false,
    });
    expect(eligible).toEqual({
      result: { enabled: [1], disabled: [] },
      calls: [[1, true]],
    });

    const nonEligible = await applyReservedDefaults({
      gyroEligible: false,
      resetTailReservedNodes: false,
    });
    expect(nonEligible).toEqual({
      result: { enabled: [], disabled: [1] },
      calls: [[1, false]],
    });
  });

  it('resets all canonical defaults only when rebuilding from a DRT template', async () => {
    const result = await applyReservedDefaults({
      gyroEligible: true,
      resetTailReservedNodes: true,
    });

    expect(result).toEqual({
      result: { enabled: [1, 3, 4], disabled: [2, 5] },
      calls: [[1, true], [2, false], [5, false], [3, true], [4, true]],
    });
  });
});
