using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.IO;
using System.Runtime.InteropServices;
using System.Text.RegularExpressions;

internal static class Program
{
    private const uint JobObjectExtendedLimitInformation = 9;
    private const uint JobObjectLimitKillOnJobClose = 0x2000;

    private static IntPtr _jobHandle = IntPtr.Zero;
    private static string _temporaryConfig = "";

    [StructLayout(LayoutKind.Sequential)]
    private struct JobBasicLimitInformation
    {
        public long PerProcessUserTimeLimit;
        public long PerJobUserTimeLimit;
        public uint LimitFlags;
        public UIntPtr MinimumWorkingSetSize;
        public UIntPtr MaximumWorkingSetSize;
        public uint ActiveProcessLimit;
        public UIntPtr Affinity;
        public uint PriorityClass;
        public uint SchedulingClass;
    }

    [StructLayout(LayoutKind.Sequential)]
    private struct IoCounters
    {
        public ulong ReadOperationCount;
        public ulong WriteOperationCount;
        public ulong OtherOperationCount;
        public ulong ReadTransferCount;
        public ulong WriteTransferCount;
        public ulong OtherTransferCount;
    }

    [StructLayout(LayoutKind.Sequential)]
    private struct JobExtendedLimitInformation
    {
        public JobBasicLimitInformation BasicLimitInformation;
        public IoCounters IoInfo;
        public UIntPtr ProcessMemoryLimit;
        public UIntPtr JobMemoryLimit;
        public UIntPtr PeakProcessMemoryUsed;
        public UIntPtr PeakJobMemoryUsed;
    }

    [DllImport("kernel32.dll", CharSet = CharSet.Unicode)]
    private static extern IntPtr CreateJobObject(IntPtr securityAttributes, string name);

    [DllImport("kernel32.dll")]
    private static extern bool SetInformationJobObject(
        IntPtr job,
        uint infoClass,
        ref JobExtendedLimitInformation info,
        uint infoLength);

    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern bool AssignProcessToJobObject(IntPtr job, IntPtr process);

    [DllImport("kernel32.dll")]
    private static extern bool CloseHandle(IntPtr handle);

    private static int Main(string[] args)
    {
        try
        {
            string configPath = FindConfigPath(args);
            if (String.IsNullOrEmpty(configPath) || !File.Exists(configPath))
            {
                Console.Error.WriteLine("[frpc-compat] 找不到 frpc 配置：" + configPath);
                return 2;
            }

            string realBinary = Path.Combine(AppDomain.CurrentDomain.BaseDirectory, "88frpc-real.exe");
            if (!File.Exists(realBinary))
            {
                Console.Error.WriteLine("[frpc-compat] 找不到真实 frpc：" + realBinary);
                return 3;
            }

            string launchConfig = BuildCompatibleConfig(configPath);
            string launchArguments = ReplaceConfigArgument(args, configPath, launchConfig);

            ProcessStartInfo startInfo = new ProcessStartInfo(realBinary, launchArguments);
            startInfo.UseShellExecute = false;
            startInfo.CreateNoWindow = true;
            startInfo.RedirectStandardOutput = true;
            startInfo.RedirectStandardError = true;
            startInfo.WorkingDirectory = AppDomain.CurrentDomain.BaseDirectory;

            using (Process child = new Process())
            {
                child.StartInfo = startInfo;
                child.OutputDataReceived += delegate(object sender, DataReceivedEventArgs eventArgs)
                {
                    if (eventArgs.Data != null) Console.Out.WriteLine(eventArgs.Data);
                };
                child.ErrorDataReceived += delegate(object sender, DataReceivedEventArgs eventArgs)
                {
                    if (eventArgs.Data != null) Console.Error.WriteLine(eventArgs.Data);
                };
                child.Start();
                AttachToKillOnCloseJob(child);
                child.BeginOutputReadLine();
                child.BeginErrorReadLine();
                child.WaitForExit();
                return child.ExitCode;
            }
        }
        catch (Exception error)
        {
            Console.Error.WriteLine("[frpc-compat] " + error);
            return 1;
        }
        finally
        {
            Cleanup();
        }
    }

    private static string FindConfigPath(string[] args)
    {
        for (int index = 0; index < args.Length; index++)
        {
            if (args[index] == "-c" && index + 1 < args.Length) return args[index + 1];
            if (args[index].StartsWith("-c=", StringComparison.OrdinalIgnoreCase)) return args[index].Substring(3);
        }
        return "";
    }

    private static string ReplaceConfigArgument(string[] args, string oldPath, string newPath)
    {
        List<string> output = new List<string>();
        for (int index = 0; index < args.Length; index++)
        {
            if (args[index] == "-c" && index + 1 < args.Length)
            {
                output.Add("-c");
                output.Add(QuoteArgument(newPath));
                index++;
                continue;
            }
            if (args[index].StartsWith("-c=", StringComparison.OrdinalIgnoreCase))
            {
                output.Add("-c=" + QuoteArgument(newPath));
                continue;
            }
            output.Add(QuoteArgument(args[index]));
        }
        return String.Join(" ", output.ToArray());
    }

    private static string QuoteArgument(string value)
    {
        if (!String.IsNullOrEmpty(value) && value.IndexOfAny(new[] { ' ', '\t', '"' }) < 0) return value;
        return "\"" + value.Replace("\"", "\\\"") + "\"";
    }

