using System;
using System.ComponentModel;
using System.IO;
using System.IO.Pipes;
using System.Runtime.InteropServices;
using System.Security.Principal;
using System.Text;
using System.Threading;
using System.Threading.Tasks;
using Microsoft.Win32.SafeHandles;

internal static class TestgenWindowsJob
{
    private const uint KillOnJobClose = 0x2000;
    private const uint CreateNoWindow = 0x08000000;
    private const uint ExtendedStartupInfoPresent = 0x00080000;
    private const uint UseStdHandles = 0x100;
    private const int BasicAccounting = 1;
    private const int ExtendedLimits = 9;
    private const uint WaitTimeout = 258;

    [StructLayout(LayoutKind.Sequential)]
    private struct StartupInfo
    {
        public int Size;
        public IntPtr Reserved, Desktop, Title;
        public uint X, Y, XSize, YSize, XCount, YCount, Fill, Flags;
        public ushort ShowWindow, ReservedBytes;
        public IntPtr ReservedData, Input, Output, Error;
    }

    [StructLayout(LayoutKind.Sequential)]
    private struct StartupInfoEx
    {
        public StartupInfo Startup;
        public IntPtr Attributes;
    }

    [StructLayout(LayoutKind.Sequential)]
    private struct ProcessInfo
    {
        public IntPtr Process, Thread;
        public uint Pid, Tid;
    }

    [StructLayout(LayoutKind.Sequential)]
    private struct BasicLimits
    {
        public long PerProcessTime, PerJobTime;
        public uint Flags;
        public UIntPtr MinimumWorkingSet, MaximumWorkingSet;
        public uint ActiveProcessLimit;
        public UIntPtr Affinity;
        public uint PriorityClass, SchedulingClass;
    }

    [StructLayout(LayoutKind.Sequential)]
    private struct JobLimits
    {
        public BasicLimits Basic;
        public ulong ReadOperations, WriteOperations, OtherOperations;
        public ulong ReadBytes, WriteBytes, OtherBytes;
        public UIntPtr ProcessMemory, JobMemory, PeakProcessMemory, PeakJobMemory;
    }

    [StructLayout(LayoutKind.Sequential)]
    private struct JobAccounting
    {
        public long UserTime, KernelTime, PeriodUserTime, PeriodKernelTime;
        public uint PageFaults, TotalProcesses, ActiveProcesses, TerminatedProcesses;
    }

    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern SafeFileHandle CreateJobObjectW(IntPtr attributes, IntPtr name);

    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern bool SetInformationJobObject(
        SafeFileHandle job, int infoClass, ref JobLimits info, int size);

    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern bool QueryInformationJobObject(
        SafeFileHandle job, int infoClass, out JobAccounting info, int size, IntPtr returnLength);

    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern bool TerminateJobObject(SafeFileHandle job, uint exitCode);

    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern bool InitializeProcThreadAttributeList(
        IntPtr attributes, int count, int flags, ref IntPtr size);

    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern bool UpdateProcThreadAttribute(
        IntPtr attributes, uint flags, IntPtr attribute, IntPtr value, IntPtr size,
        IntPtr previous, IntPtr returnSize);

    [DllImport("kernel32.dll")]
    private static extern void DeleteProcThreadAttributeList(IntPtr attributes);

