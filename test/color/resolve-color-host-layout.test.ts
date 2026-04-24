import { execFile } from 'node:child_process';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { describe, expect, it } from 'vitest';

const exec = promisify(execFile);
const hostPath = join(process.cwd(), 'vendor', 'resolve-color-host', 'resolve-color-host.py');
const pythonPath = process.platform === 'win32'
  ? join(process.cwd(), 'vendor', 'resolve-color-host', '.venv', 'Scripts', 'python.exe')
  : join(process.cwd(), 'vendor', 'resolve-color-host', '.venv', 'bin', 'python');

async function inspectLayout(payload: {
  nodeCount: number;
  gyroEligible: boolean;
  toolsByNode: Record<string, string[]>;
  lutByNode?: Record<string, string>;
  nodeEnabledByNode?: Record<string, boolean>;
  repairSeedState?: {
    forcedDisabledNodeIndices?: number[];
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

describe('resolve color host clip layout helpers', () => {
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

  it('resets all canonical defaults only when rebuilding from default.drx', async () => {
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
