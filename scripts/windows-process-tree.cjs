const { spawnSync } = require('node:child_process');

const PROCESS_SNAPSHOT_SOURCE = String.raw`
using System;
using System.Collections.Generic;
using System.Runtime.InteropServices;

public static class TestgenProcessTree {
    private const uint SnapshotProcesses = 0x00000002;
    private static readonly IntPtr InvalidHandle = new IntPtr(-1);

    [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
    private struct ProcessEntry {
        public uint Size;
        public uint Usage;
        public uint ProcessId;
        public IntPtr DefaultHeapId;
        public uint ModuleId;
        public uint ThreadCount;
        public uint ParentProcessId;
        public int BasePriority;
        public uint Flags;
        [MarshalAs(UnmanagedType.ByValTStr, SizeConst = 260)]
        public string ExecutableFile;
    }

    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern IntPtr CreateToolhelp32Snapshot(uint flags, uint processId);

    [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
    private static extern bool Process32FirstW(IntPtr snapshot, ref ProcessEntry entry);

    [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
    private static extern bool Process32NextW(IntPtr snapshot, ref ProcessEntry entry);

    [DllImport("kernel32.dll")]
    private static extern bool CloseHandle(IntPtr handle);

    public static string Snapshot(int rootProcessId, string knownProcessIds) {
        IntPtr snapshot = CreateToolhelp32Snapshot(SnapshotProcesses, 0);
        if (snapshot == InvalidHandle) throw new System.ComponentModel.Win32Exception();
        try {
            var children = new Dictionary<uint, List<uint>>();
            var running = new HashSet<uint>();
            var entry = new ProcessEntry();
            entry.Size = (uint)Marshal.SizeOf(typeof(ProcessEntry));
            if (Process32FirstW(snapshot, ref entry)) {
                do {
                    running.Add(entry.ProcessId);
                    List<uint> values;
                    if (!children.TryGetValue(entry.ParentProcessId, out values)) {
                        values = new List<uint>();
                        children.Add(entry.ParentProcessId, values);
                    }
                    values.Add(entry.ProcessId);
                    entry.Size = (uint)Marshal.SizeOf(typeof(ProcessEntry));
                } while (Process32NextW(snapshot, ref entry));
            }

            var known = new List<uint>();
            foreach (string value in knownProcessIds.Split(',')) {
                uint processId;
                if (UInt32.TryParse(value, out processId)) known.Add(processId);
            }

            var found = new List<uint>();
            var visited = new HashSet<uint>();
            var queue = new Queue<uint>();
            queue.Enqueue((uint)rootProcessId);
            foreach (uint processId in known) queue.Enqueue(processId);
            while (queue.Count > 0) {
                uint parentProcessId = queue.Dequeue();
                if (!visited.Add(parentProcessId)) continue;
                List<uint> values;
                if (!children.TryGetValue(parentProcessId, out values)) continue;
                foreach (uint processId in values) {
                    if (!known.Contains(processId) && !found.Contains(processId))
                        found.Add(processId);
                    queue.Enqueue(processId);
                }
            }

            var knownRunning = new List<uint>();
            foreach (uint processId in known) {
                if (running.Contains(processId)) knownRunning.Add(processId);
            }
            return (running.Contains((uint)rootProcessId) ? "1" : "0") + "|" +
                string.Join(",", found) + "|" + string.Join(",", knownRunning);
        } finally {
            CloseHandle(snapshot);
        }
    }
}
`;

function windowsProcessTree(rootPid, known = [], onFailure) {
  const script = [
    `$source = @'${PROCESS_SNAPSHOT_SOURCE}'@`,
    'Add-Type -TypeDefinition $source',
    `[Console]::Out.Write([TestgenProcessTree]::Snapshot(${rootPid}, '${[
      ...known,
    ].join(',')}'))`,
  ].join('\n');
  const result = spawnSync(
    'powershell.exe',
    [
      '-NoLogo',
      '-NoProfile',
      '-NonInteractive',
      '-ExecutionPolicy',
      'Bypass',
      '-EncodedCommand',
      Buffer.from(script, 'utf16le').toString('base64'),
    ],
    { encoding: 'utf8', timeout: 10000, windowsHide: true },
  );
  if (result.error != null || result.status !== 0) {
    onFailure?.(
      result.error?.code === 'ETIMEDOUT'
        ? 'snapshot-timeout'
        : result.error != null
          ? 'snapshot-spawn-failed'
          : 'snapshot-command-failed',
    );
    return null;
  }
  const [root, descendantsText, knownText] = result.stdout.trim().split('|');
  const parseIds = (value) =>
    value === '' ? [] : value.split(',').map(Number).filter(Number.isInteger);
  if (
    !['0', '1'].includes(root) ||
    descendantsText == null ||
    knownText == null
  ) {
    onFailure?.('snapshot-invalid-output');
    return null;
  }
  return {
    root_exists: root === '1',
    descendants: parseIds(descendantsText),
    known_running: parseIds(knownText),
  };
}

module.exports = { windowsProcessTree };