    [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
    private static extern bool CreateProcessW(
        string application, StringBuilder command, IntPtr processAttributes,
        IntPtr threadAttributes, bool inheritHandles, uint flags, IntPtr environment,
        string directory, ref StartupInfoEx startup, out ProcessInfo process);

    [DllImport("kernel32.dll")]
    private static extern IntPtr GetStdHandle(int handle);

    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern uint WaitForSingleObject(SafeFileHandle handle, uint milliseconds);

    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern bool GetExitCodeProcess(SafeFileHandle process, out uint exitCode);

    private static void Check(bool success)
    {
        if (!success) throw new Win32Exception();
    }

    private static void SetKillOnClose(SafeFileHandle job, bool enabled)
    {
        var limits = new JobLimits();
        limits.Basic.Flags = enabled ? KillOnJobClose : 0;
        Check(SetInformationJobObject(job, ExtendedLimits, ref limits, Marshal.SizeOf(limits)));
    }

    private static ProcessInfo Start(SafeFileHandle job, string command, IntPtr output, IntPtr error)
    {
        IntPtr size = IntPtr.Zero;
        InitializeProcThreadAttributeList(IntPtr.Zero, 1, 0, ref size);
        IntPtr attributes = Marshal.AllocHGlobal(checked(size.ToInt32() + IntPtr.Size));
        IntPtr jobValue = IntPtr.Add(attributes, size.ToInt32());
        bool initialized = false;
        try
        {
            Check(InitializeProcThreadAttributeList(attributes, 1, 0, ref size));
            initialized = true;
            Marshal.WriteIntPtr(jobValue, job.DangerousGetHandle());
            // PROC_THREAD_ATTRIBUTE_JOB_LIST assigns the child before it can run.
            Check(UpdateProcThreadAttribute(attributes, 0, (IntPtr)0x2000d,
                jobValue, (IntPtr)IntPtr.Size, IntPtr.Zero, IntPtr.Zero));

            var startup = new StartupInfoEx();
            startup.Startup.Size = Marshal.SizeOf(startup);
            startup.Startup.Flags = UseStdHandles;
            startup.Startup.Input = GetStdHandle(-10);
            startup.Startup.Output = output;
            startup.Startup.Error = error;
            startup.Attributes = attributes;
            ProcessInfo process;
            Check(CreateProcessW(null, new StringBuilder(command), IntPtr.Zero, IntPtr.Zero,
                true, ExtendedStartupInfoPresent | CreateNoWindow, IntPtr.Zero, null,
                ref startup, out process));
            GC.KeepAlive(job);
            return process;
        }
        finally
        {
            if (initialized) DeleteProcThreadAttributeList(attributes);
            Marshal.FreeHGlobal(attributes);
        }
    }

    private static void Stop(SafeFileHandle job)
    {
        Check(TerminateJobObject(job, 1));
        var deadline = System.Diagnostics.Stopwatch.StartNew();
        do
        {
            JobAccounting accounting;
            Check(QueryInformationJobObject(job, BasicAccounting, out accounting,
                Marshal.SizeOf(typeof(JobAccounting)), IntPtr.Zero));
            if (accounting.ActiveProcesses == 0) return;
            Thread.Sleep(20);
        } while (deadline.ElapsedMilliseconds < 4000);
        throw new Win32Exception(258);
    }

    private static NamedPipeClientStream OpenOutput(string name)
    {
        var pipe = new NamedPipeClientStream(".", name, PipeDirection.Out,
            PipeOptions.None, TokenImpersonationLevel.Identification, HandleInheritability.Inheritable);
        try
        {
            pipe.Connect(5000);
            return pipe;
        }
        catch
        {
            pipe.Dispose();
            throw;
        }
    }

    private static void Run(string name, StreamReader input, StreamWriter output, bool keepDescendants)
    {
        bool started = false;
        try
        {
            using (var job = CreateJobObjectW(IntPtr.Zero, IntPtr.Zero))
            using (var stdout = OpenOutput(name + "-out"))
            using (var stderr = OpenOutput(name + "-err"))
            {
                Check(!job.IsInvalid);
                SetKillOnClose(job, true);
                output.WriteLine("ready");
                string request = input.ReadLine();
                if (String.IsNullOrEmpty(request))
                {
                    output.WriteLine("exit 0");
                    return;
                }
                string command = Encoding.Unicode.GetString(Convert.FromBase64String(request));
                ProcessInfo info = Start(job, command, stdout.SafePipeHandle.DangerousGetHandle(),
                    stderr.SafePipeHandle.DangerousGetHandle());
                started = true;
                // Only the launched process and its descendants retain output handles.
                stdout.Dispose();
                stderr.Dispose();
                using (var process = new SafeFileHandle(info.Process, true))
                using (var thread = new SafeFileHandle(info.Thread, true))
                {
                    output.WriteLine("pid " + info.Pid);
                    // EOF also requests cleanup if the Node parent disappears.
                    var stop = Task.Factory.StartNew(() => input.ReadLine());
                    uint state;
                    do
                    {
                        state = WaitForSingleObject(process, 25);
                        if (state != WaitTimeout) Check(state == 0);
                    } while (state == WaitTimeout && !stop.IsCompleted);

                    uint status;
                    bool release = false;
                    if (state == 0 && keepDescendants && !stop.IsCompleted)
                    {
                        Check(GetExitCodeProcess(process, out status));
                        if (status == 0)
                        {
                            output.WriteLine("drain");
                            release = stop.GetAwaiter().GetResult() == "release";
                        }
                    }
                    if (release) SetKillOnClose(job, false);
                    else Stop(job);
                    Check(GetExitCodeProcess(process, out status));
                    output.WriteLine("exit " + status);
                }
            }
        }
        catch (Win32Exception error)
        {
            output.WriteLine((started ? "cleanup-error " : "spawn-error ") + error.NativeErrorCode);
        }
    }

    public static int Main(string[] args)
    {
        try
        {
            using (var pipe = new NamedPipeClientStream(".", args[0], PipeDirection.InOut,
                PipeOptions.Asynchronous))
            {
                pipe.Connect(5000);
                // The process owns the pipe. Disposing the reader could block on the stop read.
                var input = new StreamReader(pipe, Encoding.ASCII);
                var output = new StreamWriter(pipe, Encoding.ASCII) { AutoFlush = true };
                Run(args[0], input, output, args[1] == "keep");
            }
            return 0;
        }
        catch (Exception)
        {
            return 1;
        }
    }
}
