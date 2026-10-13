# Windows helper for lib/exec.mjs runShell: runs $env:FF_CMD in a job object so every descendant, including
# orphans, is killed together. Control: a byte on stdin (or stdin EOF) terminates the job. Exit code: the command's.
# Diagnostics go to stderr as lines prefixed with \x01FFJOB so exec.mjs can strip and parse them.
Add-Type -TypeDefinition @'
using System;
using System.Collections.Generic;
using System.Runtime.InteropServices;
using System.Threading;

public static class FFJob {
  [StructLayout(LayoutKind.Sequential)] struct SA { public int n; public IntPtr d; public int inherit; }
  [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)] struct SI { public int cb; public string r, desk, title; public int x, y, xs, ys, xc, yc, fill, flags; public short show, r2; public IntPtr r2p, hin, hout, herr; }
  [StructLayout(LayoutKind.Sequential)] struct PI { public IntPtr hp, ht; public int pid, tid; }
  [StructLayout(LayoutKind.Sequential)] struct BASIC { public long a, b; public uint flags; public UIntPtr minws, maxws; public uint active; public UIntPtr aff; public uint prio, sched; }
  [StructLayout(LayoutKind.Sequential)] struct IOC { public ulong a, b, c, d, e, f; }
  [StructLayout(LayoutKind.Sequential)] struct EXT { public BASIC basic; public IOC io; public UIntPtr pm, jm, peak, jpeak; }

  [DllImport("kernel32.dll", SetLastError = true)] static extern IntPtr CreateJobObject(IntPtr a, string n);
  [DllImport("kernel32.dll", SetLastError = true)] static extern bool SetInformationJobObject(IntPtr j, int c, ref EXT i, int len);
  [DllImport("kernel32.dll", SetLastError = true)] static extern bool QueryInformationJobObject(IntPtr j, int c, IntPtr i, int len, IntPtr ret);
  [DllImport("kernel32.dll", SetLastError = true)] static extern bool AssignProcessToJobObject(IntPtr j, IntPtr p);
  [DllImport("kernel32.dll", SetLastError = true)] static extern bool TerminateJobObject(IntPtr j, uint code);
  [DllImport("kernel32.dll", SetLastError = true, CharSet = CharSet.Unicode)] static extern bool CreateProcess(string app, string cmd, IntPtr pa, IntPtr ta, bool inherit, uint flags, IntPtr env, string cwd, ref SI si, out PI pi);
  [DllImport("kernel32.dll", SetLastError = true, CharSet = CharSet.Unicode)] static extern IntPtr CreateFile(string f, uint access, uint share, ref SA sa, uint disp, uint attrs, IntPtr t);
  [DllImport("kernel32.dll")] static extern IntPtr GetStdHandle(int h);
  [DllImport("kernel32.dll", SetLastError = true)] static extern bool SetHandleInformation(IntPtr h, uint mask, uint flags);
  [DllImport("kernel32.dll", SetLastError = true)] static extern uint ResumeThread(IntPtr t);
  [DllImport("kernel32.dll", SetLastError = true)] static extern bool TerminateProcess(IntPtr p, uint code);
  [DllImport("kernel32.dll")] static extern uint WaitForSingleObject(IntPtr h, uint ms);
  [DllImport("kernel32.dll")] static extern bool GetExitCodeProcess(IntPtr p, out uint code);
  [DllImport("kernel32.dll")] static extern bool CloseHandle(IntPtr h);

  static void Note(string s) { Console.Error.Write("\n\u0001FFJOB " + s + "\n"); Console.Error.Flush(); }

  static List<int> Members(IntPtr job) {
    var l = new List<int>();
    int size = 8 + 8 * 512;
    IntPtr buf = Marshal.AllocHGlobal(size);
    try {
      if (QueryInformationJobObject(job, 3, buf, size, IntPtr.Zero)) {
        int n = Marshal.ReadInt32(buf, 4);
        for (int i = 0; i < n; i++) l.Add((int)(long)Marshal.ReadIntPtr(buf, 8 + i * IntPtr.Size));
      }
    } finally { Marshal.FreeHGlobal(buf); }
    return l;
  }

  // deny: test seam, leave the job (and its processes) running and report them as survivors.
  public static int Run(string cmdline, string cwd, bool deny) {
    IntPtr job = CreateJobObject(IntPtr.Zero, null);
    var ext = new EXT();
    if (!deny) ext.basic.flags = 0x2000; // KILL_ON_JOB_CLOSE
    bool jobOk = job != IntPtr.Zero && SetInformationJobObject(job, 9, ref ext, Marshal.SizeOf(typeof(EXT)));
    if (!jobOk) Note("nojob " + Marshal.GetLastWin32Error());

    // the control pipe must not leak into the command or its descendants, or ff would never see EOF/close
    SetHandleInformation(GetStdHandle(-10), 1, 0);
    var sa = new SA(); sa.n = Marshal.SizeOf(typeof(SA)); sa.inherit = 1;
    IntPtr nul = CreateFile("NUL", 0x80000000, 3, ref sa, 3, 0, IntPtr.Zero);
    var si = new SI(); si.cb = Marshal.SizeOf(typeof(SI)); si.flags = 0x100; // USESTDHANDLES: stdin is NUL, not our control pipe
    si.hin = nul; si.hout = GetStdHandle(-11); si.herr = GetStdHandle(-12);
    PI pi;
    // SUSPENDED so the process cannot spawn anything before it is in the job; BREAKAWAY is not requested.
    if (!CreateProcess(null, cmdline, IntPtr.Zero, IntPtr.Zero, true, 0x4 | 0x08000000, IntPtr.Zero, cwd, ref si, out pi)) {
      Note("fail " + Marshal.GetLastWin32Error());
      return 127;
    }
    if (jobOk && !AssignProcessToJobObject(job, pi.hp)) { Note("noassign " + Marshal.GetLastWin32Error()); jobOk = false; }
    ResumeThread(pi.ht);
    Note("started " + pi.pid);

    bool kill = false;
    var reader = new Thread(() => { try { Console.OpenStandardInput().ReadByte(); } catch { } kill = true; }) { IsBackground = true };
    reader.Start();
    while (!kill && WaitForSingleObject(pi.hp, 50) != 0) { }
    if (!kill) {
      // finished on its own: like a plain spawn, leave any background leftovers running
      if (jobOk) { var keep = new EXT(); SetInformationJobObject(job, 9, ref keep, Marshal.SizeOf(typeof(EXT))); }
      uint code; GetExitCodeProcess(pi.hp, out code); return (int)code;
    }

    if (!deny) { if (jobOk) TerminateJobObject(job, 1); else TerminateProcess(pi.hp, 1); }
    var left = new List<int>();
    for (int i = 0; i < 20; i++) {
      left = jobOk ? Members(job) : (WaitForSingleObject(pi.hp, 0) == 0 ? new List<int>() : new List<int> { pi.pid });
      if (left.Count == 0) break;
      Thread.Sleep(50);
    }
    Note("survivors " + string.Join(",", left));
    return 98;
  }
}
'@
exit [FFJob]::Run($env:FF_CMD, $(if ($env:FF_CWD) { $env:FF_CWD }), $env:FF_DENY -eq '1')