    private static string BuildCompatibleConfig(string configPath)
    {
        string original = File.ReadAllText(configPath);
        Dictionary<string, string> names = ReadTunnelNames(configPath);
        if (names.Count == 0) return configPath;

        bool changed = false;
        string rewritten = Regex.Replace(
            original,
            @"(?ms)^\s*\[\[proxies\]\]\s*\r?\n(.*?)(?=^\s*\[\[proxies\]\]\s*$|\z)",
            delegate(Match match)
            {
                string block = match.Value;
                string localPort = ReadIntField(block, "localPort");
                string remotePort = ReadIntField(block, "remotePort");
                string resolved;
                if (!names.TryGetValue(localPort + ":" + remotePort, out resolved)
                    && !names.TryGetValue("remote:" + remotePort, out resolved))
                {
                    return block;
                }

                string replaced = Regex.Replace(
                    block,
                    @"(?m)^(\s*name\s*=\s*)(""[^""]*""|'[^']*'|[^\s#]+)",
                    "${1}\"" + resolved + "\"");
                if (replaced != block) changed = true;
                return replaced;
            });

        if (!changed) return configPath;

        _temporaryConfig = Path.Combine(
            AppDomain.CurrentDomain.BaseDirectory,
            "frpc.compat." + Process.GetCurrentProcess().Id + ".toml");
        File.WriteAllText(_temporaryConfig, rewritten);
        Console.Error.WriteLine("[frpc-compat] 已将网关占位隧道名替换为 88FRP 真实名称");
        return _temporaryConfig;
    }

    private static Dictionary<string, string> ReadTunnelNames(string gatewayConfigPath)
    {
        Dictionary<string, string> result = new Dictionary<string, string>(StringComparer.OrdinalIgnoreCase);
        try
        {
            DirectoryInfo gatewayDirectory = Directory.GetParent(Path.GetDirectoryName(gatewayConfigPath));
            if (gatewayDirectory == null) return result;
            string instancesDirectory = Path.Combine(gatewayDirectory.FullName, "instances");
            if (!Directory.Exists(instancesDirectory)) return result;

            foreach (string instanceConfig in Directory.GetFiles(instancesDirectory, "frpc.toml", SearchOption.AllDirectories))
            {
                string text = File.ReadAllText(instanceConfig);
                foreach (Match match in Regex.Matches(
                    text,
                    @"(?ms)^\s*\[\[proxies\]\]\s*\r?\n(.*?)(?=^\s*\[\[proxies\]\]\s*$|\z)"))
                {
                    string block = match.Value;
                    string name = ReadStringField(block, "name");
                    string localPort = ReadIntField(block, "localPort");
                    string remotePort = ReadIntField(block, "remotePort");
                    if (String.IsNullOrEmpty(name) || String.IsNullOrEmpty(remotePort)) continue;
                    result[localPort + ":" + remotePort] = name;
                    if (!result.ContainsKey("remote:" + remotePort)) result["remote:" + remotePort] = name;
                }
            }
        }
        catch (Exception error)
        {
            Console.Error.WriteLine("[frpc-compat] 读取真实隧道名失败：" + error.Message);
        }
        return result;
    }

    private static string ReadStringField(string block, string field)
    {
        Match match = Regex.Match(
            block,
            @"(?m)^\s*" + Regex.Escape(field) + @"\s*=\s*(?:""([^""]*)""|'([^']*)'|([^\s#]+))");
        if (!match.Success) return "";
        if (match.Groups[1].Success) return match.Groups[1].Value.Trim();
        if (match.Groups[2].Success) return match.Groups[2].Value.Trim();
        return match.Groups[3].Value.Trim();
    }

    private static string ReadIntField(string block, string field)
    {
        string value = ReadStringField(block, field);
        int parsed;
        return Int32.TryParse(value, out parsed) ? parsed.ToString() : "";
    }

    private static void AttachToKillOnCloseJob(Process child)
    {
        try
        {
            _jobHandle = CreateJobObject(IntPtr.Zero, null);
            if (_jobHandle == IntPtr.Zero) return;

            JobExtendedLimitInformation info = new JobExtendedLimitInformation();
            info.BasicLimitInformation.LimitFlags = JobObjectLimitKillOnJobClose;
            if (!SetInformationJobObject(
                _jobHandle,
                JobObjectExtendedLimitInformation,
                ref info,
                (uint)Marshal.SizeOf(typeof(JobExtendedLimitInformation))))
            {
                CloseHandle(_jobHandle);
                _jobHandle = IntPtr.Zero;
                return;
            }

            if (!AssignProcessToJobObject(_jobHandle, child.Handle))
            {
                CloseHandle(_jobHandle);
                _jobHandle = IntPtr.Zero;
            }
        }
        catch
        {
            if (_jobHandle != IntPtr.Zero)
            {
                CloseHandle(_jobHandle);
                _jobHandle = IntPtr.Zero;
            }
        }
    }

    private static void Cleanup()
    {
        if (!String.IsNullOrEmpty(_temporaryConfig))
        {
            try { File.Delete(_temporaryConfig); } catch { }
        }
        if (_jobHandle != IntPtr.Zero)
        {
            CloseHandle(_jobHandle);
            _jobHandle = IntPtr.Zero;
        }
    }
}
